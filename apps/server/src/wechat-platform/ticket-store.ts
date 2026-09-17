/**
 * component_verify_ticket 存储。
 *
 * ticket 是派生 component_access_token 的根凭据：
 * - 落库前必须经 AES-256-GCM 加密（密钥由服务器启动配置注入）；
 * - 只保留每个 component_appid 的最新 ticket 与接收时间，历史计数另计；
 * - 任何读取接口都不得把 ticket 明文写进日志。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export interface WechatComponentTicketRecord {
  componentAppId: string
  ticket: string
  receivedAt: number
}

export interface WechatComponentTicketStore {
  save(record: WechatComponentTicketRecord): Promise<void>
  load(componentAppId: string): Promise<WechatComponentTicketRecord | undefined>
  count(componentAppId: string): Promise<number>
  /** 消重缓存：同一 callback（timestamp+nonce）只接受一次。 */
  acceptOnce(key: string): Promise<boolean>
}

/** 进程内实现：单测与单实例部署可用；多实例部署需要换 Postgres 实现。 */
export class InMemoryWechatComponentTicketStore implements WechatComponentTicketStore {
  private tickets = new Map<string, WechatComponentTicketRecord>()
  private received = new Map<string, number>()
  private counts = new Map<string, number>()

  async save(record: WechatComponentTicketRecord): Promise<void> {
    this.tickets.set(record.componentAppId, record)
    this.counts.set(record.componentAppId, (this.counts.get(record.componentAppId) ?? 0) + 1)
  }

  async load(componentAppId: string): Promise<WechatComponentTicketRecord | undefined> {
    return this.tickets.get(componentAppId)
  }

  async count(componentAppId: string): Promise<number> {
    return this.counts.get(componentAppId) ?? 0
  }

  async acceptOnce(key: string): Promise<boolean> {
    if (this.received.has(key)) return false
    this.received.set(key, Date.now())
    // 只保留最近 1000 条消重记录，防止无限增长。
    if (this.received.size > 1000) {
      const oldest = [...this.received.entries()].sort((left, right) => left[1] - right[1])[0]
      if (oldest) this.received.delete(oldest[0])
    }
    return true
  }
}

interface PostgresLikeClient {
  query<Row extends Record<string, unknown>>(statement: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>
}

function encryptTicket(ticket: string, keyBytes: Uint8Array): string {
  if (keyBytes.byteLength !== 32) throw new Error('ticket 存储密钥必须是 32 字节')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes, iv)
  const encrypted = Buffer.concat([cipher.update(ticket, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64')}.${encrypted.toString('base64')}.${tag.toString('base64')}`
}

function decryptTicket(payload: string, keyBytes: Uint8Array): string {
  const [version, ivPart, ctPart, tagPart] = payload.split('.')
  if (version !== 'v1' || !ivPart || !ctPart || !tagPart) throw new Error('ticket 密文格式无效')
  const decipher = createDecipheriv('aes-256-gcm', keyBytes, Buffer.from(ivPart, 'base64'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ctPart, 'base64')), decipher.final()]).toString('utf-8')
}

/** ticket 密文的指纹（用于日志可观测而不暴露内容）。 */
export function ticketFingerprint(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex').slice(0, 8)
}

export class PostgresWechatComponentTicketStore implements WechatComponentTicketStore {
  constructor(
    private readonly client: PostgresLikeClient,
    private readonly encryptionKey: Uint8Array,
    private readonly now = Date.now,
  ) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_wechat_component_ticket (
      component_app_id TEXT PRIMARY KEY,
      encrypted_ticket TEXT NOT NULL,
      received_at BIGINT NOT NULL,
      receive_count BIGINT NOT NULL DEFAULT 1
    )`)
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_wechat_callback_nonce (
      nonce_key TEXT PRIMARY KEY,
      seen_at BIGINT NOT NULL
    )`)
  }

  async save(record: WechatComponentTicketRecord): Promise<void> {
    const encrypted = encryptTicket(record.ticket, this.encryptionKey)
    await this.client.query(
      `INSERT INTO proma_wechat_component_ticket (component_app_id, encrypted_ticket, received_at, receive_count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (component_app_id) DO UPDATE
       SET encrypted_ticket = $2, received_at = $3, receive_count = proma_wechat_component_ticket.receive_count + 1`,
      [record.componentAppId, encrypted, record.receivedAt],
    )
  }

  async load(componentAppId: string): Promise<WechatComponentTicketRecord | undefined> {
    const result = await this.client.query<{ encrypted_ticket: string; received_at: string }>(
      'SELECT encrypted_ticket, received_at FROM proma_wechat_component_ticket WHERE component_app_id = $1',
      [componentAppId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return { componentAppId, ticket: decryptTicket(row.encrypted_ticket, this.encryptionKey), receivedAt: Number(row.received_at) }
  }

  async count(componentAppId: string): Promise<number> {
    const result = await this.client.query<{ receive_count: string }>(
      'SELECT receive_count FROM proma_wechat_component_ticket WHERE component_app_id = $1',
      [componentAppId],
    )
    return Number(result.rows[0]?.receive_count ?? 0)
  }

  async acceptOnce(key: string): Promise<boolean> {
    // 借助主键唯一性做原子消重；过期 nonce 由轮询任务清理（见 pruneNonces）。
    try {
      await this.client.query('INSERT INTO proma_wechat_callback_nonce (nonce_key, seen_at) VALUES ($1, $2)', [key, Date.now()])
      return true
    } catch {
      return false
    }
  }

  /** 清理过期 nonce（应接入 server-scheduler 定期执行）。 */
  async pruneNonces(olderThan: number): Promise<void> {
    await this.client.query('DELETE FROM proma_wechat_callback_nonce WHERE seen_at < $1', [olderThan])
  }
}
