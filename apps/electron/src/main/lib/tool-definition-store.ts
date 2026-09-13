/**
 * 工具即目录 —— 插件工具定义存储与加载。
 *
 * 工具从代码常量外化为目录：
 *   ~/.gravitas/default-tools/<plugin-id>/<domain>/<tool-id>/
 *     ├── tool.json          # 稳定层：name/description/parameters
 *     └── execute.ts         # 执行逻辑（或引用代码实现）
 *
 * 本模块：读取目录 → 合并成 RuntimeToolDefinition；目录缺失时回退代码默认。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeToolDefinition } from './agent-runtime/types'
import type { ToolDefinition } from '@gravitas/core'
import { getDefaultToolsUserDir, parseToolDirVersion } from './config-paths'
import { readJsonFileSafe } from './safe-file'
import { getBundledMarketingExecutor } from './bundled-marketing-executors'
import { getBundledOutboundExecutor } from './bundled-outbound-executors'

// =====================================================================
// 类型定义
// =====================================================================

/** 单个工具的目录状态 */
export interface ToolDirState {
  id: string
  name: string
  description: string
  domain: string
  parameters: ToolDefinition['parameters']
  /** execute.ts 的绝对路径；若缺失则从代码默认加载 */
  executePath?: string
}

/** 插件工具集的目录状态 */
export interface PluginToolsDirState {
  pluginId: string
  version: number
  domains: string[]
  tools: ToolDirState[]
  /** TOOLS.md 正文（工具行为定义） */
  toolsMd?: string
}

/** tool.json 的目录布局 */
interface ToolConfigFile {
  id?: string
  name?: string
  description?: string
  domain?: string
  parameters?: unknown
}

// =====================================================================
// 目录读取
// =====================================================================

/**
 * 读取某个插件的工具集目录状态。
 * 遍历 <plugin-id>/<domain>/<tool-id>/ 下的所有工具。
 */
export function readPluginToolsDirState(pluginId: string): PluginToolsDirState | null {
  const pluginDir = join(getDefaultToolsUserDir(), pluginId)
  if (!existsSync(pluginDir)) return null

  const configPath = join(pluginDir, 'system_config.json')
  const toolsMdPath = join(pluginDir, 'TOOLS.md')

  const cfg = existsSync(configPath)
    ? readJsonFileSafe<{ version?: unknown; domains?: unknown }>(configPath)
    : null

  const version = parseToolDirVersion(pluginDir)
  const domains = Array.isArray(cfg?.domains)
    ? (cfg.domains as unknown[]).filter((d): d is string => typeof d === 'string')
    : []

  // 遍历所有领域目录下的工具
  const tools: ToolDirState[] = []
  for (const domain of domains) {
    const domainDir = join(pluginDir, domain)
    if (!existsSync(domainDir)) continue

    const toolDirs = readDirNames(domainDir)
    for (const toolId of toolDirs) {
      const toolState = readToolDirState(pluginDir, domain, toolId)
      if (toolState) tools.push(toolState)
    }
  }

  let toolsMd: string | undefined
  if (existsSync(toolsMdPath)) {
    try {
      toolsMd = readFileSync(toolsMdPath, 'utf-8').trim()
    } catch {
      toolsMd = undefined
    }
  }

  return {
    pluginId,
    version,
    domains,
    tools,
    toolsMd,
  }
}

/** 读取单个工具的目录状态 */
function readToolDirState(
  pluginDir: string,
  domain: string,
  toolId: string,
): ToolDirState | null {
  const toolDir = join(pluginDir, domain, toolId)
  const configPath = join(toolDir, 'tool.json')
  if (!existsSync(configPath)) return null

  const cfg = readJsonFileSafe<ToolConfigFile>(configPath)
  if (!cfg) return null

  const executePath = join(toolDir, 'execute.ts')

  return {
    id: cfg.id || toolId,
    name: typeof cfg.name === 'string' ? cfg.name : toolId,
    description: typeof cfg.description === 'string' ? cfg.description : '',
    domain: cfg.domain || domain,
    parameters: isValidParameters(cfg.parameters) ? cfg.parameters : { type: 'object', properties: {} },
    executePath: existsSync(executePath) ? executePath : undefined,
  }
}

// =====================================================================
// 工具收集
// =====================================================================

/**
 * 收集所有已启用插件的目录化工具定义。
 * 与 plugin-manager.collectContributingTools() 协作：
 * - 目录化工具优先
 * - 代码默认兜底
 */
export type DirectoryToolsetFilter = (pluginId: string, domain?: string) => boolean

