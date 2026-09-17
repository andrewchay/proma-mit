/**
 * 微信回调事件 inbox（P3-09）：持久化 + 幂等消费 + dead-letter + 人工重放。
 *
 * 定位：P3-02 的 nonce 消重是进程内第一道防线；inbox 是跨重启的权威去重与补偿层。
 * - append：按 dedupeKey 幂等入库（payload 加密），重复返回 'duplicate'；
 * - consume：处理成功后标记 processed；处理失败标记 dead（记录 attempts 与 last_error）；
 * - replayDead：人工把 dead 事件重置回 pending，由重放流程重新消费；
 * - 同 key 的事件无论重试多少次最多被成功消费一次（exactly-once 效果）。
 *
 * 安全约定：payload 在 Postgres 中加密存储；错误信息不回显 payload 内容。
 */
import { createHash } from 'node:crypto'
import { decryptWithKey, encryptWithKey } from './ticket-store'
import type { WechatComponentTicketStore } from './ticket-store'

export type WechatInboxAppendResult = 'appended' | 'duplicate'
export type WechatInboxStatus = 'pending' | 'processed' | 'dead'

export interface WechatInboxEvent {
  dedupeKey: string
  eventType: string
  payload: string
  status: WechatInboxStatus
  attempts: number
  lastError?: string
  createdAt: number
  processedAt?: number
}

export interface WechatEventInbox {
  append(input: { dedupeKey: string; eventType: string; payload: string }): Promise<WechatInboxAppendResult>
  markProcessed(dedupeKey: string): Promise<void>
  markDead(dedupeKey: string, error: string): Promise<void>
  listDead(): Promise<WechatInboxEvent[]>
  /** 人工重放：把 dead 事件重置为 pending。返回是否成功重置。 */
  replayDead(dedupeKey: string): Promise<boolean>
}

/** 进程内实现：单测使用。 */
export class InMemoryWechatEventInbox implements WechatEventInbox {
  private events = new Map<string, WechatInboxEvent>()

  async append(input: { dedupeKey: string; eventType: string; payload: string }): Promise<WechatInboxAppendResult> {
    if (this.events.has(input.dedupeKey)) return 'duplicate'
    this.events.set(input.dedupeKey, {
      dedupeKey: input.dedupeKey,
      eventType: input.eventType,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
    })
    return 'appended'
  }

  async markProcessed(dedupeKey: string): Promise<void> {
    const event = this.events.get(dedupeKey)
    if (event) this.events.set(dedupeKey, { ...event, status: 'processed', processedAt: Date.now() })
  }

  async markDead(dedupeKey: string, error: string): Promise<void> {
    const event = this.events.get(dedupeKey)
    if (event) this.events.set(dedupeKey, { ...event, status: 'dead', attempts: event.attempts + 1, lastError: error })
  }

  async listDead(): Promise<WechatInboxEvent[]> {
    return [...this.events.values()].filter((event) => event.status === 'dead')
  }

  async replayDead(dedupeKey: string): Promise<boolean> {
    const event = this.events.get(dedupeKey)
    if (!event || event.status !== 'dead') return false
    this.events.set(dedupeKey, { ...event, status: 'pending', lastError: undefined })
    return true
  }
}

