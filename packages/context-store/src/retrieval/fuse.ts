/**
 * RRF（Reciprocal Rank Fusion）多路召回融合。
 *
 * 借鉴 mycontext 的 fuse.ts 设计：
 * - 各路分数不可比（LIKE 匹配度 / 向量余弦 / 图谱置信度），用排名代替分数
 * - RRF 公式：score = Σ 1/(k + rank_i)，k=60 是业界惯用值
 * - 天然偏好多路都认可的结果
 */

export interface RankedList {
  /** 这一路的名字，如 'fts' | 'graph' | 'vector' */
  source: string
  /** 按相关性降序的实体 id */
  ids: readonly string[]
  /** 该路耗时，进 debug */
  latencyMs?: number
}

export interface FusedHit {
  id: string
  score: number
  /** 命中它的路 + 在那一路里的排名（1-based） */
  hitBy: { source: string; rank: number }[]
}

const RRF_K = 60

export function fuseRrf(
  lists: readonly RankedList[],
  options: { topK?: number; k?: number } = {},
): FusedHit[] {
  const k = options.k ?? RRF_K
  const topK = options.topK ?? 20
  const accumulator = new Map<string, FusedHit>()

  for (const list of lists) {
    list.ids.forEach((id, index) => {
      const rank = index + 1
      const existing = accumulator.get(id)
      const contribution = 1 / (k + rank)
      if (existing === undefined) {
        accumulator.set(id, {
          id,
          score: contribution,
          hitBy: [{ source: list.source, rank }],
        })
        return
      }
      existing.score += contribution
      existing.hitBy.push({ source: list.source, rank })
    })
  }

  return [...accumulator.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      // 分数相同：被多路命中的更可信
      if (b.hitBy.length !== a.hitBy.length) return b.hitBy.length - a.hitBy.length
      // 最后按 id 排，保证确定性
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .slice(0, topK)
}

export interface RecallDebug {
  perSource: { source: string; count: number; latencyMs: number | null }[]
  fusedCount: number
}

export function buildRecallDebug(
  lists: readonly RankedList[],
  fused: readonly FusedHit[],
): RecallDebug {
  return {
    perSource: lists.map((list) => ({
      source: list.source,
      count: list.ids.length,
      latencyMs: list.latencyMs ?? null,
    })),
    fusedCount: fused.length,
  }
}
