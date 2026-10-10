/**
 * D02：词法/规则工具发现（无模型），按 token 预算从能力目录选择摘要子集。
 *
 * 只选择「给模型看哪些能力摘要」，不做权限决定；权限与 schema 投影仍是 D03 的执行边界。
 */

import { renderCapabilitySummary, type CapabilityCatalog } from '@gravitas/shared'

export interface ToolDiscoveryRequest {
  /** 任务文本；CJK 与拉丁混合均可。 */
  readonly query: string
  readonly catalog: CapabilityCatalog
  /** 摘要 token 预算；超出即截断。 */
  readonly tokenBudget: number
  /** 必须包含的能力 id；目录缺失时进入 requiredMissing。 */
  readonly requiredIds?: readonly string[]
}

export interface ToolDiscoveryResult {
  readonly selectedIds: readonly string[]
  /** 已按预算过滤的能力目录摘要，可直接注入系统提示词。 */
  readonly summary: string
  /** 因预算被截断的 id（升序）。 */
  readonly omittedByBudget: readonly string[]
  /** requiredIds 中目录不存在的 id（升序），不静默丢失。 */
  readonly requiredMissing: readonly string[]
  readonly tokensUsed: number
}

/** 轻量 token 估计：CJK 每字 1，拉丁每 4 字符 1。 */
export function estimateDiscoveryTokens(text: string): number {
  let cjk = 0
  let latin = 0
  for (const char of text) {
    if (/[　-鿿豈-﫿＀-￯]/.test(char)) cjk += 1
    else latin += 1
  }
  return cjk + Math.ceil(latin / 4)
}

/** 词法评分：查询子串与关键词命中；纯符号查询不伪造相关度。 */
function scoreDescriptor(query: string, haystack: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const hay = haystack.toLowerCase()
  let score = 0
  // 整句子串命中权重最高（CJK 友好）。
  if (hay.includes(q)) score += 10
  for (const token of q.split(/[\s,，。.;；:：!？?/\\|()（）]+/).filter((t) => t.length > 0)) {
    if (token.length >= 2 && hay.includes(token)) score += 3
  }
  return score
}

function descriptorHaystack(descriptor: { id: string; name: string; summary: string; serverName?: string }): string {
  return [descriptor.id, descriptor.name, descriptor.summary, descriptor.serverName ?? ''].join('\n')
}

export function discoverToolsForQuery(input: ToolDiscoveryRequest): ToolDiscoveryResult {
  if (!Number.isInteger(input.tokenBudget) || input.tokenBudget <= 0) throw new Error('tokenBudget 必须为正整数')
  const byId = new Map(input.catalog.descriptors.map((d) => [d.id, d]))
  const required = input.requiredIds ?? []
  const requiredMissing = required.filter((id) => !byId.has(id)).sort()

  const scored = input.catalog.descriptors.map((descriptor) => ({
    descriptor,
    score: scoreDescriptor(input.query, descriptorHaystack(descriptor)),
  }))
  const requiredSet = new Set(required)
  // 相关度降序，同分按 id 升序保证 byte-stable；required 始终排在被预算保留的前列。
  scored.sort((a, b) => (b.score - a.score) || a.descriptor.id.localeCompare(b.descriptor.id))

  const header = `## 可用能力目录（按任务筛选）\n\n以下为方向性描述；调用前按需加载完整参数 schema。`
  const selectedIds: string[] = []
  const omittedByBudget: string[] = []
  let tokensUsed = estimateDiscoveryTokens(header)
  const lineTokens = (id: string): number => {
    const descriptor = byId.get(id)!
    return estimateDiscoveryTokens(descriptor.id + descriptor.name + descriptor.summary + descriptor.serverName!)
  }
  for (const { descriptor } of scored) {
    const isRequired = requiredSet.has(descriptor.id)
    const line = lineTokens(descriptor.id)
    if (!isRequired && (tokensUsed + line > input.tokenBudget)) {
      omittedByBudget.push(descriptor.id)
      continue
    }
    // required 超出预算时也保留：不静默丢失比预算严格更重要。
    selectedIds.push(descriptor.id)
    tokensUsed += line
  }
  omittedByBudget.sort()
  const filtered: CapabilityCatalog = {
    version: 1,
    descriptors: selectedIds.map((id) => byId.get(id)!),
  }
  return {
    selectedIds,
    summary: renderCapabilitySummary(filtered),
    omittedByBudget,
    requiredMissing,
    tokensUsed,
  }
}
