/**
 * M5-02 可逆 compaction：从原始 ledger 重建视图。
 *
 * 重建只读 ledger、不改写任何原始事实；同一输入必须产出等价（byte-stable）的视图，
 * 且 metadata 记录 retained/omitted 以便追溯。
 */
import type { CompactMetadata } from '@gravitas/shared'
import type { ContextItem, ContextProjection, ContextProjectionRequest } from '@gravitas/shared'
import { createHash } from 'node:crypto'
import { compileContextProjection } from './context-projector'

/** 键序无关的稳定 policy 指纹；同语义 policy 必须得到同一 id（main 进程内可用 node:crypto）。 */
export function compactMetadataPolicyId(policy: unknown): string {
  if (policy === undefined) return 'none'
  const digest = createHash('sha256').update(stableStringify(policy)).digest('hex')
  return `sha256:${digest.slice(0, 16)}`
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export interface RebuiltCompactionView {
  projection: ContextProjection
  metadata: CompactMetadata
}

export function rebuildCompactionView(input: {
  request: ContextProjectionRequest
  items: readonly ContextItem[]
  sourceRevision: string
  summaryVersion?: number
  now?: () => string
}): RebuiltCompactionView {
  // 只读消费：复制一层，杜绝投影过程改写 ledger 条目。
  const items = input.items.map((item) => ({ ...item }))
  const projection = compileContextProjection({
    request: input.request,
    items,
    sourceRevision: input.sourceRevision,
  })
  const now = input.now ?? (() => new Date().toISOString())
  const metadata: CompactMetadata = {
    version: 1,
    sourceRevision: input.sourceRevision,
    policyId: compactMetadataPolicyId(input.request.policy),
    retainedItemIds: projection.items.map((entry) => entry.itemId),
    omittedItemIds: [...projection.omittedItemIds],
    summaryVersion: input.summaryVersion ?? 1,
    tokenEstimate: projection.tokenEstimate,
    createdAt: now(),
  }
  return { projection, metadata }
}
