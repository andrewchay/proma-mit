/**
 * KOL 数据 MCP Server（Agent 模式）
 *
 * 将 KOL 数据采集源（新榜、JustOneAPI、星图）封装为内置 MCP Server，
 * 通过 sdk.createSdkMcpServer() 注入到每个 Agent 会话。
 *
 * 提供的工具：
 * - search_kols: 本地 KOL 数据库搜索
 * - get_kol_detail: 获取单个 KOL 详情
 * - sync_kol_data: 从外部 API 同步数据
 * - analyze_kol: AI 分析 KOL 数据
 * - get_kol_stats: 数据库统计概览
 */

import {
  searchKOLs,
  getKOLById,
  getKOLStats,
  seedMockKOLs,
  collectFromSource,
  type KOLRecord,
  type KOLSearchFilters,
} from './kol-data-service'
import { completePrompt } from './llm-service'
import { getToolState, getToolCredentials } from '../../chat-tool-config'

// =====================================================================
// MCP 内容块类型
// =====================================================================

interface McpTextContent {
  type: 'text'
  text: string
  [key: string]: unknown
}

type McpContent = McpTextContent

interface McpToolResult {
  content: McpContent[]
  [key: string]: unknown
}

// =====================================================================
// 工具实现
// =====================================================================

/**
 * 格式化 KOL 记录为可读文本
 */
function formatKOL(kol: KOLRecord): string {
  return [
    `【${kol.name}】`,
    `  平台: ${kol.platform}`,
    `  粉丝: ${kol.followers}`,
    `  互动率: ${kol.engagement}`,
    `  类目: ${kol.category}`,
    `  报价: ${kol.price}`,
    `  城市: ${kol.city || '未知'}`,
    `  来源: ${kol.source}`,
    `  ID: ${kol.id}`,
  ].join('\n')
}

/**
 * 格式化 KOL 详情（含 rawData 解析）
 */
function formatKOLDetail(kol: KOLRecord): string {
  const lines = [
    `## ${kol.name}`,
    '',
    '| 字段 | 值 |',
    '|------|------|',
    `| 平台 | ${kol.platform} |`,
    `| 粉丝量 | ${kol.followers} |`,
    `| 互动率 | ${kol.engagement} |`,
    `| 类目 | ${kol.category} |`,
    `| 报价 | ${kol.price} |`,
    `| 城市 | ${kol.city || '未知'} |`,
    `| 头像 | ${kol.avatar || '无'} |`,
    `| 数据来源 | ${kol.source} |`,
    `| 内部 ID | ${kol.id} |`,
    '',
  ]

  if (kol.rawData && kol.rawData !== '{}') {
    try {
      const raw = JSON.parse(kol.rawData) as Record<string, unknown>
      lines.push('### 原始数据摘要')
      lines.push('```json')
      // 只展示前 5 个非空字段，避免过长
      const entries = Object.entries(raw).filter(([, v]) => v !== null && v !== undefined && v !== '')
      for (const [key, value] of entries.slice(0, 15)) {
        const display = typeof value === 'object' ? JSON.stringify(value).slice(0, 80) : String(value).slice(0, 80)
        lines.push(`  "${key}": ${display}`)
      }
      if (entries.length > 15) {
        lines.push(`  ... 还有 ${entries.length - 15} 个字段`)
      }
      lines.push('```')
    } catch {
      lines.push('### 原始数据')
      lines.push(kol.rawData.slice(0, 500))
    }
  }

  return lines.join('\n')
}

/**
 * search_kols — 本地 KOL 数据库搜索
 */
