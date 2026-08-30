/**
 * PluginManager — 扩展（Extension）管理器（P1-2a）。
 *
 * 第一版仅管理第一方内置插件（以灵动岛为样板），提供：
 * - listPluginStates：返回所有内置插件状态（含启停/运行状态/权限摘要）
 * - setPluginEnabled：启用/停用（联动插件自身能力，如灵动岛开关）
 *
 * 设计原则：
 * - 第三方插件不在此版本开放（P2 后）；
 * - 权限采用声明式（manifest 声明 + 用户确认快照）；
 * - 插件状态不写入宿主 settings，由各插件自己的 config 管理（配置隔离）。
 */

import { BUILTIN_PLUGINS } from '@gravitas/shared'
import type { PluginLifecycleState, PluginManifest, PluginPermissions, PluginSurfaceType, PluginSubscription } from '@gravitas/shared'
import type { RuntimeToolDefinition } from './agent-runtime/types'

/** 插件运行状态（面向设置 UI） */
export interface PluginStateView {
  id: string
  name: string
  version: string
  description?: string
  publisher: string
  /** 是否支持当前平台 */
  supported: boolean
  /** 生命周期状态 */
  state: PluginLifecycleState
  /** 是否启用（用户视角） */
  enabled: boolean
  surfaces: PluginSurfaceType[]
  subscriptions: PluginSubscription[]
  /** 权限摘要（声明式，UI 只读展示） */
  permissions: PluginPermissions
  /** 来源：内置 bundled / 第三方导入 local（UI 据此是否显示“删除”） */
  source: 'bundled' | 'local'
  /** 最近错误信息 */
  error?: string
}

/** 内置插件运行时描述（manifest + 能力句柄） */
export interface BuiltinPluginRuntime {
  manifest: PluginManifest
  /** 当前是否启用（联动插件自身 config） */
  isEnabled: () => boolean
  /** 启用/停用（联动插件自身能力） */
  setEnabled: (enabled: boolean) => Promise<boolean>
  /** 是否支持当前平台 */
  isSupported: () => boolean
  /**
   * 声明式向 Agent 贡献工具（surface: 'agent-tools'）。
   * 由主进程安全代码以闭包形式提供，避免第三方插件直接加载任意 JS 注入主进程。
   * 未提供则视为不贡献工具。
   */
  contributeTools?: () => RuntimeToolDefinition[]
  /**
   * 声明式向 Agent 贡献系统提示片段（模型调用能力引导，如「营销工具何时使用」）。
   * 与 contributeTools 对称；返回的每段文本会作为独立 section 注入系统提示。
   * 未提供则视为不贡献。
   */
  contributePrompts?: () => string[]
}

// ===== 内置插件注册表 =====

/** 灵动岛插件运行时（联动 dynamic-island-service） */
function dynamicIslandRuntime(): BuiltinPluginRuntime {
  const manifest: PluginManifest = {
    schemaVersion: 1,
    id: 'com.gravitas.dynamic-island',
    version: '1.0.0',
    name: '灵动岛通知',
    description: '在 macOS 刘海下方显示 Agent 任务状态、审批提醒与完成通知',
    publisher: 'Proma',
    platforms: ['darwin'],
    activationEvents: ['onAppReady'],
    subscriptions: ['app.started', 'app.progress', 'app.waiting_action', 'app.completed', 'app.failed'],
    surfaces: ['overlay', 'settings'],
    permissions: {
      events: true,
      overlay: true,
      openSession: true,
    },
    entrypoints: {},
  }
  return {
    manifest,
    isEnabled: () => {
      try {
        // 延迟 require 避免循环依赖
        const { isDynamicIslandPrimary } = require('./dynamic-island/dynamic-island-service') as { isDynamicIslandPrimary: () => boolean }
        return isDynamicIslandPrimary()
      } catch {
        return false
      }
    },
    setEnabled: async (enabled) => {
      try {
        const { getDynamicIslandService } = require('./dynamic-island/dynamic-island-service') as { getDynamicIslandService: () => { setEnabled: (enabled: boolean) => Promise<unknown> } }
        await getDynamicIslandService().setEnabled(enabled)
        return true
      } catch {
        return false
      }
    },
    isSupported: () => process.platform === 'darwin',
  }
}

