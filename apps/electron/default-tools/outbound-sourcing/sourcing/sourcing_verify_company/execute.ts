/**
 * sourcing_verify_company — 官网核验（证据抽取，不做 LLM 判定）
 *
 * 对齐 Redvia 的 website_verify.py 抓取环节，但把"判定"交回 Agent：
 * 工具只返回客观证据（命中关键词、联系线索、国家提示、正文片段），
 * 避免把模型输出伪装成已验证事实。
 */
import { executeWebFetchTool } from '../../../../src/main/lib/agent-runtime/tool-impls/web-fetch-tool'

interface Input {
  company?: string
  website?: string
  product_keywords?: string[]
  target_country?: string
}

/** 采购/分销意图关键词（命中只作为证据，不等于判定结论） */
const BUY_INTENT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(importer|import)\b/i, '提及进口'],
  [/\b(distributor|wholesale|wholesaler|supplier|stockist)\b/i, '提及分销/批发'],
  [/\b(purchas(e|ing)|procurement|sourcing|supply chain)\b/i, '提及采购'],
  [/\b(OEM|private label|contract manufactur)/i, '提及 OEM/代工'],
  [/\b(contact|inquiry|get in touch|request a quote)\b/i, '提供联系/询价入口'],
]

function findMatches(text: string, patterns: Array<[RegExp, string]>): string[] {
  return patterns.filter(([re]) => re.test(text)).map(([, label]) => label)
}

function extractSnippets(text: string, keywords: string[], radius = 120): string[] {
  const snippets: string[] = []
  for (const keyword of keywords) {
    const index = text.toLowerCase().indexOf(keyword.toLowerCase())
    if (index === -1) continue
    const start = Math.max(0, index - radius)
    snippets.push(text.slice(start, Math.min(text.length, index + keyword.length + radius)).replace(/\s+/g, ' ').trim())
    if (snippets.length >= 3) break
  }
  return snippets
}

export async function execute(input: unknown): Promise<{ content: string; isError?: boolean }> {
  const v = (input ?? {}) as Input
  const company = String(v.company ?? '').trim()
  const website = String(v.website ?? '').trim()
  if (!company || !website) return { content: '参数缺失：company、website', isError: true }

  const productKeywords = (Array.isArray(v.product_keywords) ? v.product_keywords : []).map(String).filter(Boolean)
  const targetCountry = String(v.target_country ?? '').trim()

  const result = await executeWebFetchTool({ url: website }, { cwd: process.cwd(), sessionId: 'sourcing-verify' } as never)
  const fetched = !result.isError
  const pageText = fetched ? String(result.content) : ''

  if (!fetched) {
    return {
      content: JSON.stringify({
        company,
        website,
        fetched: false,
        error: String(result.content).slice(0, 300),
        evidence: null,
        note: '官网抓取失败：可能是站点拒绝抓取、URL 错误或网络问题。请人工打开确认后再判断。',
      }, null, 2),
    }
  }

  const buyIntentHits = findMatches(pageText, BUY_INTENT_PATTERNS)
  const categoryHits = productKeywords.filter((k) => pageText.toLowerCase().includes(k.toLowerCase()))
  const emailMatches = [...pageText.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)].map((m) => m[0]).slice(0, 5)
  const countryMentioned = targetCountry ? new RegExp(targetCountry, 'i').test(pageText) : null
  const titleMatch = pageText.match(/^\s*\*\*URL：\*\*.*\n+([^\n]+)/)

  return {
    content: JSON.stringify({
      company,
      website,
      fetched: true,
      evidence: {
        pageTitle: titleMatch?.[1]?.trim() ?? null,
        buyIntentHits,
        categoryKeywordHits: categoryHits,
        categoryKeywordsChecked: productKeywords,
        emailsFound: emailMatches,
        targetCountryMentioned: countryMentioned,
        snippets: extractSnippets(pageText, [...categoryHits, ...buyIntentHits]),
        textLength: pageText.length,
      },
      judgementReminder: [
        '以上只是抓取证据，不构成"该公司是真实买家"的结论；请结合证据在输出中明确区分已核验与待核验',
        '品类命中不等于采购该品类；国家未出现不等于不在目标市场运营',
        '将核验结果交给 sourcing_score_lead 时，逐项使用 has_website / verified_country / vertical_match 等字段',
      ],
    }, null, 2),
  }
}
