/**
 * 出海外联漏斗指标服务 — Outreach Metrics Service
 *
 * 数据源（本地权威）：mail/outbox.jsonl（外联与回复发送）+ mail/inbox.jsonl（来信）
 * 计算：外联数、回复数、回复率、平均首次回复时延、按公司维度明细。
 *
 * 说明：这里衡量的是"送达后是否收到回复"（本地可确证的部分），
 * 不包含邮件打开/链接点击（那需要公网跟踪端点）。
 */

import type { OutboundOutboxItem } from '@gravitas/shared'
import { loadOutboxItems } from './mail-send-service'
import { listInbox } from './mail-sync-service'

export interface OutreachFunnelCompany {
  email: string
  /** 已发出的外联/回复数 */
  sent: number
  /** 收到的回信数 */
  replies: number
  /** 首次发出时间 */
  firstSentAt: number | null
  /** 首次回信时间 */
  firstReplyAt: number | null
  /** 首次回复时延（毫秒；无回复为 null） */
  firstReplyLatencyMs: number | null
  /** 待确认队列中的数量 */
  pending: number
}

export interface OutreachMetrics {
  /** 已发送邮件总数 */
  sent: number
  /** 待确认（draft）数量 */
  pending: number
  /** 发送失败数量 */
  failed: number
  /** 收到回信的公司数 */
  repliedCompanies: number
  /** 触达公司数（有发出邮件的不同收件人） */
  contactedCompanies: number
  /** 回信总是数（外联回信 + 新来信） */
  replies: number
  /** 回复率 = 有回复公司数 / 触达公司数 */
  replyRate: number
  /** 平均首次回复时延（毫秒；无样本为 null） */
  averageFirstReplyLatencyMs: number | null
  companies: OutreachFunnelCompany[]
  generatedAt: number
}

/** 计算本地外联漏斗指标 */
export function computeOutreachMetrics(): OutreachMetrics {
  const outbox: OutboundOutboxItem[] = loadOutboxItems()
  const sentItems = outbox.filter((i) => i.status === 'sent')
  const inbox = listInbox({ limit: 200 }).items

  const byEmail = new Map<string, OutreachFunnelCompany>()
  const ensure = (email: string): OutreachFunnelCompany => {
    const key = email.toLowerCase()
    let entry = byEmail.get(key)
    if (!entry) {
      entry = { email, sent: 0, replies: 0, firstSentAt: null, firstReplyAt: null, firstReplyLatencyMs: null, pending: 0 }
      byEmail.set(key, entry)
    }
    return entry
  }

  for (const item of outbox) {
    const entry = ensure(item.to)
    if (item.status === 'sent') {
      entry.sent += 1
      if (entry.firstSentAt === null || item.createdAt < entry.firstSentAt) entry.firstSentAt = item.createdAt
    } else if (item.status === 'draft') {
      entry.pending += 1
    }
  }

  let replies = 0
  for (const mail of inbox) {
    const entry = ensure(mail.fromEmail)
    entry.replies += 1
    replies += 1
    if (entry.firstReplyAt === null || mail.receivedAt < entry.firstReplyAt) entry.firstReplyAt = mail.receivedAt
  }

  const companies = [...byEmail.values()].map((entry) => {
    const latency = entry.firstSentAt !== null && entry.firstReplyAt !== null && entry.firstReplyAt >= entry.firstSentAt
      ? entry.firstReplyAt - entry.firstSentAt
      : null
    return { ...entry, firstReplyLatencyMs: latency }
  })

  const repliedCompanies = companies.filter((c) => c.replies > 0).length
  const contactedCompanies = companies.filter((c) => c.sent > 0).length
  const latencies = companies.map((c) => c.firstReplyLatencyMs).filter((v): v is number => v !== null)

  return {
    sent: sentItems.length,
    pending: outbox.filter((i) => i.status === 'draft').length,
    failed: outbox.filter((i) => i.status === 'failed').length,
    contactedCompanies,
    repliedCompanies,
    replies,
    replyRate: contactedCompanies > 0 ? repliedCompanies / contactedCompanies : 0,
    averageFirstReplyLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    companies: companies.sort((a, b) => (b.firstReplyAt ?? b.firstSentAt ?? 0) - (a.firstReplyAt ?? a.firstSentAt ?? 0)),
    generatedAt: Date.now(),
  }
}
