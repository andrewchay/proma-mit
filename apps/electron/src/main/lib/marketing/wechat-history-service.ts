/**
 * 微信对话历史存储。
 *
 * 为什么需要：OCR 每次只能读到「当前可见的最近 N 条」，
 * 没有历史就无法判断「这条达人消息回过没有」「这是第几轮」「上次聊到哪」。
 *
 * 去重策略：以 (contact, content_hash) 唯一索引保证同一条消息只落一次。
 * content_hash = sha1(direction + '\u0000' + text)，方向参与哈希，
 * 避免达人复述我方原话时被误判为同一条。
 *
 * 隐私边界：只存对话文本，不存截图。用户可在设置里清空（见 clearConversation）。
 */

import { createHash } from 'node:crypto'
import type { WechatMessage } from './wechat-readonly-service'
import { getDb } from '../campaign-manager'

/** 一条已存储的对话消息 */
export interface StoredWechatMessage {
  id: string
  contact: string
  direction: 'in' | 'out'
  content: string
  /** 在对话中的顺序（越大越新） */
  msgOrder: number
  /** 我方是否已回复过（仅对 direction='in' 有意义） */
  replied: boolean
  createdAt: number
}

/** 对话摘要（列表页用） */
export interface WechatConversationSummary {
  contact: string
  lastSyncedAt: number | null
  lastMessageAt: number | null
  messageCount: number
  /** 未回复的达人消息数 */
  pendingCount: number
}

/** 计算内容指纹 */
function hashMessage(direction: string, content: string): string {
  return createHash('sha1').update(`${direction}\u0000${content}`).digest('hex')
}

/** 生成消息 ID */
function generateMessageId(): string {
  return `wmsg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/**
 * 同步一次对话快照。
 *
 * 传入的是 OCR 读到的「最近 N 条」（时间正序）。
 * 已存在的消息（同 contact + 同内容 + 同方向）会被跳过，不会重复插入。
 *
 * @returns 新增的消息条数
 */
export function syncConversation(contact: string, messages: WechatMessage[]): number {
  const db = getDb()
  const now = Date.now()

  // 以当前该达人的最大 msg_order 为基准递增，保证新消息排在后面
  const maxRow = db
    .query(`SELECT COALESCE(MAX(msg_order), 0) AS m FROM wechat_messages WHERE contact = ?`)
    .get(contact) as { m: number } | undefined
  let order = maxRow?.m ?? 0

  let inserted = 0
  for (const msg of messages) {
    if (!msg.text?.trim()) continue
    order += 1
    const hash = hashMessage(msg.dir, msg.text)
    try {
      db.run(
        `INSERT INTO wechat_messages (id, contact, direction, content, content_hash, msg_order, replied, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        generateMessageId(),
        contact,
        msg.dir,
        msg.text,
        hash,
        order,
        msg.dir === 'out' ? 1 : 0, // 我方发的消息天然算「已处理」
        now,
      )
      inserted += 1
    } catch {
      // UNIQUE 约束冲突 = 这条消息已经存过，跳过
    }
  }

  // 更新会话摘要
  db.run(
    `INSERT INTO wechat_conversations (contact, last_synced_at, last_message_at, message_count, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(contact) DO UPDATE SET
       last_synced_at = excluded.last_synced_at,
       last_message_at = excluded.last_message_at,
       message_count = (SELECT COUNT(*) FROM wechat_messages WHERE contact = ?)`,
    contact,
    now,
    messages.length > 0 ? now : null,
    messages.length,
    now,
    contact,
  )

  return inserted
}

/** 行 → 领域对象 */
function rowToStoredMessage(row: Record<string, unknown>): StoredWechatMessage {
  return {
    id: String(row.id),
    contact: String(row.contact),
    direction: String(row.direction) as 'in' | 'out',
    content: String(row.content),
    msgOrder: Number(row.msg_order),
    replied: Boolean(row.replied),
    createdAt: Number(row.created_at),
  }
}

/**
 * 读取历史对话（时间正序）。
 *
 * @param limit 最多返回多少条（取最新的 N 条后正序排列）
 */
