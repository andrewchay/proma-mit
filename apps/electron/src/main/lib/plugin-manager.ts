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
interface BuiltinPluginRuntime {
  manifest: PluginManifest
  /** 当前是否启用（联动插件自身 config） */
  isEnabled: () => boolean
  /** 启用/停用（联动插件自身能力） */
  setEnabled: (enabled: boolean) => Promise<boolean>
  /** 是否支持当前平台 */
  isSupported: () => boolean
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
  runtime?: { isEnabled?: () => boolean; setEnabled?: (enabled: boolean) => Promise<boolean>; isSupported?: () => boolean },
): boolean {
  const manifest = sanitizePluginManifest(rawManifest)
  if (!manifest) { console.warn(`[Diag][plugin] 拒绝注册：manifest 非法/缺 id/name`); return false }
  if (BUILTIN_RUNTIMES.has(manifest.id) || IMPORTED_RUNTIMES.has(manifest.id)) { console.warn(`[Diag][plugin] 拒绝注册：id 已存在 ${manifest.id}`); return false }
  IMPORTED_RUNTIMES.set(manifest.id, () => ({
    manifest,
    isEnabled: runtime?.isEnabled ?? (() => enabledFlag.get(manifest.id) ?? true),
    setEnabled: runtime?.setEnabled ?? (async (enabled) => { enabledFlag.set(manifest.id, enabled); return true }),
    isSupported: runtime?.isSupported ?? (() => true),
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
