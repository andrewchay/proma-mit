/**
 * 出海 Sourcing 邮件同步服务 — Mail Sync Service
 *
 * 职责：
 * - 经 IMAP 拉取最近来信，解析为收件箱条目（mailparser）
 * - 线程匹配：References/In-Reply-To 命中已发送邮件 → 归类 outreach_reply，否则 new_inbound
 * - 追加式存储 inbox.jsonl（幂等：按 messageId 去重）
 * - 可选定时同步（配置 syncIntervalMinutes > 0 时启用）
 *
 * 设计约束：
 * - 同步不修改邮箱已读状态（避免干扰用户其他客户端）
 * - 失败显式返回错误，不做静默重试
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import type {
  OutboundInboxItem,
  OutboundInboxListResult,
  OutboundInboxQuery,
  OutboundSyncResult,
} from '@gravitas/shared'
import { getConfigDir } from '../config-paths'
import { resolveMailCredentials } from './mailbox-config-service'

const MAIL_DIR = () => join(getConfigDir(), 'outbound-sourcing', 'mail')
const INBOX_PATH = () => join(MAIL_DIR(), 'inbox.jsonl')

/** 内存索引（启动时从 JSONL 加载） */
let inboxIndex: OutboundInboxItem[] = []
let indexLoaded = false
/** 已加载索引对应的配置目录；配置目录变化时重新加载（测试隔离与多环境切换） */
let loadedFromDir: string | null = null
let lastSyncedAt: number | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null

function currentConfigDir(): string {
  try {
    return getConfigDir()
  } catch {
    return ''
  }
}

function ensureLoaded(): void {
  const dir = currentConfigDir()
  if (indexLoaded && loadedFromDir === dir) return
  // 配置目录变化（如测试隔离）时重建索引
  indexLoaded = true
  loadedFromDir = dir
  inboxIndex = []
  lastSyncedAt = null
  const path = INBOX_PATH()
  if (!existsSync(path)) return
  try {
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const item = JSON.parse(line) as OutboundInboxItem
        inboxIndex.push(item)
        lastSyncedAt = Math.max(lastSyncedAt ?? 0, item.receivedAt)
      } catch { /* 跳过坏行 */ }
    }
  } catch (error) {
    console.warn('[出海邮件] 收件箱索引加载失败:', error)
  }
}

function persistItem(item: OutboundInboxItem): void {
  const path = INBOX_PATH()
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(item) + '\n', 'utf-8')
}

function makeSnippet(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}

/** 解析 ParsedMail → 收件箱条目（正文完整保留在本地 JSONL） */
async function parseMail(parsed: ParsedMail, category: OutboundInboxItem['category'], threadMailId: string | null): Promise<OutboundInboxItem | null> {
  const from = parsed.from?.value?.[0]
  if (!from?.address) return null
  const text = parsed.text ?? (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : '')
  const messageId = parsed.messageId ?? `<local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}>`
  return {
    id: `in-${Buffer.from(messageId).toString('base64url').slice(0, 24)}`,
    messageId,
    fromEmail: from.address,
    fromName: from.name ?? '',
    subject: parsed.subject ?? '(no subject)',
    snippet: makeSnippet(text),
    text: text.trim(),
    html: typeof parsed.html === 'string' ? parsed.html : null,
    receivedAt: parsed.date ? parsed.date.getTime() : Date.now(),
    category,
    threadMailId,
    handled: false,
  }
}

/** 与已发送邮件做线程匹配：优先 In-Reply-To/References 命中 messageId，其次主题 Re: 匹配 */
function matchThread(parsed: ParsedMail, sentIndex: Map<string, { id: string }>): { category: OutboundInboxItem['category']; threadMailId: string | null } {
  const refs: string[] = []
  if (parsed.inReplyTo) refs.push(parsed.inReplyTo)
  if (parsed.references) {
    for (const r of Array.isArray(parsed.references) ? parsed.references : [parsed.references]) refs.push(r)
  }
  for (const ref of refs) {
    const hit = sentIndex.get(ref.trim())
    if (hit) return { category: 'outreach_reply', threadMailId: hit.id }
  }
  const subject = (parsed.subject ?? '').trim()
  if (/^re:/i.test(subject)) {
    // 回复但无法定位原邮件：仍视为外联回信，线程 id 置空
    return { category: 'outreach_reply', threadMailId: null }
  }
  return { category: 'new_inbound', threadMailId: null }
}

