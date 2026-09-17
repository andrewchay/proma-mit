/**
 * component_access_token 生命周期管理（P3-03）。
 *
 * 职责：
 * - 从 ticket 存储读取 component_verify_ticket，调用微信 api_component_token 换取 token；
 * - token 加密持久化（Postgres）+ 内存快路径，服务重启不丢缓存；
 * - 过期前主动刷新（默认提前 10 分钟），并采用单飞模式：同刻并发请求只触发一次刷新；
 * - 刷新失败时，若旧 token 仍在有效期内则回退旧值并告警（微信侧容忍少量时钟漂移）；
 * - 全程可观测：成功/失败/回退计数与最近刷新时间，日志只含 token 指纹。
 *
 * 安全约定：token 明文只存在于内存与加密存储，绝不写入日志或错误信息。
 */
import { decryptWithKey, encryptWithKey, ticketFingerprint } from './ticket-store'
import type { WechatComponentTicketStore } from './ticket-store'

export interface WechatComponentTokenRecord {
  componentAppId: string
  componentAccessToken: string
  expiresAt: number
  acquiredAt: number
}

/** 加密持久化 token 的存储接口。 */
export interface WechatComponentTokenCacheStore {
  save(record: WechatComponentTokenRecord): Promise<void>
  load(componentAppId: string): Promise<WechatComponentTokenRecord | undefined>
}