export function collectDirectoryTools(shouldInclude?: DirectoryToolsetFilter): RuntimeToolDefinition[] {
  const tools: RuntimeToolDefinition[] = []
  const toolsDir = getDefaultToolsUserDir()
  if (!existsSync(toolsDir)) return tools

  const pluginDirs = readDirNames(toolsDir)
  for (const pluginId of pluginDirs) {
    const state = readPluginToolsDirState(pluginId)
    if (!state) continue

    for (const toolState of state.tools) {
    if (shouldInclude && !shouldInclude(pluginId, toolState.domain)) continue
      try {
        const tool = loadToolFromDirState(toolState)
        if (tool) tools.push(tool)
      } catch (error) {
        console.warn(`[ToolDir] 加载工具失败: ${pluginId}/${toolState.domain}/${toolState.id}`, error)
      }
    }
  }

  return tools
}

/**
 * 收集指定工具集的目录化运行时工具。
 *
 * 评测不能注入全局目录工具，否则被测 Toolset 会获得未声明能力。这里复用与生产
 * 相同的「目录 execute.ts → 代码 fallback」执行绑定，但只返回目标目录声明的工具。
 */
export function collectDirectoryToolsForPlugin(pluginId: string): RuntimeToolDefinition[] {
  const state = readPluginToolsDirState(pluginId)
  if (!state) return []

  const tools: RuntimeToolDefinition[] = []
  for (const toolState of state.tools) {
    try {
      const tool = loadToolFromDirState(toolState)
      if (tool) tools.push(tool)
    } catch (error) {
      console.warn(`[ToolDir] 加载工具集工具失败: ${pluginId}/${toolState.domain}/${toolState.id}`, error)
    }
  }
  return tools
}

/** 从目录状态加载 RuntimeToolDefinition */
function loadToolFromDirState(state: ToolDirState): RuntimeToolDefinition | null {
  // 如果有 execute.ts，动态加载
  if (state.executePath) {
    try {
      const mod = require(state.executePath) as { execute?: (input: unknown) => Promise<unknown> }
      if (typeof mod.execute === 'function') {
        return {
          name: state.id,
          description: state.description,
          parameters: state.parameters,
          execute: async (input, _ctx) => {
            const result = await mod.execute!(input)
            if (result && typeof result === 'object' && 'content' in result) {
              const output = result as { toolCallId?: string; content: string; isError?: boolean }
              return { toolCallId: output.toolCallId ?? '', content: output.content, isError: output.isError }
            }
            return { toolCallId: '', content: String(result ?? '') }
          },
        }
      }
    } catch {
      // 加载失败，继续 fallback
    }
  }

  // 安装目录里的 TS 相对引用可能不可用；内置实现已静态纳入主进程 bundle。
  const builtin = getBundledMarketingExecutor(state.id) ?? getBundledOutboundExecutor(state.id)
  if (!builtin) return null
  return {
    name: state.id, description: state.description, parameters: state.parameters,
    execute: async (input) => {
      const result = await builtin.execute(input)
      if (result && typeof result === 'object' && 'content' in result) {
        const output = result as { toolCallId?: string; content: string; isError?: boolean }
        return { toolCallId: output.toolCallId ?? '', content: output.content, isError: output.isError }
      }
      return { toolCallId: '', content: String(result ?? '') }
    },
  }
}

// =====================================================================
// 工具提示收集
// =====================================================================

/**
 * 收集所有已启用插件的 TOOLS.md 内容。
 * 供 buildSystemPrompt 注入工具调用引导。
 */
export function collectDirectoryToolPrompts(shouldInclude?: DirectoryToolsetFilter): string[] {
  const prompts: string[] = []
  const toolsDir = getDefaultToolsUserDir()
  if (!existsSync(toolsDir)) return prompts

  const pluginDirs = readDirNames(toolsDir)
  for (const pluginId of pluginDirs) {
    const state = readPluginToolsDirState(pluginId)
    if (shouldInclude && !shouldInclude(pluginId)) continue
    if (state?.toolsMd) {
      prompts.push(`<plugin_tools plugin="${pluginId}">\n${state.toolsMd}\n</plugin_tools>`)
    }
  }

  return prompts
}

// =====================================================================
// 辅助函数
// =====================================================================

/** 读取目录下的子目录名列表 */
function readDirNames(dir: string): string[] {
  try {
    const entries = require('node:fs').readdirSync(dir, { withFileTypes: true })
    return entries.filter((e: { isDirectory: () => boolean }) => e.isDirectory()).map((e: { name: string }) => e.name)
  } catch {
    return []
  }
}

/** 验证是否为有效的 JSON Schema parameters */
function isValidParameters(v: unknown): v is ToolDefinition['parameters'] {
  if (!v || typeof v !== 'object') return false
  const obj = v as Record<string, unknown>
  return obj.type === 'object'
}