/** 加载已发送邮件的 messageId → 队列 id 映射（供线程匹配） */
function buildSentIndex(): Map<string, { id: string }> {
  const map = new Map<string, { id: string }>()
  try {
    const { loadOutboxItems } = require('./mail-send-service') as typeof import('./mail-send-service')
    for (const item of loadOutboxItems()) {
      if (item.status === 'sent' && item.sentMessageId) map.set(item.sentMessageId, { id: item.id })
    }
  } catch { /* 发送服务不可用时跳过匹配 */ }
  return map
}

/**
 * 执行一次 IMAP 同步：拉取 INBOX 最近 limit 封，按 messageId 幂等入库。
 */
export async function syncInboxNow(limit = 50): Promise<OutboundSyncResult> {
  ensureLoaded()
  const syncedAt = Date.now()
  let config, password
  try {
    ;({ config, password } = resolveMailCredentials())
  } catch (err) {
    return { ok: false, fetched: 0, newItems: 0, error: err instanceof Error ? err.message : String(err), syncedAt }
  }

  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapTls,
    auth: { user: config.email, pass: password },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
  })

  let fetched = 0
  let newItems = 0
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      // 取最近的邮件序列号区间
      const mailbox = client.mailbox
      const exists = typeof mailbox === 'object' && mailbox ? (mailbox as { exists: number }).exists : 0
      if (exists > 0) {
        const start = Math.max(1, exists - limit + 1)
        const sentIndex = buildSentIndex()
        for await (const msg of client.fetch(`${start}:${exists}`, { envelope: true, source: true, uid: true })) {
          fetched += 1
          try {
            if (!msg.source) continue
            const parsed = await simpleParser(msg.source)
            const messageId = parsed.messageId ?? `uid-${msg.uid}`
            if (inboxIndex.some((i) => i.messageId === messageId)) continue
            const { category, threadMailId } = matchThread(parsed, sentIndex)
            const item = await parseMail(parsed, category, threadMailId)
            if (!item) continue
            inboxIndex.push(item)
            persistItem(item)
            newItems += 1
          } catch (err) {
            console.warn('[出海邮件] 解析来信失败:', err)
          }
        }
      }
    } finally {
      lock.release()
    }
    lastSyncedAt = syncedAt
    return { ok: true, fetched, newItems, error: null, syncedAt }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[出海邮件] IMAP 同步失败:', message)
    return { ok: false, fetched, newItems, error: message, syncedAt }
  } finally {
    try { client.close() } catch { /* 忽略 */ }
  }
}

/** 查询收件箱（视图只含完整正文给 UI；Agent 工具走 listInboxSummaries） */
export function listInbox(query: OutboundInboxQuery = {}): OutboundInboxListResult {
  ensureLoaded()
  let items = [...inboxIndex]
  if (query.category) items = items.filter((i) => i.category === query.category)
  if (query.unhandledOnly) items = items.filter((i) => !i.handled)
  items.sort((a, b) => b.receivedAt - a.receivedAt)
  const total = items.length
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  return { items: items.slice(0, limit), total, lastSyncedAt }
}

/** Agent 工具用的摘要视图（无正文与 HTML，防止上下文膨胀） */
export function listInboxSummaries(query: OutboundInboxQuery = {}): Array<Pick<OutboundInboxItem, 'id' | 'fromEmail' | 'fromName' | 'subject' | 'snippet' | 'receivedAt' | 'category' | 'handled'>> {
  return listInbox(query).items.map(({ id, fromEmail, fromName, subject, snippet, receivedAt, category, handled }) => ({
    id, fromEmail, fromName, subject, snippet, receivedAt, category, handled,
  }))
}

/** 读取单封来信完整内容（供 Agent 回复起草） */
export function getInboxItem(id: string): OutboundInboxItem | null {
  ensureLoaded()
  return inboxIndex.find((i) => i.id === id) ?? null
}

/** 标记来信已处理（如已起草回复） */
export function markInboxHandled(id: string, handled = true): boolean {
  ensureLoaded()
  const item = inboxIndex.find((i) => i.id === id)
  if (!item) return false
  item.handled = handled
  persistItem({ ...item })
  return true
}

/** 启动/停止定时同步（分钟间隔；0 或空 = 停止） */
export function setSyncInterval(minutes: number): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  const valid = Math.max(0, Math.floor(minutes))
  if (valid > 0) {
    syncTimer = setInterval(() => {
      void syncInboxNow().then((result) => {
        if (!result.ok) console.warn(`[出海邮件] 定时同步失败: ${result.error}`)
      })
    }, valid * 60_000)
    console.log(`[出海邮件] 定时同步已开启：每 ${valid} 分钟`)
  }
}
