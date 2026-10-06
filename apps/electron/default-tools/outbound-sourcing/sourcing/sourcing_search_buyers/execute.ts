/**
 * sourcing_search_buyers — 检索海外买家候选（复用内部 WebSearch 执行器）
 *
 * 对齐 Redvia 的 serper_search.py 的检索环节，但不依赖 Serper 账号：
 * 复用 Proma 已配置的 web-search 凭据（Tavily / MetaSo）。
 *
 * 边界：只收集候选公司与来源链接，不做真伪判断；候选公司不等于已验证事实，
 * 是否真实买家由后续 sourcing_verify_company + Agent 判断决定。
 */
import { executeWebSearchTool } from '../../../../src/main/lib/chat-tools/web-search-tool'

interface Input {
  product?: string
  markets?: string[]
  buyer_types?: string[]
  max_queries?: number
}

interface CandidateHit {
  query: string
  title: string
  url: string
  snippet: string
}

/** 从搜索返回的文本中解析 "标题 / URL / 摘要" 结构（executeWebSearchTool 输出为 Markdown 文本） */
function parseSearchText(query: string, text: string): CandidateHit[] {
  const hits: CandidateHit[] = []
  const blocks = text.split(/\n(?=\d+\.\s|\*\*)/)
  for (const block of blocks) {
    const urlMatch = block.match(/https?:\/\/[^\s)\]"'<>]+/)
    if (!urlMatch) continue
    const title = (block.match(/^\s*(?:[\d]+\.\s*)?\*?\*?(.+?)\*?\*?\s*$/m)?.[1] ?? '').trim()
    const snippet = block.replace(/https?:\/\/[^\s)\]"'<>]+/, '').replace(/[#*`]/g, ' ').replace(/\s+/g, ' ').trim()
    hits.push({
      query,
      title: title || urlMatch[0],
      url: urlMatch[0],
      snippet: snippet.slice(0, 300),
    })
  }
  return hits
}

export async function execute(input: unknown): Promise<{ content: string; isError?: boolean }> {
  const v = (input ?? {}) as Input
  const product = String(v.product ?? '').trim()
  const markets = (Array.isArray(v.markets) ? v.markets : []).map(String).map((s) => s.trim()).filter(Boolean)
  if (!product || markets.length === 0) return { content: '参数缺失：product 与 markets 至少各填写一项', isError: true }

  const types = v.buyer_types?.length ? v.buyer_types : ['distributor', 'ingredient buyer', 'OEM manufacturer', 'brand']
  const maxQueries = Math.min(Math.max(Math.floor(v.max_queries ?? 6), 1), 20)

  // 生成查询（与 sourcing_build_keyword_plan 的口径一致）
  const queries: string[] = []
  for (const market of markets) {
    for (const type of types) {
      if (queries.length >= maxQueries) break
      queries.push(`${product} ${type} ${market}`)
    }
  }

  const hits: CandidateHit[] = []
  const failures: Array<{ query: string; error: string }> = []

  for (const query of queries) {
    try {
      const result = await executeWebSearchTool({
        id: `search-${hits.length}`,
        name: 'web_search',
        arguments: { query },
      } as never)
      if (result.isError) {
        failures.push({ query, error: String(result.content).slice(0, 200) })
        continue
      }
      hits.push(...parseSearchText(query, String(result.content)))
    } catch (err) {
      failures.push({ query, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // 按 URL 去重，保留首条来源
  const seen = new Set<string>()
  const candidates = hits.filter((hit) => {
    const key = hit.url.replace(/\/$/, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return {
    content: JSON.stringify({
      product,
      markets,
      queriesExecuted: queries.length,
      candidateCount: candidates.length,
      candidates,
      failures: failures.length > 0 ? failures : undefined,
      nextSteps: [
        '对候选公司抽查用 sourcing_verify_company 抓官网核验（官网/运营国家/业务匹配/联系人）',
        '核验后再用 sourcing_score_lead 评分；未核验的保持"待核验"，不要当成已验证事实',
      ],
      note: candidates.length === 0
        ? '未获得候选结果；请确认已配置联网搜索凭据（设置 > Chat 工具 > 联网搜索）'
        : undefined,
    }, null, 2),
  }
}