export function getConversationHistory(contact: string, limit = 50): StoredWechatMessage[] {
  const db = getDb()
  const rows = db
    .query(
      `SELECT * FROM wechat_messages WHERE contact = ? ORDER BY msg_order DESC LIMIT ?`,
    )
    .all(contact, Math.min(Math.max(limit, 1), 5000)) as Record<string, unknown>[]

  return rows.map(rowToStoredMessage).reverse()
}

// =====================================================================
// 上下文装配：按预算取最近一段，更早的折叠成摘要
// =====================================================================

/**
 * 上下文装配选项。
 *
 * 为什么不按「条数」截断：达人建联对话长度差异极大——
 * 有的两句话就成交，有的聊三个月、几百条。
 * 固定条数要么截断关键信息，要么把无关寒暄塞满 context。
 * 因此按**字符预算**取最近一段，更早的用结构化摘要压缩。
 *
 * 预算取值依据（GLM-5.3 上下文窗口 1M，但**不该塞满**）：
 * - 真实规模：一条消息 20-60 字，极活跃对话三个月约 300-500 条 ≈ 1.5-3 万字符
 * - 100k 字符已覆盖极端情况并留 3 倍余量
 * - 上下文越长模型对中段信息利用越差（lost in the middle），
 *   稀释注意力反而降低草稿质量
 * - 每生成一次草稿都要全量重发，成本随输入线性增长
 */
export interface ConversationContextOptions {
  /** 最近多少条保持原文（默认 300） */
  recentLimit?: number
  /** 原文部分的最大字符数（默认 100_000，约 100k token） */
  charBudget?: number
  /** 摘要部分最多列举多少条关键事实（默认 12） */
  maxFacts?: number
}

/** 默认字符预算：覆盖真实对话 3 倍余量，又不至于稀释注意力 */
export const DEFAULT_CHAR_BUDGET = 100_000

/** 默认条数上限：与字符预算配合，防止极短消息刷爆条数 */
export const DEFAULT_RECENT_LIMIT = 300

/** 装配后的对话上下文 */
export interface ConversationContext {
  /** 最近对话（原文，时间正序） */
  recent: StoredWechatMessage[]
  /** 更早对话的结构化摘要（无折叠时为空字符串） */
  summary: string
  /** 该达人历史消息总数 */
  totalMessages: number
  /** 被折叠进摘要的条数 */
  foldedCount: number
}

/** 从一条消息里抽取值得记住的关键事实 */
function extractFact(message: StoredWechatMessage): string | null {
  const text = message.content.trim()
  if (!text) return null

  const who = message.direction === 'in' ? '达人' : '我方'

  // 报价 + 返点，如「5000返30」「报价 8k」
  const priceRebate = text.match(/(\d+(?:\.\d+)?\s*[kKwW万千]?)\s*返\s*(\d+(?:\.\d+)?)\s*%?/)
  if (priceRebate) {
    return `${who}报过价：${priceRebate[1]}，返点 ${priceRebate[2]}%`
  }

  // 单纯报价
  const price = text.match(/(?:报价|价格|费用)\D{0,4}(\d+(?:\.\d+)?\s*[kKwW万千]?)/)
  if (price) {
    return `${who}提过报价：${price[1]}`
  }

  // 档期 / 时间
  const schedule = text.match(/(\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|下+周[一二三四五六日天]?|这个月|下个月)/)
  if (schedule && /档期|发|拍|上线|安排/.test(text)) {
    return `${who}提过档期：${schedule[1]}`
  }

  // 寄样
  if (/寄样|样品|地址/.test(text)) {
    return `${who}提到过寄样/地址`
  }

  // 合同 / 打款
  if (/合同|打款|结算|发票/.test(text)) {
    return `${who}提到过合同/打款`
  }

  return null
}

/**
 * 装配对话上下文。
 *
 * 策略：
 * 1. 取最近 recentLimit 条作为候选
 * 2. 从最新往前累加，直到字符预算用尽 —— 预算内的保留原文
 * 3. 更早的消息抽取结构化事实（报价/档期/寄样/合同）拼成摘要
 *
 * 这样长对话不会丢失关键信息：即使聊了 500 条，
 * 早期的「达人报 5000 返 30」也会以摘要形式保留。
 */