/** 内置插件注册表（按 id） */
const BUILTIN_RUNTIMES = new Map<string, () => BuiltinPluginRuntime>([
  ['com.gravitas.dynamic-island', dynamicIslandRuntime],
  // Computer Use 插件：把系统级桌面控制工具以「插件贡献 agent-tools」方式提供
  ['com.gravitas.computer-use', () => require('./plugins/computer-use-plugin').computerUsePluginRuntime()],
  // Marketing 插件：把营销领域工具以「插件贡献 agent-tools」方式提供（试点）
  ['com.gravitas.marketing', () => require('./plugins/marketing-plugin').marketingPluginRuntime()],
])

/** 安全的字符串字段取值（仅接受 mini 长度以下的用户可控字符串） */
const MANIFEST_TEXT_LIMIT = 200

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 规整第三方 manifest：强制类型、限长、把关键数组字段归一化为数组，非法结构返回 false。 */
function sanitizePluginManifest(raw: unknown): PluginManifest | null {
  if (!isPlainObj(raw)) return null
  const r = raw as Record<string, unknown>
  const id = r.id
  const name = r.name
  // id/name 必须是短字符串（name 不应为空展示）
  if (typeof id !== 'string' || !id || id.length > MANIFEST_TEXT_LIMIT) return null
  if (typeof name !== 'string' || !name.trim()) return null

  const manifest = {
    ...(r as unknown as PluginManifest),
    id,
    name: name.slice(0, MANIFEST_TEXT_LIMIT),
    version: typeof r.version === 'string' ? r.version.slice(0, 50) : '0.0.0',
    description: typeof r.description === 'string' ? r.description.slice(0, 2000) : '',
    publisher: typeof r.publisher === 'string' ? r.publisher.slice(0, 200) : '',
    // surfaces / subscriptions / platforms 规整为字符串数组，避免渲染层对非数组 `.map` 抛错
    surfaces: Array.isArray(r.surfaces) ? r.surfaces.filter((s): s is string => typeof s === 'string').slice(0, 32) : [],
    subscriptions: Array.isArray(r.subscriptions) ? r.subscriptions.filter((s): s is string => typeof s === 'string').slice(0, 32) : [],
    platforms: Array.isArray(r.platforms) ? r.platforms.filter((s): s is string => typeof s === 'string').slice(0, 16) : [],
    permissions: isPlainObj(r.permissions) ? (r.permissions as unknown as PluginManifest['permissions']) : {},
    entrypoints: isPlainObj(r.entrypoints) ? (r.entrypoints as unknown as PluginManifest['entrypoints']) : {},
  } as unknown as PluginManifest
  return manifest
}

/**
 * PH2-F：导入/注册一个第三方插件（SDK 开放）。
 * 提供 manifest + 启停句柄；未提供句柄时默认启用态写入内存（无持久能力）。
 * 平台不支持的插件仍可注册，但扩展中心会标记「不支持」。
 */
