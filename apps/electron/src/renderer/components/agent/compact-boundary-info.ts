/**
 * 压缩边界信息提取 —— 纯函数
 *
 * compact_boundary system 消息由 Gravitas 压缩路径写入，携带摘要、
 * 被压缩消息条数与归档信息；SDK 原生压缩边界可能缺少这些字段，需容错。
 */

import type { SDKMessage } from '@gravitas/shared'

/** 压缩边界展示信息 */
export interface CompactBoundaryInfo {
  /** 压缩摘要文本（无则 null） */
  summary: string | null
  /** 被压缩的历史消息条数（未知则 null） */
  compactedCount: number | null
  /** 压缩前原文是否已归档到本地 */
  archived: boolean
}

export function extractCompactBoundaryInfo(message: SDKMessage): CompactBoundaryInfo {
  const raw = message as unknown as {
    summary?: unknown
    compactionSource?: { messageCount?: unknown; archiveFile?: unknown }
  }
  const summary = typeof raw.summary === 'string' && raw.summary.trim().length > 0
    ? raw.summary
    : null
  const source = raw.compactionSource
  const compactedCount = typeof source?.messageCount === 'number' && Number.isFinite(source.messageCount)
    ? source.messageCount
    : null
  const archived = typeof source?.archiveFile === 'string' && source.archiveFile.length > 0
  return { summary, compactedCount, archived }
}