export function buildConversationContext(
  contact: string,
  options: ConversationContextOptions = {},
): ConversationContext {
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT
  const charBudget = options.charBudget ?? DEFAULT_CHAR_BUDGET
  const maxFacts = options.maxFacts ?? 12

  const db = getDb()
  const totalRow = db
    .query(`SELECT COUNT(*) AS c FROM wechat_messages WHERE contact = ?`)
    .get(contact) as { c: number } | undefined
  const totalMessages = Number(totalRow?.c ?? 0)

  if (totalMessages === 0) {
    return { recent: [], summary: '', totalMessages: 0, foldedCount: 0 }
  }

  // 取最近 recentLimit 条（倒序），再翻正
  const rows = db
    .query(
      `SELECT * FROM wechat_messages WHERE contact = ? ORDER BY msg_order DESC LIMIT ?`,
    )
    .all(contact, Math.min(Math.max(recentLimit, 1), 5000)) as Record<string, unknown>[]
  const candidates = rows.map(rowToStoredMessage).reverse()

  // 从最新往前累加，直到超出预算
  const kept: StoredWechatMessage[] = []
  let used = 0
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const msg = candidates[i]!
    const cost = msg.content.length + 4 // +4 是「我方：」这类前缀开销
    if (used + cost > charBudget && kept.length > 0) break
    used += cost
    kept.unshift(msg)
  }

  const folded = candidates.length - kept.length
  const foldedFromTotal = totalMessages - kept.length

  // 折叠部分抽事实
  const facts: string[] = []
  const seen = new Set<string>()
  for (const msg of candidates.slice(0, folded)) {
    const fact = extractFact(msg)
    if (fact && !seen.has(fact)) {
      seen.add(fact)
      facts.push(fact)
    }
  }

  let summary = ''
  if (foldedFromTotal > 0) {
    const lines = [`（更早还有 ${foldedFromTotal} 条消息，以下是其中的关键信息）`]
    if (facts.length > 0) {
      lines.push(...facts.slice(-maxFacts).map((f) => `- ${f}`))
    } else {
      lines.push('- 更早的对话以寒暄和初步沟通为主，无明确报价/档期信息')
    }
    summary = lines.join('\n')
  }

  return {
    recent: kept,
    summary,
    totalMessages,
    foldedCount: foldedFromTotal,
  }
}

/** 列出全部会话摘要（按最近同步时间倒序） */
export function listConversations(limit = 100): WechatConversationSummary[] {
  const db = getDb()
  const rows = db
    .query(
      `SELECT c.contact, c.last_synced_at, c.last_message_at, c.message_count,
              (SELECT COUNT(*) FROM wechat_messages m
                WHERE m.contact = c.contact AND m.direction = 'in' AND m.replied = 0) AS pending
       FROM wechat_conversations c
       ORDER BY c.last_synced_at DESC
       LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 500)) as Record<string, unknown>[]

  return rows.map((row) => ({
    contact: String(row.contact),
    lastSyncedAt: row.last_synced_at ? Number(row.last_synced_at) : null,
    lastMessageAt: row.last_message_at ? Number(row.last_message_at) : null,
    messageCount: Number(row.message_count ?? 0),
    pendingCount: Number(row.pending ?? 0),
  }))
}

/**
 * 把某达人当前未回复的消息标记为「已回复」。
 *
 * 调用时机：用户点「复制」或「记录已发送」之后——
 * 此时我方已经人工处理过这轮对话，下次生成草稿不该再把这批当成待回。
 */
export function markConversationReplied(contact: string): number {
  const db = getDb()
  const result = db.run(
    `UPDATE wechat_messages SET replied = 1 WHERE contact = ? AND direction = 'in' AND replied = 0`,
    contact,
  )
  return Number(result.changes ?? 0)
}

/** 清空某达人的对话历史 */
export function clearConversation(contact: string): void {
  const db = getDb()
  db.run(`DELETE FROM wechat_messages WHERE contact = ?`, contact)
  db.run(`DELETE FROM wechat_conversations WHERE contact = ?`, contact)
}

/** 清空全部对话历史 */
export function clearAllConversations(): void {
  const db = getDb()
  db.run(`DELETE FROM wechat_messages`)
  db.run(`DELETE FROM wechat_conversations`)
}
