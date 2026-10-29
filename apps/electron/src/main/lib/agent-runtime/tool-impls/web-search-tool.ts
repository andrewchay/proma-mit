/**
 * WebSearch 工具实现（Agent Runtime）
 *
 * 支持两个搜索后端：
 * - Tavily（默认）：https://api.tavily.com/search
 * - MetaSo（秘塔 AI 搜索）：https://metaso.cn/api/v1/search
 *
 * 凭据与 Chat 模式共用：~/.proma/chat-tools.json 的 toolCredentials['web-search']：
 * - apiKey: Tavily API Key
 * - metasoApiKey: MetaSo Bearer API Key
 * - provider: 可选 'tavily' | 'metaso'，显式指定后端；缺省时自动选择
 *   （配了 metasoApiKey 且未配 apiKey 则用 MetaSo，否则 Tavily）。
 *
 * 绝大多数网页信息需求（天气、新闻、资料、价格等）应优先走 WebSearch，
 * 而不是 Web Bridge；Web Bridge 仅用于用户明确要求爬取特定网站或代为操作浏览器。
 */

import type { ToolResult } from '@gravitas/core'
import type { ToolContext } from '../types.ts'
import { getToolCredentials } from '../../chat-tool-config'
import { getFetchFn } from '../../proxy-fetch'
import { getEffectiveProxyUrl } from '../../proxy-settings-service'
import { assertOwnerToolPermission, formatToolError } from './tool-utils.ts'
import { readBoundedWebBody } from './bounded-web-body'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export interface WebSearchToolInput {
  query: string
}

export interface WebSearchResultItem {
  title: string
  url: string
  snippet: string
  publishedAt?: string
}

/** 搜索后端类型 */
export type WebSearchProvider = 'tavily' | 'metaso'

export interface WebSearchCredentials {
  apiKey?: string
  metasoApiKey?: string
  provider?: string
}

export function createWebSearchToolDefinition() {
  return {
    name: WEB_SEARCH_TOOL_NAME,
    description:
      '搜索互联网获取实时信息。当用户询问天气、新闻、最新数据、实时信息，或不确定的事实性问题时使用；搜索后综合整理结果回答用户。',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: '搜索查询词，使用简洁明确的关键词',
        },
      },
      required: ['query'],
    },
  }
}

// ===== Tavily =====

/** Tavily API 搜索结果类型 */
interface TavilySearchResult {
  title: string
  url: string
  content: string
  score: number
}

interface TavilySearchResponse {
  results: TavilySearchResult[]
  answer?: string
}

async function searchTavily(query: string, apiKey: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<ToolResult> {
  const response = await fetchFn('https://api.tavily.com/search', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: true,
    }),
  })

  if (!response.ok) {
    const errorText = new TextDecoder().decode(await readBoundedWebBody(response.body, signal, 2_000_000, '搜索响应'))
    return { toolCallId: '', content: `搜索请求失败 (${response.status}): ${errorText}`, isError: true }
  }

  const data = JSON.parse(new TextDecoder().decode(await readBoundedWebBody(response.body, signal, 2_000_000, '搜索响应'))) as TavilySearchResponse
  return { toolCallId: '', content: formatTavilyResults(data) }
}

/** 项目扫描等后台流程使用的结构化搜索入口，沿用同一凭据与代理配置。 */
export async function searchWebResults(query: string): Promise<WebSearchResultItem[]> {
  const credentials = getToolCredentials('web-search') as WebSearchCredentials
  const provider = resolveWebSearchProvider(credentials)
  const proxyUrl = await getEffectiveProxyUrl()
  const fetchFn = getFetchFn(proxyUrl)
  if (provider === 'metaso') {
    if (!credentials.metasoApiKey) throw new Error('未配置 MetaSo 搜索 API Key')
    const response = await fetchFn(METASO_SEARCH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credentials.metasoApiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, scope: 'webpage', includeSummary: false, size: '5', includeRawContent: false, conciseSnippet: false }),
    })
    if (!response.ok) throw new Error(`搜索请求失败 (${response.status})`)
    const data = await response.json() as MetasoSearchResponse
    return (data.webpages ?? []).filter((page) => page.link).map((page) => ({
      title: page.title || '无标题', url: page.link, snippet: page.snippet?.replace(/\s*\|\|\|\s*/g, ' ').slice(0, 500) ?? '',
      ...(page.date ? { publishedAt: page.date } : {}),
    }))
  }
  if (!credentials.apiKey) throw new Error('未配置 Tavily 或 MetaSo 搜索 API Key')
  const response = await fetchFn('https://api.tavily.com/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: credentials.apiKey, query, search_depth: 'basic', max_results: 5, include_answer: false }),
  })
  if (!response.ok) throw new Error(`搜索请求失败 (${response.status})`)
  const data = await response.json() as TavilySearchResponse
  return (data.results ?? []).filter((item) => item.url).map((item) => ({ title: item.title, url: item.url, snippet: item.content.slice(0, 500) }))
}

/** 格式化 Tavily 结果为 LLM 可读文本 */
function formatTavilyResults(data: TavilySearchResponse): string {
  const parts: string[] = []

  if (data.answer) {
    parts.push(`**概要：** ${data.answer}`)
    parts.push('')
  }

  if (data.results && data.results.length > 0) {
    parts.push('**搜索结果：**')
    for (const result of data.results) {
      parts.push(`- [${result.title}](${result.url})`)
      parts.push(`  ${result.content.slice(0, 300)}`)
      parts.push('')
    }
  } else {
    parts.push('未找到相关结果。')
  }

  return parts.join('\n')
}