interface PostgresLikeClient {
  query<Row extends Record<string, unknown>>(statement: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>
}

interface InboxRow extends Record<string, unknown> {
  dedupe_key: string
  event_type: string
  encrypted_payload: string
  status: string
  attempts: string
  last_error: string | null
  created_at: string
  processed_at: string | null
}

export class PostgresWechatEventInbox implements WechatEventInbox {
  constructor(
    private readonly client: PostgresLikeClient,
    private readonly encryptionKey: Uint8Array,
  ) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_wechat_event_inbox (
      dedupe_key TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at BIGINT NOT NULL,
      processed_at BIGINT
    )`)
  }

  async append(input: { dedupeKey: string; eventType: string; payload: string }): Promise<WechatInboxAppendResult> {
    try {
      await this.client.query(
        `INSERT INTO proma_wechat_event_inbox (dedupe_key, event_type, encrypted_payload, status, attempts, created_at)
         VALUES ($1, $2, $3, 'pending', 0, $4)`,
        [input.dedupeKey, input.eventType, encryptWithKey(input.payload, this.encryptionKey), Date.now()],
      )
      return 'appended'
    } catch {
      // 主键冲突 = 已入库（pending/processed/dead 都视为已接收）
      return 'duplicate'
    }
  }

  async markProcessed(dedupeKey: string): Promise<void> {
    await this.client.query(
      `UPDATE proma_wechat_event_inbox SET status = 'processed', processed_at = $2 WHERE dedupe_key = $1`,
      [dedupeKey, Date.now()],
    )
  }

  async markDead(dedupeKey: string, error: string): Promise<void> {
    await this.client.query(
      `UPDATE proma_wechat_event_inbox
       SET status = 'dead', attempts = attempts + 1, last_error = $2
       WHERE dedupe_key = $1`,
      [dedupeKey, error.slice(0, 500)],
    )
  }

  async listDead(): Promise<WechatInboxEvent[]> {
    const result = await this.client.query<InboxRow>(
      `SELECT * FROM proma_wechat_event_inbox WHERE status = 'dead' ORDER BY created_at ASC`,
    )
    return result.rows.map((row) => this.decode(row))
  }

  async replayDead(dedupeKey: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE proma_wechat_event_inbox SET status = 'pending', last_error = NULL WHERE dedupe_key = $1 AND status = 'dead'`,
      [dedupeKey],
    )
    return result.rows.length > 0
  }

  private decode(row: InboxRow): WechatInboxEvent {
    return {
      dedupeKey: row.dedupe_key,
      eventType: row.event_type,
      payload: decryptWithKey(row.encrypted_payload, this.encryptionKey),
      status: row.status === 'processed' ? 'processed' : row.status === 'dead' ? 'dead' : 'pending',
      attempts: Number(row.attempts),
      lastError: row.last_error ?? undefined,
      createdAt: Number(row.created_at),
      processedAt: row.processed_at === null ? undefined : Number(row.processed_at),
    }
  }
}

/** inbox 事件的 dedupeKey 生成：同一事件内容稳定映射到同一 key。 */
export function inboxDedupeKey(eventType: string, payload: string): string {
  return `${eventType}:${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`
}

/**
 * 人工重放 ticket dead-letter：重置为 pending → 重新消费 → processed。
 * 消费失败则再次进入 dead（attempts+1）。payload 结构非法时保持 dead 并抛错。
 */
export async function replayTicketDeadLetter(
  inbox: WechatEventInbox,
  ticketStore: WechatComponentTicketStore,
  dedupeKey: string,
): Promise<'replayed' | 'not_dead'> {
  const dead = await inbox.listDead()
  const event = dead.find((item) => item.dedupeKey === dedupeKey)
  if (!event) return 'not_dead'
  if (!await inbox.replayDead(dedupeKey)) return 'not_dead'
  let payload: { componentAppId?: string; ticket?: string }
  try {
    payload = JSON.parse(event.payload) as typeof payload
  } catch {
    await inbox.markDead(dedupeKey, 'payload 不是合法 JSON')
    throw new Error('dead-letter payload 结构非法，已保持 dead')
  }
  if (!payload.componentAppId || !payload.ticket) {
    await inbox.markDead(dedupeKey, 'payload 缺少 componentAppId 或 ticket')
    throw new Error('dead-letter payload 字段不完整，已保持 dead')
  }
  try {
    await ticketStore.save({ componentAppId: payload.componentAppId, ticket: payload.ticket, receivedAt: Date.now() })
    await inbox.markProcessed(dedupeKey)
  } catch (error) {
    await inbox.markDead(dedupeKey, error instanceof Error ? error.message : String(error))
    throw error instanceof Error ? error : new Error(String(error))
  }
  return 'replayed'
}
