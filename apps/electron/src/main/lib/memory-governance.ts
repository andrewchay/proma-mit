/**
 * 记忆治理（纯函数层）：综述 §6.2 记忆演化的 Select + Maintain 两维。
 *
 * - Select（检索排序）：效用 × 新近度。效用先验来自写入审批时的 confidence；
 *   新近度按半衰期 30 天指数衰减。防"上下文膨胀"：低分条目自然沉底。
 * - Maintain（巩固与遗忘）：
 *   - 巩固：同 kind 且内容相似度 ≥ 阈值的条目合并（保留效用最高者，其余归档）。
 *   - 遗忘：低效用 + 超期条目**归档而非删除**（archivedAt 标记，可回滚）。
 *     防综述 Table 3 的"陈旧启发式"失效模式。
 *
 * 本模块只做纯计算，不触碰文件系统；状态读写由 memory-plugin-service 完成。
 */

import type { MemoryItem } from './memory-plugin-service'

// ===== Select：检索排序 =====

/** 新近度半衰期（天）：30 天前的条目新近度权重减半 */
export const RECENCY_HALF_LIFE_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/** 条目效用分（0..1）：优先 utilityScore，回退 confidence，缺省 0.5。 */
export function itemUtility(item: Pick<MemoryItem, 'utilityScore' | 'confidence'>): number {
  const u = item.utilityScore ?? item.confidence ?? 0.5
  return Math.max(0, Math.min(1, u))
}

/**
 * 检索排序分（纯函数）：效用 × 新近度。
 * 新近度基准时间取 lastUsedAt ?? updatedAt——被用过的条目更可能仍有效。
 */
export function computeRetrievalScore(
  item: Pick<MemoryItem, 'utilityScore' | 'confidence' | 'updatedAt' | 'lastUsedAt'>,
  now: number,
): number {
  const refTime = item.lastUsedAt ?? item.updatedAt
  const ageDays = Math.max(0, (now - refTime) / DAY_MS)
  const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
  return itemUtility(item) * recency
}

// ===== 相似度 =====

/**
 * 文本归一化 + 二元组（bigram）集合。
 * 中文无空格分词，用字符 bigram 对中英文都稳健。
 */
function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').replace(/\s+/g, ' ').trim()
  const compact = normalized.replace(/ /g, '')
  const set = new Set<string>()
  // 英文单词作为整体 token
  for (const word of normalized.split(' ')) {
    if (/^[a-z0-9]+$/.test(word) && word.length > 1) set.add(word)
  }
  // 全串字符 bigram（覆盖中文与英文子串）
  for (let i = 0; i < compact.length - 1; i++) {
    set.add(compact.slice(i, i + 2))
  }
  if (compact.length === 1) set.add(compact)
  return set
}

/** Jaccard 相似度（0..1）。 */
export function textSimilarity(a: string, b: string): number {
  const sa = bigrams(a)
  const sb = bigrams(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let intersection = 0
  for (const t of sa) {
    if (sb.has(t)) intersection++
  }
  return intersection / (sa.size + sb.size - intersection)
}

// ===== Maintain：巩固（合并） =====

export interface MergePlan {
  /** 保留的条目 id（组内检索分最高者） */
  survivorId: string
  /** 被合并并归档的条目 id 列表 */
  archivedIds: string[]
  /** 合并后的 tags 并集 */
  mergedTags: string[]
  /** 合并后的 confidence / utilityScore（取组内最大） */
  confidence: number
  utilityScore: number
}

export interface ConsolidationPlan {
  merges: MergePlan[]
  /** 遗忘归档（不属于任何合并组）：低效用 + 超期 */
  forgetArchiveIds: string[]
}

export interface ConsolidationOptions {
  /** 合并相似度阈值（默认 0.6） */
  similarityThreshold?: number
  /** 遗忘效用阈值（默认 0.3）：utility ≤ 该值才可能被归档 */
  utilityThreshold?: number
  /** 遗忘超期天数（默认 90）：距最后更新超过该天数才可能被归档 */
  maxAgeDays?: number
}

/** 永不自动遗忘的 kind（diary 是日志，只做追加保留） */
const FORGET_EXEMPT_KINDS = new Set(['diary'])

/**
 * 制定巩固 + 遗忘计划（纯函数）。
 *
 * 巩固：同 kind、未归档条目两两相似度 ≥ 阈值 → 贪心聚组；组内保留检索分最高者。
 * 遗忘：不在任何合并组内、非豁免 kind、utility ≤ 阈值且超期 → 归档。
 */
export function planConsolidation(
  items: MemoryItem[],
  now: number,
  opts: ConsolidationOptions = {},
): ConsolidationPlan {
  const similarityThreshold = opts.similarityThreshold ?? 0.6
  const utilityThreshold = opts.utilityThreshold ?? 0.3
  const maxAgeDays = opts.maxAgeDays ?? 90

  const active = items.filter((item) => !item.archivedAt)
  const mergedInto = new Set<string>() // 已被某组合并吃掉的 id
  const merges: MergePlan[] = []

  // 按 kind 分组，组内贪心聚类
  const byKind = new Map<string, MemoryItem[]>()
  for (const item of active) {
    const list = byKind.get(item.kind) ?? []
    list.push(item)
    byKind.set(item.kind, list)
  }

  for (const group of byKind.values()) {
    const visited = new Set<string>()
    for (const seed of group) {
      if (visited.has(seed.id)) continue
      const cluster = [seed]
      visited.add(seed.id)
      for (const other of group) {
        if (visited.has(other.id)) continue
        const sim = textSimilarity(`${seed.title}\n${seed.content}`, `${other.title}\n${other.content}`)
        if (sim >= similarityThreshold) {
          cluster.push(other)
          visited.add(other.id)
        }
      }
      if (cluster.length < 2) continue
      // 幸存者 = 检索分最高；同分取更新更近的
      const sorted = [...cluster].sort((a, b) => {
        const diff = computeRetrievalScore(b, now) - computeRetrievalScore(a, now)
        return diff !== 0 ? diff : b.updatedAt - a.updatedAt
      })
      const survivor = sorted[0]!
      const losers = sorted.slice(1)
      for (const l of losers) mergedInto.add(l.id)
      merges.push({
        survivorId: survivor.id,
        archivedIds: losers.map((l) => l.id),
        mergedTags: [...new Set(cluster.flatMap((c) => c.tags))],
        confidence: Math.max(...cluster.map((c) => c.confidence)),
        utilityScore: Math.max(...cluster.map((c) => itemUtility(c))),
      })
    }
  }

  // 遗忘：未被合并的低效用 + 超期条目
  const forgetArchiveIds: string[] = []
  for (const item of active) {
    if (mergedInto.has(item.id)) continue
    if (merges.some((m) => m.survivorId === item.id)) continue
    if (FORGET_EXEMPT_KINDS.has(item.kind)) continue
    const ageDays = (now - item.updatedAt) / DAY_MS
    if (itemUtility(item) <= utilityThreshold && ageDays >= maxAgeDays) {
      forgetArchiveIds.push(item.id)
    }
  }

  return { merges, forgetArchiveIds }
}
