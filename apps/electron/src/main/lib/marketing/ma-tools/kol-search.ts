/**
 * KOL 数据搜索工具（Chat Tool）
 *
 * 从本地数据库搜索 KOL，或从外部 API 数据源拉取新数据并存入本地数据库。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import type { ChatToolMeta } from '@gravitas/shared'
import {
  searchKOLs,
  getKOLStats,
  seedMockKOLs,
  collectFromSource,
  type KOLCollectorConfig,
} from './kol-data-service'
import { getToolCredentials } from '../../chat-tool-config'

// =====================================================================
// 工具元数据
// =====================================================================

export const KOL_SEARCH_TOOL_META: ChatToolMeta = {
  id: 'ma-kol-search',
  name: 'MAKOL搜索',
  description: '从本地KOL数据库搜索达人，或从外部API（新榜/JustOne）拉取新数据并存入数据库',
  params: [
    { name: 'action', type: 'string', description: '操作类型（search/search-all/collect-from-api/seed-mock/stats）', required: true, enum: ['search', 'search-all', 'collect-from-api', 'seed-mock', 'stats'] },
    { name: 'platform', type: 'string', description: '平台（小红书/抖音/B站/微博/快手/TikTok/Instagram/YouTube）', required: false },
    { name: 'category', type: 'string', description: '内容领域', required: false },
    { name: 'keywords', type: 'string', description: '搜索关键词，逗号分隔', required: false },
    { name: 'source', type: 'string', description: '数据源（justone/newrank）', required: false, enum: ['justone', 'newrank'] },
    { name: 'limit', type: 'number', description: '数量限制（默认20）', required: false },
  ],
  icon: 'Search',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<ma_kol_search_instructions>
你拥有 **MAKOL搜索** 能力。

**ma_search_kols — KOL 数据搜索与采集：**
当用户需要查找 KOL、获取达人数据时调用：
- 从本地数据库搜索 KOL
- 从外部 API 拉取新 KOL 数据
- 查看数据库统计信息

**操作类型：**
- search：本地数据库搜索
- search-all：查看所有 KOL
- collect-from-api：从 API 数据源采集（justone/newrank）
- seed-mock：填充 Mock 示例数据
- stats：查看数据库统计
</ma_kol_search_instructions>`,
}

export const KOL_SEARCH_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_search_kols',
    description: 'Search KOL database or fetch new KOL data from external APIs (JustOne/Newrank). Supports local search, API collection, mock data seeding, and database statistics. Use when the user needs to find influencers, collect KOL data, or check database status.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action type', enum: ['search', 'search-all', 'collect-from-api', 'seed-mock', 'stats'] },
        platform: { type: 'string', description: 'Platform filter' },
        category: { type: 'string', description: 'Content category filter' },
        keywords: { type: 'string', description: 'Search keywords, comma separated' },
        source: { type: 'string', description: 'Data source (justone/newrank)', enum: ['justone', 'newrank'] },
        limit: { type: 'number', description: 'Result limit (default 20)' },
      },
      required: ['action'],
    },
  },
]

// =====================================================================
// 可用性检查
// =====================================================================

export function isKOLSearchAvailable(): boolean {
  return true
}

// =====================================================================
// 工具执行
// =====================================================================

const TOOL_NAME = 'ma_search_kols'

export function isKOLSearchToolCall(toolName: string): boolean {
  return toolName === TOOL_NAME
}

export async function executeKOLSearchTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const action = String(args.action ?? 'search')

    switch (action) {
      case 'search':
        return handleSearch(args, toolCall.id)
      case 'search-all':
        return handleSearchAll(args, toolCall.id)
      case 'collect-from-api':
        return await handleCollectFromApi(args, toolCall.id)
      case 'seed-mock':
        return handleSeedMock(toolCall.id)
      case 'stats':
        return handleStats(toolCall.id)
      default:
        return { toolCallId: toolCall.id, content: `未知操作类型: ${action}`, isError: true }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[KOLSearch] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `KOL 搜索错误: ${msg}`, isError: true }
  }
}

// =====================================================================
// 各操作处理
// =====================================================================

function handleSearch(args: Record<string, unknown>, toolCallId: string): ToolResult {
  const platform = String(args.platform ?? '') || undefined
  const category = String(args.category ?? '') || undefined
  const keywordsStr = String(args.keywords ?? '')
  const keywords = keywordsStr ? keywordsStr.split(',').map((s) => s.trim()).filter(Boolean) : undefined
  const limit = typeof args.limit === 'number' ? args.limit : 20

  const result = searchKOLs({
    platform,
    category,
    keywords,
    limit,
  })

  const parts: string[] = []
  parts.push(`# KOL 搜索结果`)
  parts.push(`> 共找到 ${result.total} 条记录，显示前 ${result.kols.length} 条\n`)

  if (result.kols.length === 0) {
    parts.push('暂无匹配结果。')
    parts.push(`\n💡 提示：可使用 \`seed-mock\` 填充示例数据，或配置 API Key 后使用 \`collect-from-api\` 拉取真实数据。`)
  } else {
    parts.push('| 名称 | 平台 | 粉丝量 | 互动率 | 领域 | 报价 | 城市 | 来源 |')
    parts.push('|------|------|--------|--------|------|------|------|------|')
    for (const kol of result.kols) {
      parts.push(`| ${kol.name} | ${kol.platform} | ${kol.followers} | ${kol.engagement} | ${kol.category} | ${kol.price} | ${kol.city} | ${kol.source} |`)
    }
  }

  return { toolCallId, content: parts.join('\n') }
}

function handleSearchAll(args: Record<string, unknown>, toolCallId: string): ToolResult {
  const limit = typeof args.limit === 'number' ? args.limit : 50
  const result = searchKOLs({ limit })

  const parts: string[] = []
  parts.push(`# KOL 数据库概览`)
  parts.push(`> 共 ${result.total} 条记录\n`)

  if (result.kols.length === 0) {
    parts.push('数据库为空。')
    parts.push(`\n💡 使用 \`seed-mock\` 填充示例数据。`)
  } else {
    parts.push('| 名称 | 平台 | 粉丝量 | 互动率 | 领域 | 报价 | 来源 |')
    parts.push('|------|------|--------|--------|------|------|------|')
    for (const kol of result.kols) {
      parts.push(`| ${kol.name} | ${kol.platform} | ${kol.followers} | ${kol.engagement} | ${kol.category} | ${kol.price} | ${kol.source} |`)
    }
  }

  return { toolCallId, content: parts.join('\n') }
}

async function handleCollectFromApi(args: Record<string, unknown>, toolCallId: string): Promise<ToolResult> {
  const source = String(args.source ?? 'justone')
  const platform = String(args.platform ?? '小红书')
  const keywordsStr = String(args.keywords ?? '')
  const keywords = keywordsStr ? keywordsStr.split(',').map((s) => s.trim()).filter(Boolean) : undefined
  const limit = typeof args.limit === 'number' ? args.limit : 20

  // 从 chat-tools.json 读取 API 凭据
  const credentials = getToolCredentials('ma-kol-search')
  const config: KOLCollectorConfig = {
    justoneToken: credentials.justoneToken,
    newrankKey: credentials.newrankKey,
  }

  const report = await collectFromSource(source, config, platform, keywords, limit)

  const parts: string[] = []
  parts.push(`# KOL 数据采集结果`)
  parts.push(`- **数据源**：${report.source}`)
  parts.push(`- **平台**：${report.platform}`)
  parts.push(`- **状态**：${report.success ? '✅ 成功' : '❌ 失败'}`)

  if (report.message) {
    parts.push(`- **信息**：${report.message}`)
  }

  if (report.success) {
    parts.push(`- **采集数量**：${report.collected}`)
    parts.push(`- **新增**：${report.new}`)
    parts.push(`- **更新**：${report.updated}`)
  }

  if (report.errors.length > 0) {
    parts.push(`\n**错误：**`)
    for (const err of report.errors.slice(0, 5)) {
      parts.push(`- ${err}`)
    }
  }

  if (!report.success && report.errors.some((e) => e.includes('未配置'))) {
    parts.push(`\n💡 **配置 API Key：**`)
    parts.push(`- JustOne：在 Chat 工具设置中配置 \`ma-kol-search\` 的 \`justoneToken\``)
    parts.push(`- 新榜：在 Chat 工具设置中配置 \`ma-kol-search\` 的 \`newrankKey\``)
  }

  return { toolCallId, content: parts.join('\n') }
}

function handleSeedMock(toolCallId: string): ToolResult {
  const { inserted } = seedMockKOLs()

  const parts: string[] = []
  parts.push(`# Mock 数据已填充`)
  parts.push(`- **新增记录**：${inserted} 条`)
  parts.push(`\n现在可以使用 \`search\` 操作搜索 KOL 了。`)

  return { toolCallId, content: parts.join('\n') }
}

function handleStats(toolCallId: string): ToolResult {
  const stats = getKOLStats()

  const parts: string[] = []
  parts.push(`# KOL 数据库统计`)
  parts.push(`- **总记录数**：${stats.total}`)
  parts.push('')

  const platforms = Object.entries(stats.byPlatform)
  if (platforms.length > 0) {
    parts.push('## 按平台分布')
    for (const [p, count] of platforms) {
      parts.push(`- ${p}：${count} 条`)
    }
    parts.push('')
  }

  const sources = Object.entries(stats.bySource)
  if (sources.length > 0) {
    parts.push('## 按数据来源')
    for (const [s, count] of sources) {
      parts.push(`- ${s}：${count} 条`)
    }
  }

  return { toolCallId, content: parts.join('\n') }
}
