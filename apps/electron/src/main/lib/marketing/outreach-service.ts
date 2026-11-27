/**
 * 达人触达记录服务（建联闭环）。
 *
 * 职责：记录「给谁、通过什么渠道、发了什么话术、跟到哪一步」。
 * 存储复用 campaign-database.sqlite 的 outreach_records 表（见 campaign-manager 建表处），
 * 不新建数据库文件，保持本地优先、可移植的约定。
 *
 * 设计边界：
 * - 本服务只做记录，不做真实发送。发送由各渠道适配器负责（微信/蒲公英/邮件）。
 * - channel='copy' 表示「只生成话术、用户自己复制去发」，无需任何外部依赖。
 */

import type {
  CreateOutreachRecordInput,
  ListOutreachRecordsInput,
  OutreachRecord,
  OutreachStatus,
  UpdateOutreachRecordInput,
} from '@gravitas/shared'
import { getDb } from '../campaign-manager'

/** 生成触达记录 ID */
function generateOutreachId(): string {
  return `outreach_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/** 行数据 → OutreachRecord */
function rowToOutreachRecord(row: Record<string, unknown>): OutreachRecord {
  return {
    id: String(row.id),
    kolId: row.kol_id ? String(row.kol_id) : null,
    kolName: String(row.kol_name),
    campaignId: row.campaign_id ? String(row.campaign_id) : null,
    channel: String(row.channel) as OutreachRecord['channel'],
    content: String(row.content),
    status: String(row.status) as OutreachStatus,
    note: row.note ? String(row.note) : null,
    sentAt: row.sent_at ? Number(row.sent_at) : null,
    repliedAt: row.replied_at ? Number(row.replied_at) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 创建一条触达记录 */
export function createOutreachRecord(input: CreateOutreachRecordInput): OutreachRecord {
  const db = getDb()
  const now = Date.now()
  const id = generateOutreachId()
  const status: OutreachStatus = input.status ?? 'pending'
  // 标记为已发送时补 sentAt，避免调用方每次都要自己传
  const sentAt = status === 'sent' || status === 'replied' || status === 'converted' ? now : null

  db.run(
    `INSERT INTO outreach_records (
      id, kol_id, kol_name, campaign_id, channel, content, status, note,
      sent_at, replied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.kolId ?? null,
    input.kolName,
    input.campaignId ?? null,
    input.channel,
    input.content,
    status,
    input.note ?? null,
    sentAt,
    null,
    now,
    now,
  )

  const created = getOutreachRecord(id)
  if (!created) {
    throw new Error('触达记录创建后读取失败')
  }
  return created
}

/** 获取单条记录 */
export function getOutreachRecord(id: string): OutreachRecord | null {
  const db = getDb()
  const row = db.query(`SELECT * FROM outreach_records WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return row ? rowToOutreachRecord(row) : null
}

/** 列出触达记录（按创建时间倒序） */
export function listOutreachRecords(input: ListOutreachRecordsInput = {}): OutreachRecord[] {
  const db = getDb()
  const conditions: string[] = []
  const params: unknown[] = []

  if (input.kolId) {
    conditions.push('kol_id = ?')
    params.push(input.kolId)
  }
  if (input.campaignId) {
    conditions.push('campaign_id = ?')
    params.push(input.campaignId)
  }
  if (input.status) {
    conditions.push('status = ?')
    params.push(input.status)
  }
  if (input.channel) {
    conditions.push('channel = ?')
    params.push(input.channel)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000)

  const rows = db
    .query(`SELECT * FROM outreach_records ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[]

  return rows.map(rowToOutreachRecord)
}

/** 更新触达记录（状态流转 / 修改话术 / 备注） */
export function updateOutreachRecord(input: UpdateOutreachRecordInput): OutreachRecord {
  const db = getDb()
  const existing = getOutreachRecord(input.id)
  if (!existing) {
    throw new Error(`触达记录不存在: ${input.id}`)
  }

  const now = Date.now()
  const fields: string[] = []
  const values: unknown[] = []

  if (input.status !== undefined) {
    fields.push('status = ?')
    values.push(input.status)
    // 进入「已发送」及之后的状态时补 sentAt（仅首次）
    if (
      !existing.sentAt &&
      (input.status === 'sent' || input.status === 'replied' || input.status === 'converted')
    ) {
      fields.push('sent_at = ?')
      values.push(now)
    }
    // 进入「已回复」及之后的状态时补 repliedAt（仅首次）
    if (!existing.repliedAt && (input.status === 'replied' || input.status === 'converted')) {
      fields.push('replied_at = ?')
      values.push(now)
    }
  }
  if (input.content !== undefined) {
    fields.push('content = ?')
    values.push(input.content)
  }
  if (input.note !== undefined) {
    fields.push('note = ?')
    values.push(input.note)
  }
  if (input.sentAt !== undefined) {
    fields.push('sent_at = ?')
    values.push(input.sentAt)
  }
  if (input.repliedAt !== undefined) {
    fields.push('replied_at = ?')
    values.push(input.repliedAt)
  }

  if (fields.length === 0) return existing

  fields.push('updated_at = ?')
  values.push(now)
  values.push(input.id)

  db.run(`UPDATE outreach_records SET ${fields.join(', ')} WHERE id = ?`, ...values)

  const updated = getOutreachRecord(input.id)
  if (!updated) {
    throw new Error('触达记录更新后读取失败')
  }
  return updated
}

/** 删除触达记录 */
export function deleteOutreachRecord(id: string): { success: boolean } {
  const db = getDb()
  db.run(`DELETE FROM outreach_records WHERE id = ?`, id)
  return { success: true }
}

/** 触达统计（面板顶部指标） */
export interface OutreachStats {
  total: number
  byStatus: Record<OutreachStatus, number>
  byChannel: Record<string, number>
  /** 回复率 = (replied + converted) / (sent + replied + rejected + converted)，无发送记录时为 0 */
  replyRate: number
}

export function getOutreachStats(campaignId?: string): OutreachStats {
  const records = listOutreachRecords({ campaignId, limit: 1000 })

  const byStatus: Record<OutreachStatus, number> = {
    pending: 0,
    sent: 0,
    replied: 0,
    rejected: 0,
    converted: 0,
  }
  const byChannel: Record<string, number> = {}

  for (const record of records) {
    byStatus[record.status] = (byStatus[record.status] ?? 0) + 1
    byChannel[record.channel] = (byChannel[record.channel] ?? 0) + 1
  }

  const sentTotal = byStatus.sent + byStatus.replied + byStatus.rejected + byStatus.converted
  const repliedTotal = byStatus.replied + byStatus.converted
  const replyRate = sentTotal > 0 ? repliedTotal / sentTotal : 0

  return {
    total: records.length,
    byStatus,
    byChannel,
    replyRate,
  }
}
