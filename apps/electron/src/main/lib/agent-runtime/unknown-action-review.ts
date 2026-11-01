import type { PendingUnknownActionSummary } from '@gravitas/shared'
import type { UnknownActionRecord } from './unknown-action-store'

/** 只向设置页暴露待核对动作的必要索引，不返回参数、指纹或错误内容。 */
export function summarizePendingUnknownActions(records: UnknownActionRecord[]): PendingUnknownActionSummary[] {
  return records.map(({ id, sessionId, tool, createdAt, acknowledgedAt, interruptedAt }) => ({
    id,
    sessionId,
    tool,
    createdAt,
    ...(acknowledgedAt ? { acknowledgedAt } : {}),
    ...(interruptedAt ? { interruptedAt } : {}),
  }))
}
