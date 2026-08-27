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
export function collectDirectoryTools(): RuntimeToolDefinition[] {
  const tools: RuntimeToolDefinition[] = []
  const toolsDir = getDefaultToolsUserDir()
  if (!existsSync(toolsDir)) return tools

  const pluginDirs = readDirNames(toolsDir)
  for (const pluginId of pluginDirs) {
    const state = readPluginToolsDirState(pluginId)
    if (!state) continue

    for (const toolState of state.tools) {
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
            return { toolCallId: '', content: String(result ?? '') }
          },
        }
      }
    } catch {
      // 加载失败，继续 fallback
    }
  }

  // 无 execute.ts 或加载失败：尝试从代码默认加载
  const codeFallback = loadCodeFallbackTool(state.id)
  if (codeFallback) return codeFallback

  return null
}

/** 从代码默认加载工具（向后兼容） */
function loadCodeFallbackTool(toolId: string): RuntimeToolDefinition | null {
  // 营销工具的代码 fallback 映射
  const marketingFallbacks: Record<string, () => RuntimeToolDefinition | null> = {
    // shared
    'ma_generate_storyboard': () => {
      try {
        const { marketingGenerateStoryboardTool } = require('./plugins/marketing-plugin')
        return marketingGenerateStoryboardTool()
      } catch { return null }
    },
    // influencer
    'ma_match_kols': () => loadToolFromModule('../marketing/ma-tools/match-ai', 'MATCH_AI_TOOL_DEFINITIONS', 'executeMatchAITool'),
    'ma_search_kols': () => loadToolFromModule('../marketing/ma-tools/kol-search', 'KOL_SEARCH_TOOL_DEFINITIONS', 'executeKOLSearchTool'),
    'ma_generate_creative_brief': () => loadToolFromModule('../marketing/ma-tools/creative-pilot', 'CREATIVE_PILOT_TOOL_DEFINITIONS', 'executeCreativePilotTool'),
    'ma_audit_content': () => loadToolFromModule('../marketing/ma-tools/content-audit', 'CONTENT_AUDIT_TOOL_DEFINITIONS', 'executeContentAuditTool'),
    'ma_generate_outreach': () => loadToolFromModule('../marketing/ma-tools/connect-bot', 'CONNECT_BOT_TOOL_DEFINITIONS', 'executeConnectBotTool'),
    'ma_generate_script': () => loadToolFromModule('../marketing/ma-tools/script-studio', 'SCRIPT_STUDIO_TOOL_DEFINITIONS', 'executeScriptStudioTool'),
    'ma_kol_crm': () => loadToolFromModule('../marketing/ma-tools/kol-crm', 'KOL_CRM_TOOL_DEFINITIONS', 'executeKOLCRMTool'),
    'ma_kol_portal': () => loadToolFromModule('../marketing/ma-tools/kol-portal', 'KOL_PORTAL_TOOL_DEFINITIONS', 'executeKOLPortalTool'),
    // paid-media
    'ma_generate_strategy': () => loadToolFromModule('../marketing/ma-tools/strategy-iq', 'STRATEGY_IQ_TOOL_DEFINITIONS', 'executeStrategyIQTool'),
    'ma_campaign_get': () => loadToolFromModule('../marketing/ma-tools/campaign-agent', 'CAMPAIGN_AGENT_TOOL_DEFINITIONS', 'executeCampaignAgentTool'),
    'ma_campaign_update': () => loadToolFromModule('../marketing/ma-tools/campaign-agent', 'CAMPAIGN_AGENT_TOOL_DEFINITIONS', 'executeCampaignAgentTool'),
    'ma_campaign_kol_add': () => loadToolFromModule('../marketing/ma-tools/campaign-agent', 'CAMPAIGN_AGENT_TOOL_DEFINITIONS', 'executeCampaignAgentTool'),
    'ma_optimize_campaign': () => loadToolFromModule('../marketing/ma-tools/campaign-optimizer', 'CAMPAIGN_OPTIMIZER_TOOL_DEFINITIONS', 'executeCampaignOptimizerTool'),
    'ma_design_campaign_test': () => loadToolFromModule('../marketing/ma-tools/campaign-tester', 'CAMPAIGN_TESTER_TOOL_DEFINITIONS', 'executeCampaignTesterTool'),
    'ma_forecast_budget': () => loadToolFromModule('../marketing/ma-tools/budget-forecast', 'BUDGET_FORECAST_TOOL_DEFINITIONS', 'executeBudgetForecastTool'),
    'ma_generate_phase_report': () => loadToolFromModule('../marketing/ma-tools/ma-phase-reviewer', 'PHASE_REVIEWER_TOOL_DEFINITIONS', 'executePhaseReviewerTool'),
    'ma_analyze_content_performance': () => loadToolFromModule('../marketing/ma-tools/content-tracker', 'CONTENT_TRACKER_TOOL_DEFINITIONS', 'executeContentTrackerTool'),
  }

  const factory = marketingFallbacks[toolId]
  return factory ? factory() : null
}

/** 从既有 ma-tool 模块加载工具定义 */
function loadToolFromModule(relPath: string, defsKey: string, execKey: string): RuntimeToolDefinition | null {
  try {
    const mod = require(relPath) as Record<string, unknown>
    const defs = mod[defsKey] as Array<{ name: string; description: string; parameters: unknown }> | undefined
    const execute = mod[execKey] as (toolCall: { id: string; name: string; arguments: Record<string, unknown> }) => Promise<unknown>
    if (!defs || !Array.isArray(defs) || defs.length === 0) return null
    const def = defs[0]
    if (!def || typeof execute !== 'function') return null
    return {
      name: def.name,
      description: def.description,
      parameters: def.parameters as ToolDefinition['parameters'],
      execute: async (input) => {
        const result = await execute({ id: '', name: def.name, arguments: (input ?? {}) as Record<string, unknown> })
        if (result && typeof result === 'object' && 'content' in result) {
          const r = result as { toolCallId?: string; content: string; isError?: boolean }
          return { toolCallId: r.toolCallId ?? '', content: r.content, isError: r.isError }
        }
        return { toolCallId: '', content: String(result ?? '') }
      },
    }
  } catch {
    return null
  }
}

// =====================================================================
// 工具提示收集
// =====================================================================

/**
 * 收集所有已启用插件的 TOOLS.md 内容。
 * 供 buildSystemPrompt 注入工具调用引导。
 */
export function collectDirectoryToolPrompts(): string[] {
  const prompts: string[] = []
  const toolsDir = getDefaultToolsUserDir()
  if (!existsSync(toolsDir)) return prompts

  const pluginDirs = readDirNames(toolsDir)
  for (const pluginId of pluginDirs) {
    const state = readPluginToolsDirState(pluginId)
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