// ===== MetaSo =====

/** MetaSo 搜索 API 端点 */
const METASO_SEARCH_URL = 'https://metaso.cn/api/v1/search'

/** MetaSo 搜索结果类型 */
interface MetasoWebpage {
  title: string
  link: string
  score?: string
  snippet?: string
  position?: number
  date?: string
  authors?: string[]
  authorityDomain?: string
  authorityType?: string
}

interface MetasoSearchResponse {
  webpages?: MetasoWebpage[]
  total?: number
}

async function searchMetaso(query: string, apiKey: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<ToolResult> {
  const response = await fetchFn(METASO_SEARCH_URL, {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: query,
      scope: 'webpage',
      includeSummary: false,
      size: '5',
      includeRawContent: false,
      conciseSnippet: false,
    }),
  })

  if (!response.ok) {
    const errorText = new TextDecoder().decode(await readBoundedWebBody(response.body, signal, 2_000_000, '搜索响应'))
    return { toolCallId: '', content: `搜索请求失败 (${response.status}): ${errorText}`, isError: true }
  }

  const data = JSON.parse(new TextDecoder().decode(await readBoundedWebBody(response.body, signal, 2_000_000, '搜索响应'))) as MetasoSearchResponse
  return { toolCallId: '', content: formatMetasoResults(data) }
}

/** 格式化 MetaSo 结果为 LLM 可读文本 */
function formatMetasoResults(data: MetasoSearchResponse): string {
  const parts: string[] = []
  const pages = data.webpages ?? []

  if (pages.length > 0) {
    parts.push(`**搜索结果：**（共 ${data.total ?? pages.length} 条，显示前 ${pages.length} 条）`)
    for (const page of pages) {
      const title = page.title || '无标题'
      const link = page.link || ''
      parts.push(`- [${title}](${link})`)
      if (page.snippet) {
        parts.push(`  ${page.snippet.replace(/\s*\|\|\|\s*/g, ' ').slice(0, 300)}`)
      }
      const meta: string[] = []
      if (page.date) meta.push(page.date)
      if (page.authors && page.authors.length > 0) meta.push(page.authors.join('、'))
      if (page.authorityDomain) meta.push(page.authorityDomain)
      if (meta.length > 0) parts.push(`  （${meta.join(' · ')}）`)
      parts.push('')
    }
  } else {
    parts.push('未找到相关结果。')
  }

  return parts.join('\n')
}

// ===== 路由 =====

/** 根据凭据决定使用哪个搜索后端 */
export function resolveWebSearchProvider(credentials: WebSearchCredentials): WebSearchProvider {
  if (credentials.provider === 'metaso') return 'metaso'
  if (credentials.provider === 'tavily') return 'tavily'
  // 自动选择：只配了 MetaSo key 时用 MetaSo；否则默认 Tavily
  if (credentials.metasoApiKey && !credentials.apiKey) return 'metaso'
  return 'tavily'
}

export async function executeWebSearchTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const params = input as WebSearchToolInput
  const query = params.query?.trim()

  if (!query) {
    return { toolCallId: '', content: '搜索参数缺失: query', isError: true }
  }

  try { assertOwnerToolPermission(ctx.sessionId, ctx.ownerWorkspaceWrite, WEB_SEARCH_TOOL_NAME, { query }) }
  catch (error) { return { toolCallId: '', content: formatToolError(error), isError: true } }
  const credentials = getToolCredentials('web-search') as WebSearchCredentials
  const provider = resolveWebSearchProvider(credentials)

  try {
    // 网络请求统一跟随 Proma 代理设置
    const proxyUrl = await getEffectiveProxyUrl()
    const fetchFn = getFetchFn(proxyUrl)
    assertOwnerToolPermission(ctx.sessionId, ctx.ownerWorkspaceWrite, WEB_SEARCH_TOOL_NAME, { query })

    const controller = new AbortController()
    const abortFromCaller = () => controller.abort()
    if (ctx.abortSignal?.aborted) controller.abort()
    else ctx.abortSignal?.addEventListener('abort', abortFromCaller, { once: true })
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      if (controller.signal.aborted) throw new Error('搜索已取消或超时')
      if (provider === 'metaso') {
        if (!credentials.metasoApiKey) {
          return {
            toolCallId: '',
            content: 'MetaSo 搜索未配置 API Key。请告知用户在 设置 > Chat 工具 中为「联网搜索」配置 metasoApiKey 后重试。',
            isError: true,
          }
        }
        const result = await searchMetaso(query, credentials.metasoApiKey, fetchFn, controller.signal)
        assertOwnerToolPermission(ctx.sessionId, ctx.ownerWorkspaceWrite, WEB_SEARCH_TOOL_NAME, { query })
        return result
      }

      if (!credentials.apiKey) {
        return {
          toolCallId: '',
          content: '搜索工具未配置 API Key（Tavily 或 MetaSo）。请告知用户在 设置 > Chat 工具 中为「联网搜索」配置 API Key 后重试。',
          isError: true,
        }
      }
      const result = await searchTavily(query, credentials.apiKey, fetchFn, controller.signal)
      assertOwnerToolPermission(ctx.sessionId, ctx.ownerWorkspaceWrite, WEB_SEARCH_TOOL_NAME, { query })
      return result
    } finally {
      clearTimeout(timer)
      ctx.abortSignal?.removeEventListener('abort', abortFromCaller)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[Agent WebSearch] 执行失败:', error)
    return { toolCallId: '', content: `搜索失败: ${msg}`, isError: true }
  }
}
