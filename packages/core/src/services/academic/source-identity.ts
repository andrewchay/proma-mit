/**
 * 来源身份与去重（M2，方案 §6.1）
 *
 * 纯函数、无 IO。UUID 是内部连接键；DOI/PMID/arXiv/ISBN 等是
 * 带命名空间的别名。去重分两级：
 * - exact-id：规范化后的外部标识精确命中 → 可提出自动合并候选
 * - similar-title：无标识但标题高度相似 → 只提示人工复核，
 *   绝不静默合并（标题相似 ≠ 同一篇）
 */

import type { ExternalId, ExternalIdNamespace, SourceVersion } from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'

/** 规范化单个外部标识值 */
export function normalizeExternalId(namespace: ExternalIdNamespace, value: string): string {
  const v = value.trim()
  switch (namespace) {
    case 'doi': {
      let d = v.toLowerCase()
      d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
      return d
    }
    case 'arxiv': {
      let a = v
      a = a.replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//, '')
      a = a.replace(/\.pdf$/i, '')
      a = a.replace(/v\d+$/i, '')
      return a.toLowerCase()
    }
    case 'isbn':
      return v.replace(/[-\s]/g, '').toLowerCase()
    default:
      return v.replace(/\s+/g, ' ').trim()
  }
}

/** 生成命名空间化的稳定键（doi:10.1234/abc） */
export function externalIdKey(id: ExternalId): string {
  return `${id.namespace}:${normalizeExternalId(id.namespace, id.value)}`
}

/** 构建规范化的 ExternalId */
export function makeExternalId(namespace: ExternalIdNamespace, value: string): ExternalId {
  return { namespace, value: normalizeExternalId(namespace, value) }
}

/** 归一化标题：小写、去标点、压缩空白 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 词级 Jaccard 相似度（简单、确定性、可解释） */
function titleSimilarity(a: string, b: string): number {
  const sa = new Set(normalizeTitle(a).split(' ').filter(Boolean))
  const sb = new Set(normalizeTitle(b).split(' ').filter(Boolean))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / (sa.size + sb.size - inter)
}

export type DedupKind = 'exact-id' | 'similar-title'

export interface DedupCandidate {
  kind: DedupKind
  versionIds: string[]
  sourceIds: string[]
  /** exact-id 的公共键 / similar-title 的相似度 */
  detail: string
}

export const SIMILAR_TITLE_THRESHOLD = 0.9

/**
 * 找出去重候选。
 *
 * exact-id 候选可由系统提出自动合并建议；similar-title 候选
 * 只用于人工复核队列，不改变任何数据。
 */
export function findDedupCandidates(versions: SourceVersion[]): DedupCandidate[] {
  const candidates: DedupCandidate[] = []

  // 1) 精确标识命中
  const byKey = new Map<string, SourceVersion[]>()
  for (const v of versions) {
    for (const id of v.externalIds ?? []) {
      const key = externalIdKey(id)
      const bucket = byKey.get(key) ?? []
      bucket.push(v)
      byKey.set(key, bucket)
    }
  }
  for (const [key, bucket] of byKey) {
    const uniq = dedupeBySource(bucket)
    if (uniq.length > 1) {
      candidates.push({
        kind: 'exact-id',
        versionIds: uniq.map((v) => v.id),
        sourceIds: uniq.map((v) => v.sourceId),
        detail: key,
      })
    }
  }

  // 2) 无标识版本间的标题相似（已有 exact-id 关系的不重复报）
  const exactPaired = new Set(
    candidates.flatMap((c) => c.versionIds),
  )
  const noId = versions.filter(
    (v) => (v.externalIds ?? []).length === 0 && !exactPaired.has(v.id),
  )
  for (let i = 0; i < noId.length; i++) {
    for (let j = i + 1; j < noId.length; j++) {
      const sim = titleSimilarity(noId[i]!.title, noId[j]!.title)
      if (sim >= SIMILAR_TITLE_THRESHOLD && noId[i]!.sourceId !== noId[j]!.sourceId) {
        candidates.push({
          kind: 'similar-title',
          versionIds: [noId[i]!.id, noId[j]!.id],
          sourceIds: [noId[i]!.sourceId, noId[j]!.sourceId],
          detail: `相似度 ${sim.toFixed(2)}（需人工复核）`,
        })
      }
    }
  }

  return candidates
}

/** 同一 source 内的多个版本不算重复 */
function dedupeBySource(bucket: SourceVersion[]): SourceVersion[] {
  const seenSource = new Set<string>()
  const out: SourceVersion[] = []
  for (const v of bucket) {
    if (!seenSource.has(v.sourceId)) {
      seenSource.add(v.sourceId)
      out.push(v)
    }
  }
  return out
}

/** 校验外部标识输入（拒绝空值） */
export function assertExternalId(id: ExternalId): void {
  if (!normalizeExternalId(id.namespace, id.value)) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `外部标识值不能为空（namespace: ${id.namespace}）`,
    )
  }
}