interface PostgresLikeClient {
  query<Row extends Record<string, unknown>>(statement: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>
}

export class PostgresWechatComponentTokenCacheStore implements WechatComponentTokenCacheStore {
  constructor(
    private readonly client: PostgresLikeClient,
    private readonly encryptionKey: Uint8Array,
  ) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_wechat_component_token (
      component_app_id TEXT PRIMARY KEY,
      encrypted_token TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      acquired_at BIGINT NOT NULL
    )`)
  }

  async save(record: WechatComponentTokenRecord): Promise<void> {
    const encrypted = encryptWithKey(record.componentAccessToken, this.encryptionKey)
    await this.client.query(
      `INSERT INTO proma_wechat_component_token (component_app_id, encrypted_token, expires_at, acquired_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (component_app_id) DO UPDATE
       SET encrypted_token = $2, expires_at = $3, acquired_at = $4`,
      [record.componentAppId, encrypted, record.expiresAt, record.acquiredAt],
    )
  }

  async load(componentAppId: string): Promise<WechatComponentTokenRecord | undefined> {
    const result = await this.client.query<{ encrypted_token: string; expires_at: string; acquired_at: string }>(
      'SELECT encrypted_token, expires_at, acquired_at FROM proma_wechat_component_token WHERE component_app_id = $1',
      [componentAppId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return {
      componentAppId,
      componentAccessToken: decryptWithKey(row.encrypted_token, this.encryptionKey),
      expiresAt: Number(row.expires_at),
      acquiredAt: Number(row.acquired_at),
    }
  }
}

export interface WechatComponentTokenServiceOptions {
  componentAppId: string
  componentAppSecret: string
  ticketStore: WechatComponentTicketStore
  tokenCacheStore: WechatComponentTokenCacheStore
  /** 刷新提前量：距过期不足该值即刷新。默认 10 分钟。 */
  refreshLeadMs?: number
  logger?: { info(message: string): void; warn(message: string): void }
  now?: () => number
  fetchFn?: typeof fetch
  /** 测试用：覆盖微信 API 地址。 */
  apiBaseUrl?: string
}

export interface WechatComponentTokenMetrics {
  refreshSuccessCount: number
  refreshFailureCount: number
  fallbackUsedCount: number
  cacheHitCount: number
  lastRefreshAt: number | undefined
}

export class WechatComponentTokenService {
  private readonly refreshLeadMs: number
  private readonly logger: NonNullable<WechatComponentTokenServiceOptions['logger']>
  private readonly now: () => number
  private readonly fetchFn: typeof fetch
  private readonly apiBaseUrl: string
  private memory: WechatComponentTokenRecord | undefined
  /** 单飞：同一时刻只有一个刷新在执行，其余调用等待其 Promise。 */
  private inflightRefresh: Promise<string> | undefined
  private metrics: WechatComponentTokenMetrics = {
    refreshSuccessCount: 0,
    refreshFailureCount: 0,
    fallbackUsedCount: 0,
    cacheHitCount: 0,
    lastRefreshAt: undefined,
  }

  constructor(private readonly options: WechatComponentTokenServiceOptions) {
    this.refreshLeadMs = options.refreshLeadMs ?? 10 * 60 * 1000
    this.logger = options.logger ?? { info: () => undefined, warn: () => undefined }
    this.now = options.now ?? Date.now
    this.fetchFn = options.fetchFn ?? fetch
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.weixin.qq.com').replace(/\/$/, '')
  }

  getMetrics(): WechatComponentTokenMetrics {
    return { ...this.metrics }
  }

  /**
   * 获取可用的 component_access_token。
   * 缓存未接近过期直接返回；否则单飞刷新；刷新失败回退仍在有效期内的旧 token。
   */
  async getToken(): Promise<string> {
    const cached = await this.loadCached()
    if (cached && cached.expiresAt - this.now() > this.refreshLeadMs) {
      this.metrics.cacheHitCount += 1
      return cached.componentAccessToken
    }
    try {
      return await this.refreshSingleFlight()
    } catch (error) {
      // 刷新失败：只要旧 token 尚未真正过期，先回退旧值保证调用方不中断。
      if (cached && cached.expiresAt > this.now()) {
        this.metrics.fallbackUsedCount += 1
        this.logger.warn(`[WeChat] component_access_token 刷新失败，回退旧 token（appId=${this.options.componentAppId}，指纹=${ticketFingerprint(cached.componentAccessToken)}）：${error instanceof Error ? error.message : String(error)}`)
        return cached.componentAccessToken
      }
      throw error
    }
  }

  private async loadCached(): Promise<WechatComponentTokenRecord | undefined> {
    if (this.memory) return this.memory
    try {
      this.memory = await this.options.tokenCacheStore.load(this.options.componentAppId)
      return this.memory
    } catch (error) {
      this.logger.warn(`[WeChat] token 缓存读取失败，走网络刷新：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private refreshSingleFlight(): Promise<string> {
    this.inflightRefresh ??= this.doRefresh()
      .finally(() => {
        this.inflightRefresh = undefined
      })
    return this.inflightRefresh
  }

  private async doRefresh(): Promise<string> {
    const ticketRecord = await this.options.ticketStore.load(this.options.componentAppId)
    if (!ticketRecord) {
      throw new Error('尚未收到 component_verify_ticket，无法换取 component_access_token')
    }
    const body = JSON.stringify({
      component_appid: this.options.componentAppId,
      component_appsecret: this.options.componentAppSecret,
      component_verify_ticket: ticketRecord.ticket,
    })
    let response: Response
    try {
      response = await this.fetchFn(`${this.apiBaseUrl}/cgi-bin/component/api_component_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
    } catch (error) {
      this.metrics.refreshFailureCount += 1
      throw new Error(`component_access_token 请求网络失败：${error instanceof Error ? error.message : String(error)}`)
    }
    let payload: { component_access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
    try {
      payload = await response.json() as typeof payload
    } catch {
      this.metrics.refreshFailureCount += 1
      throw new Error(`component_access_token 响应不是合法 JSON（HTTP ${response.status}）`)
    }
    if (!payload.component_access_token || !payload.expires_in) {
      this.metrics.refreshFailureCount += 1
      throw new Error(`component_access_token 换取失败：errcode=${payload.errcode ?? '未知'} errmsg=${payload.errmsg ?? '未知'}`)
    }
    const now = this.now()
    const record: WechatComponentTokenRecord = {
      componentAppId: this.options.componentAppId,
      componentAccessToken: payload.component_access_token,
      // 微信 expires_in 单位是秒；本地统一毫秒，并对 30 秒时钟漂移留余量。
      expiresAt: now + payload.expires_in * 1000 - 30_000,
      acquiredAt: now,
    }
    this.memory = record
    try {
      await this.options.tokenCacheStore.save(record)
    } catch (error) {
      // 持久化失败不阻断本次使用，但需告警（重启后会重新换取）。
      this.logger.warn(`[WeChat] token 缓存持久化失败：${error instanceof Error ? error.message : String(error)}`)
    }
    this.metrics.refreshSuccessCount += 1
    this.metrics.lastRefreshAt = now
    this.logger.info(`[WeChat] component_access_token 已刷新（appId=${this.options.componentAppId}，指纹=${ticketFingerprint(record.componentAccessToken)}，有效期至 ${new Date(record.expiresAt).toISOString()}）`)
    return record.componentAccessToken
  }
}