async function handleSearchKOLs(args: {
  query?: string
  platform?: string
  category?: string
  minFollowers?: number
  maxFollowers?: number
  city?: string
  limit?: number
}): Promise<McpToolResult> {
  const filters: KOLSearchFilters = {
    platform: args.platform,
    category: args.category,
    city: args.city,
    limit: args.limit ?? 20,
  }

  if (args.query && args.query.trim()) {
    filters.keywords = args.query.trim().split(/\s+/)
  }

  // 粉丝数范围解析（字符串格式如 "50万" 暂不支持数值比较，只作关键词过滤）
  const result = searchKOLs(filters)

  if (result.kols.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `未找到匹配的 KOL。当前数据库共 ${result.total} 条记录。\n\n建议：\n1. 尝试更宽泛的关键词\n2. 使用 sync_kol_data 工具从 API 同步数据\n3. 使用 seed_mock_data 工具填充示例数据`,
      }],
    }
  }

  const lines = [
    `找到 ${result.kols.length} 位 KOL（数据库共 ${result.total} 条）：`,
    '',
    ...result.kols.map(formatKOL),
    '',
    '---',
    `提示：使用 get_kol_detail 工具获取某位 KOL 的完整信息，使用 analyze_kol 工具进行深度分析。`,
  ]

  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

/**
 * get_kol_detail — 获取单个 KOL 详情
 */
async function handleGetKOLDetail(args: {
  kolId: string
}): Promise<McpToolResult> {
  const kol = getKOLById(args.kolId)
  if (!kol) {
    return {
      content: [{
        type: 'text',
        text: `未找到 KOL: ${args.kolId}\n\n请使用 search_kols 工具搜索正确的 ID。`,
      }],
    }
  }

  return { content: [{ type: 'text', text: formatKOLDetail(kol) }] }
}

/**
 * sync_kol_data — 从外部 API 同步数据
 */
async function handleSyncKOLData(args: {
  source: 'justone' | 'newrank' | 'mock'
  platform?: string
  keywords?: string
  limit?: number
}): Promise<McpToolResult> {
  const credentials = getToolCredentials('ma-kol-search')

  if (args.source === 'mock') {
    const { inserted } = seedMockKOLs()
    const stats = getKOLStats()
    return {
      content: [{
        type: 'text',
        text: `✅ Mock 数据同步完成\n\n新增: ${inserted} 条\n数据库总计: ${stats.total} 条\n按平台分布: ${Object.entries(stats.byPlatform).map(([p, c]) => `${p}(${c})`).join(', ')}`,
      }],
    }
  }

  const config = {
    justoneToken: credentials.justoneToken,
    newrankKey: credentials.newrankKey,
  }

  const platform = args.platform || '小红书'
  const keywords = args.keywords ? args.keywords.split(/[,，]/) : undefined
  const limit = args.limit ?? 20

  const report = await collectFromSource(args.source, config, platform, keywords, limit)

  if (!report.success) {
    return {
      content: [{
        type: 'text',
        text: `❌ 同步失败\n\n数据源: ${args.source}\n平台: ${platform}\n错误: ${report.errors.join(', ')}\n\n请在 Chat 工具设置中配置 ${args.source === 'justone' ? 'JustOneAPI Token' : '新榜 API Key'}。`,
      }],
    }
  }

  const stats = getKOLStats()
  const lines = [
    `✅ ${args.source} 数据同步完成`,
    '',
    `| 指标 | 数值 |`,
    `|------|------|`,
    `| 数据源 | ${args.source} |`,
    `| 平台 | ${platform} |`,
    `| 采集数量 | ${report.collected} |`,
    `| 新增 | ${report.new} |`,
    `| 更新 | ${report.updated} |`,
    `| 数据库总计 | ${stats.total} |`,
  ]

  if (report.errors.length > 0) {
    lines.push('', `**警告**: ${report.errors.length} 条记录写入失败`)
    for (const err of report.errors.slice(0, 5)) {
      lines.push(`- ${err}`)
    }
  }

  if (report.message) {
    lines.push('', `**备注**: ${report.message}`)
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

/**
 * analyze_kol — AI 分析 KOL 数据
 */
async function handleAnalyzeKOL(args: {
  kolId?: string
  kolIds?: string[]
  analysisType?: 'profile' | 'content' | 'value' | 'risk' | 'comprehensive'
}): Promise<McpToolResult> {
  const ids = args.kolIds ?? (args.kolId ? [args.kolId] : [])
  if (ids.length === 0) {
    return {
      content: [{
        type: 'text',
        text: '请提供 kolId 或 kolIds 参数。',
      }],
    }
  }

  const kols: KOLRecord[] = []
  for (const id of ids) {
    const kol = getKOLById(id)
    if (kol) kols.push(kol)
  }

  if (kols.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `未找到指定的 KOL: ${ids.join(', ')}\n\n请先用 search_kols 搜索正确的 ID。`,
      }],
    }
  }

  const analysisType = args.analysisType ?? 'comprehensive'
  const typeLabels: Record<string, string> = {
    profile: '画像分析',
    content: '内容分析',
    value: '商业价值评估',
    risk: '风险评估',
    comprehensive: '综合分析',
  }

  // 构建分析 prompt
  const kolData = kols.map(formatKOLDetail).join('\n\n---\n\n')
  const systemPrompt = `你是一位资深 KOL 营销分析师，擅长从数据维度评估达人价值。
请基于提供的 KOL 数据生成 ${typeLabels[analysisType]}报告。
报告要求：
- 使用中文，专业但易懂
- 包含数据洞察和可执行建议
- 如果是多位 KOL，请提供对比分析`

  const userPrompt = `## 分析类型
${typeLabels[analysisType]}

## KOL 数据
${kolData}

请生成分析报告。`

  const result = await completePrompt(userPrompt, systemPrompt, { temperature: 0.5 })

  if (!result.success) {
    return {
      content: [{
        type: 'text',
        text: `分析失败: ${result.error || '未知错误'}\n\n已获取 ${kols.length} 位 KOL 数据，但 LLM 调用失败。请检查渠道配置。`,
      }],
    }
  }

  return {
    content: [{
      type: 'text',
      text: `# ${typeLabels[analysisType]}报告\n\n${result.text}`,
    }],
  }
}