export function registerPlugin(
  rawManifest: unknown,
  runtime?: { isEnabled?: () => boolean; setEnabled?: (enabled: boolean) => Promise<boolean>; isSupported?: () => boolean; contributeTools?: () => RuntimeToolDefinition[] },
): boolean {
  const manifest = sanitizePluginManifest(rawManifest)
  if (!manifest) { console.warn(`[Diag][plugin] 拒绝注册：manifest 非法/缺 id/name`); return false }
  if (BUILTIN_RUNTIMES.has(manifest.id) || IMPORTED_RUNTIMES.has(manifest.id)) { console.warn(`[Diag][plugin] 拒绝注册：id 已存在 ${manifest.id}`); return false }
  IMPORTED_RUNTIMES.set(manifest.id, () => ({
    manifest,
    isEnabled: runtime?.isEnabled ?? (() => enabledFlag.get(manifest.id) ?? true),
    setEnabled: runtime?.setEnabled ?? (async (enabled) => { enabledFlag.set(manifest.id, enabled); return true }),
    isSupported: runtime?.isSupported ?? (() => true),
    contributeTools: runtime?.contributeTools,
  }))
  return true
}

/**
 * 卸载第三方插件（仅 IMPORTED，内置插件不可删）。
 * PH2-F：扩展中心「删除」入口。
 */
export function removePlugin(pluginId: string): boolean {
  if (!IMPORTED_RUNTIMES.has(pluginId)) return false
  IMPORTED_RUNTIMES.delete(pluginId)
  enabledFlag.delete(pluginId)
  console.log(`[Diag][plugin] 已卸载第三方插件 ${pluginId}`)
  return true
}

/** 按 manifest 注册（供 IPC/SDK 便捷导入，不覆盖内置）。空/非法 manifest 安全返回 false。 */
export function importPluginFromManifest(manifest: unknown): boolean {
  return registerPlugin(manifest)
}

/** 第三方导入插件注册表 */
const IMPORTED_RUNTIMES = new Map<string, () => BuiltinPluginRuntime>()
/** 简单启停标记（无能力句柄时用） */
const enabledFlag = new Map<string, boolean>()

// ===== 对外 API =====

/** 列出所有内置插件状态 */
export function listPluginStates(): PluginStateView[] {
  const views: PluginStateView[] = []
  for (const entry of BUILTIN_PLUGINS) {
    const runtimeFactory = BUILTIN_RUNTIMES.get(entry.id)
    if (!runtimeFactory) continue
    views.push(runtimeToView(entry.id, runtimeFactory(), 'bundled'))
  }
  // PH2-F：第三方导入插件
  for (const [id, factory] of IMPORTED_RUNTIMES) {
    views.push(runtimeToView(id, factory(), 'local'))
  }
  return views
}

function runtimeToView(id: string, runtime: BuiltinPluginRuntime, source: 'bundled' | 'local' = 'bundled'): PluginStateView {
  const enabled = runtime.isEnabled()
  return {
    id,
    name: runtime.manifest.name,
    version: runtime.manifest.version,
    description: runtime.manifest.description,
    publisher: runtime.manifest.publisher,
    supported: runtime.isSupported(),
    state: enabled ? 'enabled' : 'disabled',
    enabled,
    surfaces: runtime.manifest.surfaces,
    subscriptions: runtime.manifest.subscriptions,
    permissions: runtime.manifest.permissions,
    source,
  }
}

/** 启用/停用插件 */
export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginStateView | null> {
  let runtimeFactory = BUILTIN_RUNTIMES.get(pluginId)
  if (!runtimeFactory) runtimeFactory = IMPORTED_RUNTIMES.get(pluginId)
  if (!runtimeFactory) return null
  const runtime = runtimeFactory()
  const ok = await runtime.setEnabled(enabled)
  if (!ok) return null
  const views = listPluginStates()
  return views.find((v) => v.id === pluginId) ?? null
}

import { collectDirectoryTools, collectDirectoryToolPrompts } from './tool-definition-store'
/** 目录名与内置插件 runtime ID 的稳定映射；未知目录不得绕过插件启用状态。 */
const DIRECTORY_TOOLSET_RUNTIME_IDS: Record<string, string> = {
  marketing: 'com.gravitas.marketing',
  'computer-use': 'com.gravitas.computer-use',
}

