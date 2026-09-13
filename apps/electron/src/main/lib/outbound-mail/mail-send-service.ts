/**
 * 出海 Sourcing 邮件发送服务 — Mail Send Service（审批制）
 *
 * 状态机：draft → approved → sent；draft → rejected / failed
 * - 入队（draft）：Agent 工具或 UI 均可
 * - 发送：只有 approved 状态的邮件才会经 SMTP 发出；approve + send 是同一原子操作
 * - 审计：每次状态变化追加 mail-audit.jsonl 摘要（不含正文）
 *
 * 安全边界：这是全应用唯一允许发出邮件的路径；Agent 无法绕过审批。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import nodemailer from 'nodemailer'
import type { OutboundOutboxItem } from '@gravitas/shared'
import { getConfigDir } from '../config-paths'
import { resolveMailCredentials } from './mailbox-config-service'
import { markInboxHandled } from './mail-sync-service'

const MAIL_DIR = () => join(getConfigDir(), 'outbound-sourcing', 'mail')
const OUTBOX_PATH = () => join(MAIL_DIR(), 'outbox.jsonl')
const AUDIT_PATH = () => join(getConfigDir(), 'outbound-sourcing', 'mail-audit.jsonl')

let outbox: OutboundOutboxItem[] | null = null
/** 已加载队列对应的配置目录；配置目录变化时重新加载 */
let loadedFromDir: string | null = null

function ensureLoaded(): void {
  const dir = (() => {
    try { return getConfigDir() } catch { return '' }
  })()
  if (outbox && loadedFromDir === dir) return
  loadedFromDir = dir
  outbox = []
  const path = OUTBOX_PATH()
  if (!existsSync(path)) return
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n').filter(Boolean)) {
      try { outbox.push(JSON.parse(line) as OutboundOutboxItem) } catch { /* 跳过坏行 */ }
    }
  } catch (error) {
    console.warn('[出海邮件] 待发队列加载失败:', error)
  }
}

function persistAll(): void {
  const path = OUTBOX_PATH()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, outbox!.map((i) => JSON.stringify(i)).join('\n') + (outbox!.length ? '\n' : ''), 'utf-8')
  renameSync(tmp, path)
}

function appendAudit(entry: Record<string, unknown>): void {
  try {
    const path = AUDIT_PATH()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf-8')
  } catch (error) {
    console.warn('[出海邮件] 审计写入失败:', error)
  }
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 读取全部待发队列 */
export function loadOutboxItems(): OutboundOutboxItem[] {
  ensureLoaded()
  return [...outbox!].sort((a, b) => b.createdAt - a.createdAt)
}

/** 入队一封待发邮件（Agent 工具与 UI 共用）；只入队，不发送 */
export function queueEmail(input: {
  to: string
  subject: string
  body: string
  inReplyTo?: string | null
  references?: string[]
  source?: 'agent' | 'manual'
  replyToInboxId?: string | null
}): OutboundOutboxItem {
  ensureLoaded()
  const to = input.to?.trim()
  const subject = input.subject?.trim()
  const body = input.body?.trim()
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('收件人地址无效')
  if (!subject) throw new Error('主题不能为空')
  if (!body) throw new Error('正文不能为空')

  const item: OutboundOutboxItem = {
    id: newId('out'),
    to,
    subject,
    body,
    inReplyTo: input.inReplyTo?.trim() || null,
    references: (input.references ?? []).map(String).filter(Boolean),
    status: 'draft',
    source: input.source ?? 'agent',
    replyToInboxId: input.replyToInboxId ?? null,
    createdAt: Date.now(),
    decidedAt: null,
    decisionNote: null,
    sentMessageId: null,
    error: null,
  }
  outbox!.push(item)
  persistAll()
  appendAudit({ action: 'queue', id: item.id, to, subject, source: item.source })
  return { ...item }
}

/** 人工确认并发送（唯一发送路径）；正文以确认时编辑后的版本为准 */
export async function approveAndSend(id: string, edited?: { to?: string; subject?: string; body?: string }): Promise<OutboundOutboxItem> {
  ensureLoaded()
  const item = outbox!.find((i) => i.id === id)
  if (!item) throw new Error('待发邮件不存在')
  if (item.status !== 'draft') throw new Error(`状态为 ${item.status} 的邮件不能发送`)

  // 应用人工编辑（可在审批卡中修改收件人/主题/正文）
  if (edited?.to?.trim()) item.to = edited.to.trim()
  if (edited?.subject?.trim()) item.subject = edited.subject.trim()
  if (edited?.body?.trim()) item.body = edited.body.trim()

  const { config, password } = resolveMailCredentials()
  item.status = 'approved'
  item.decidedAt = Date.now()

  try {
    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpTls,
      auth: { user: config.email, pass: password },
      connectionTimeout: 20_000,
    })
    const info = await transporter.sendMail({
      from: `"${config.fromName}" <${config.email}>`,
      to: item.to,
      subject: item.subject,
      text: item.body,
      inReplyTo: item.inReplyTo ?? undefined,
      references: item.references.length > 0 ? item.references.join(' ') : undefined,
    })
    item.status = 'sent'
    item.sentMessageId = info.messageId ?? `<local-${item.id}>`
    item.error = null
    appendAudit({ action: 'send', id: item.id, to: item.to, subject: item.subject, messageId: item.sentMessageId })
    console.log(`[出海邮件] 已发送: ${item.id} → ${item.to}`)
  } catch (err) {
    item.status = 'failed'
    item.error = err instanceof Error ? err.message : String(err)
    appendAudit({ action: 'send_failed', id: item.id, to: item.to, subject: item.subject, error: item.error })
    console.warn(`[出海邮件] 发送失败: ${item.id}`, item.error)
  } finally {
    persistAll()
  }

  // 回复场景：标记来信已处理
  if (item.status === 'sent' && item.replyToInboxId) markInboxHandled(item.replyToInboxId, true)

  return { ...item }
}

/** 驳回待发邮件 */
export function rejectEmail(id: string, note?: string): OutboundOutboxItem {
  ensureLoaded()
  const item = outbox!.find((i) => i.id === id)
  if (!item) throw new Error('待发邮件不存在')
  if (item.status !== 'draft') throw new Error(`状态为 ${item.status} 的邮件不能驳回`)
  item.status = 'rejected'
  item.decidedAt = Date.now()
  item.decisionNote = note?.trim() || null
  persistAll()
  appendAudit({ action: 'reject', id: item.id, to: item.to, subject: item.subject, note: item.decisionNote })
  return { ...item }
}

/** 查询某公司/线程的邮件往来状态（供 Agent 工具） */
export function getMailStatus(query: { companyEmail?: string; threadMailId?: string }): Array<Pick<OutboundOutboxItem, 'id' | 'to' | 'subject' | 'status' | 'createdAt' | 'sentMessageId'>> {
  ensureLoaded()
  return outbox!
    .filter((i) => {
      if (query.companyEmail && i.to.toLowerCase() === query.companyEmail.toLowerCase()) return true
      if (query.threadMailId && i.id === query.threadMailId) return true
      return false
    })
    .map(({ id, to, subject, status, createdAt, sentMessageId }) => ({ id, to, subject, status, createdAt, sentMessageId }))
    .sort((a, b) => b.createdAt - a.createdAt)
}