/**
 * get_kol_stats — 数据库统计概览
 */
async function handleGetKOLStats(): Promise<McpToolResult> {
  const stats = getKOLStats()

  const lines = [
    '# KOL 数据库统计',
    '',
    `**总记录数**: ${stats.total}`,
    '',
    '## 按平台分布',
    ...Object.entries(stats.byPlatform).map(([platform, count]) => `- ${platform}: ${count} 位`),
    '',
    '## 按数据来源',
    ...Object.entries(stats.bySource).map(([source, count]) => `- ${source}: ${count} 位`),
    '',
    '---',
    '提示：使用 sync_kol_data 工具同步更多数据，使用 seed_mock_data 填充示例数据。',
  ]

  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

/**
 * seed_mock_data — 填充示例数据（便捷工具）
 */
async function handleSeedMockData(): Promise<McpToolResult> {
  const { inserted } = seedMockKOLs()
  const stats = getKOLStats()

  return {
    content: [{
      type: 'text',
      text: `✅ 示例数据已填充\n\n新增: ${inserted} 条\n数据库总计: ${stats.total} 条\n\n现在可以使用 search_kols 搜索这些示例数据了。`,
    }],
  }
}

// =====================================================================
// MCP Server 注入
// =====================================================================

/**
 * 注入 KOL 数据 MCP Server 到 Agent 会话
 */
export async function injectKOLDataMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
): Promise<void> {
  // 检查工具是否启用
  const toolState = getToolState('ma-kol-data-mcp')
  if (!toolState.enabled) return

  const { z } = await import('zod')

  const server = sdk.createSdkMcpServer({
    name: 'kol-data',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'search_kols',
        'Search the local KOL database by keywords, platform, category, or city. Returns a list of matching KOLs with basic info (followers, engagement, price, etc.). Use this to find influencers for marketing campaigns.',
        {
          query: z.string().optional().describe('Search keywords (space-separated for multiple terms). e.g. "美妆 护肤"'),
          platform: z.string().optional().describe('Filter by platform: 小红书, 抖音, 微博, B站, 快手, etc.'),
          category: z.string().optional().describe('Filter by category: 美妆, 3C, 美食, 时尚, 母婴, etc.'),
          minFollowers: z.number().optional().describe('Minimum follower count (numeric, in ten-thousands for Chinese platforms)'),
          maxFollowers: z.number().optional().describe('Maximum follower count'),
          city: z.string().optional().describe('Filter by city: 上海, 北京, 杭州, etc.'),
          limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20, max 100)'),
        },
        async (args) => {
          try {
            return await handleSearchKOLs(args)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.error('[KOL Data MCP] search_kols 失败:', error)
            return { content: [{ type: 'text' as const, text: `搜索失败: ${msg}` }] }
          }
        },
        { annotations: { readOnlyHint: true } },
      ),

      sdk.tool(
        'get_kol_detail',
        'Get detailed information about a specific KOL by ID. Includes full profile, raw data from the source API, and metadata. Use this after search_kols to deep-dive into a candidate.',
        {
          kolId: z.string().describe('KOL ID (from search_kols results). e.g. "mock_小红书_美妆达人小美"'),
        },
        async (args) => {
          try {
            return await handleGetKOLDetail(args)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.error('[KOL Data MCP] get_kol_detail 失败:', error)
            return { content: [{ type: 'text' as const, text: `获取详情失败: ${msg}` }] }
          }
        },
        { annotations: { readOnlyHint: true } },
      ),

      sdk.tool(
        'sync_kol_data',
        'Sync KOL data from external APIs (JustOneAPI or Newrank) into the local database. Requires API credentials configured in Chat Tool settings. Use this when local data is insufficient or stale.',
        {
          source: z.enum(['justone', 'newrank', 'mock']).describe('Data source: justone (JustOneAPI), newrank (新榜), or mock (sample data for testing)'),
          platform: z.string().optional().describe('Target platform: 小红书, 抖音, 微博, B站, 快手. Default: 小红书'),
          keywords: z.string().optional().describe('Search keywords for the API (comma-separated). e.g. "美妆,护肤"'),
          limit: z.number().int().min(1).max(100).optional().describe('Max KOLs to fetch (default 20, max 100)'),
        },
        async (args) => {
          try {
            return await handleSyncKOLData(args)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.error('[KOL Data MCP] sync_kol_data 失败:', error)
            return { content: [{ type: 'text' as const, text: `同步失败: ${msg}` }] }
          }
        },
      ),

      sdk.tool(
        'analyze_kol',
        'Analyze KOL data using AI. Generates profile, content, commercial value, risk, or comprehensive analysis reports. Requires an AI channel to be configured. Use this for campaign planning and KOL selection decisions.',
        {
          kolId: z.string().optional().describe('Single KOL ID to analyze'),
          kolIds: z.array(z.string()).optional().describe('Multiple KOL IDs for comparative analysis'),
          analysisType: z.enum(['profile', 'content', 'value', 'risk', 'comprehensive']).optional().describe('Analysis type: profile (画像), content (内容), value (商业价值), risk (风险), comprehensive (综合). Default: comprehensive'),
        },
        async (args) => {
          try {
            return await handleAnalyzeKOL(args)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.error('[KOL Data MCP] analyze_kol 失败:', error)
            return { content: [{ type: 'text' as const, text: `分析失败: ${msg}` }] }
          }
        },
        { annotations: { readOnlyHint: true } },
      ),

      sdk.tool(
        'get_kol_stats',
        'Get database statistics: total KOLs, distribution by platform and data source. Use this to quickly assess the state of the local KOL database.',
        {},
        async () => {
          try {
            return await handleGetKOLStats()
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.error('[KOL Data MCP] get_kol_stats 失败:', error)
            return { content: [{ type: 'text' as const, text: `获取统计失败: ${msg}` }] }
          }
        },
        { annotations: { readOnlyHint: true } },
      ),

      sdk.tool(
        'seed_mock_data',
        'Seed the local database with sample KOL data for testing and demonstration. No API credentials required. Use this to explore the tool features before configuring real API access.',
        {},
        async () => {
          try {
            return await handleSeedMockData()
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.error('[KOL Data MCP] seed_mock_data 失败:', error)
            return { content: [{ type: 'text' as const, text: `填充示例数据失败: ${msg}` }] }
          }
        },
      ),
    ],
  })

  mcpServers['kol-data'] = server as unknown as Record<string, unknown>
  console.log('[KOL Data MCP] 已注入 KOL 数据工具 (kol-data)')
}
