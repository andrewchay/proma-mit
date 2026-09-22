/**
 * M5-01 可逆 compaction 元数据契约。
 *
 * 元数据可持久化、可读取；原始 ledger 永不因 compaction 删除，
 * 因此任意视图都可以凭 metadata + 原始 ledger 重建。
 */

import { createHash } from 'node:crypto'

export interface CompactMetadata {
  version: 1
  /** 重建时的 ledger 版本；ledger 变更后 metadata 失效。 */
  sourceRevision: string
  /** 产生该视图的 policy 标识（稳定 JSON 指纹或 'none'）。 */
  policyId: string
  retainedItemIds: string[]
  omittedItemIds: string[]
  /** 摘要派生版本；policy/渲染升级时 +1。 */
  summaryVersion: number
  tokenEstimate: number
  createdAt: string
}

export function serializeCompactMetadata(metadata: CompactMetadata): string {
  validateCompactMetadata(metadata)
  return JSON.stringify(metadata, null, 2)
}

export function parseCompactMetadata(text: string): CompactMetadata {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('compact metadata is not valid JSON')
  }
  validateCompactMetadata(value)
  return value as CompactMetadata
}

export function validateCompactMetadata(value: unknown): void {
  const failures: string[] = []
  if (!isRecord(value)) throw new Error('compact metadata must be an object')
  if (value.version !== 1) failures.push('version must be 1')
  if (!isNonEmptyString(value.sourceRevision)) failures.push('sourceRevision must be a non-empty string')
  if (!isNonEmptyString(value.policyId)) failures.push('policyId must be a non-empty string')
  if (!isStringArray(value.retainedItemIds)) failures.push('retainedItemIds must be string[]')
  if (!isStringArray(value.omittedItemIds)) failures.push('omittedItemIds must be string[]')
  if (!isPositiveInt(value.summaryVersion)) failures.push('summaryVersion must be a positive integer')
  if (!isNonNegativeInt(value.tokenEstimate)) failures.push('tokenEstimate must be a non-negative integer')
  if (!isNonEmptyString(value.createdAt) || Number.isNaN(Date.parse(value.createdAt))) failures.push('createdAt must be an ISO timestamp')
  if (failures.length > 0) throw new Error(`invalid compact metadata: ${failures.join('; ')}`)
}

export function compactMetadataPolicyId(policy: unknown): string {
  if (policy === undefined) return 'none'
  // 键序无关的稳定序列化：同语义 policy 必须得到同一指纹。
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