function isDirectoryToolsetEnabled(directoryId: string): boolean {
  const runtimeId = DIRECTORY_TOOLSET_RUNTIME_IDS[directoryId]
  if (!runtimeId) return false
  const factory = BUILTIN_RUNTIMES.get(runtimeId) ?? IMPORTED_RUNTIMES.get(runtimeId)
  if (!factory) return false
  const runtime = factory()
  return runtime.isEnabled() && runtime.isSupported()
}


// ... existing code ...

/**
 * 收集所有「已启用 + 平台支持 且 贡献了 agent-tools」的插件工具。
 *
 * 供 Agent 编排器在构建工具集时汇入 `extraTools`。遵循声明式安全边界：
 * - 仅调用插件自身的 contributeTools 闭包（内置插件安全代码或第三方受管句柄）；
 * - 未启用 / 平台不支持 / 未贡献工具 的插件直接跳过；
 * - 空结果返回空数组（无副作用）。
 */
export function collectContributingTools(): RuntimeToolDefinition[] {
  const tools: RuntimeToolDefinition[] = []

  // ★ Phase 1: 优先收集目录化工具
  try {
    const directoryTools = collectDirectoryTools(isDirectoryToolsetEnabled)
    tools.push(...directoryTools)
  } catch (error) {
    console.warn('[PluginManager] 收集目录化工具失败:', error)
  }

  // Phase 2: 收集代码硬编码工具（向后兼容，去重）
  const factories: Array<{ id: string; factory: () => BuiltinPluginRuntime }> = []
  for (const [id, factory] of BUILTIN_RUNTIMES) factories.push({ id, factory })
  for (const [id, factory] of IMPORTED_RUNTIMES) factories.push({ id, factory })

  for (const { id, factory } of factories) {
    try {
      const runtime = factory()
      if (!runtime.isEnabled() || !runtime.isSupported()) continue
      const contributed = runtime.contributeTools?.()
      if (contributed) {
        // 去重：目录化工具已存在时跳过代码版本
        for (const tool of contributed) {
          if (!tools.some((t) => t.name === tool.name)) {
            tools.push(tool)
          }
        }
      }
    } catch (error) {
      console.warn(`[Diag][plugin] 收集 ${id} 的工具失败：`, error)
    }
  }
  return tools
}

/**
 * 收集所有「已启用 + 平台支持 且 贡献了提示片段」的插件系统提示。
 *
 * 与 collectContributingTools 对称：供 buildSystemPrompt 在组装系统提示时注入插件能力引导。
 * 同遵循声明式安全边界，空结果返回空数组。
 */
export function collectContributingPrompts(): string[] {
  const prompts: string[] = []

  // ★ Phase 1: 优先收集目录化工具提示
  try {
    const directoryPrompts = collectDirectoryToolPrompts((directoryId) => directoryId !== 'marketing' && isDirectoryToolsetEnabled(directoryId))
    prompts.push(...directoryPrompts)
  } catch (error) {
    console.warn('[PluginManager] 收集目录化工具提示失败:', error)
  }

  // Phase 2: 收集代码硬编码提示（向后兼容）
  const factories: Array<{ id: string; factory: () => BuiltinPluginRuntime }> = []
  for (const [id, factory] of BUILTIN_RUNTIMES) factories.push({ id, factory })
  for (const [id, factory] of IMPORTED_RUNTIMES) factories.push({ id, factory })

  for (const { id, factory } of factories) {
    try {
      const runtime = factory()
      if (!runtime.isEnabled() || !runtime.isSupported()) continue
      const contributed = runtime.contributePrompts?.()
      if (contributed) prompts.push(...contributed)
    } catch (error) {
      console.warn(`[Diag][plugin] 收集 ${id} 的提示失败：`, error)
    }
  }
  return prompts
}

/** 重置插件管理器内部状态（仅测试用，避免跨用例污染全局注册表）。 */
export function _resetPluginManagerForTests(): void {
  IMPORTED_RUNTIMES.clear()
  enabledFlag.clear()
}
