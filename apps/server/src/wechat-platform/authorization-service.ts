/**
 * 微信第三方平台商家授权流程（P3-04）。
 *
 * 流程：
 * 1. createAuthorizationUrl()：换取预授权码 pre_auth_code，生成一次性 state，
 *    组装管理员扫码授权页 URL（微信托管页面，本服务不收集管理员任何凭据）；
 * 2. handleAuthorizationCallback(authCode, state)：校验 state 未被使用且未过期，
 *    调用 api_query_auth 换取 authorizer token 并加密落库（重新授权即恢复 active）；
 * 3. handleUnauthorizedEvent()：商家在微信后台取消授权 → 标记 revoked，调用方需感知；
 * 4. getAuthorizerAccessToken()：authorizer token 缓存 + 过期前刷新 + 单飞 + 失败回退。
 *
 * 安全约定：
 * - state 一次性使用（核销后即刻作废），10 分钟过期；
 * - token 只进加密存储，日志只含 appid 与指纹；
 * - 取消授权的账号 getToken 直接拒绝，防止幽灵调用。
 */
import { randomUUID } from 'node:crypto'
import type { WechatComponentTicketStore } from './ticket-store'
import { ticketFingerprint } from './ticket-store'
import type { WechatComponentTokenService } from './component-token-service.ts'
import type { WechatAuthorizerAccount, WechatAuthorizerStore } from './authorizer-store.ts'

const WECHAT_LOGIN_PAGE_BASE = 'https://mp.weixin.qq.com/cgi-bin/componentloginpage'
const API_BASE = 'https://api.weixin.qq.com'

export interface WechatAuthorizationStateStore {
  /** 原子核销：state 存在且未过期则标记已用并返回 true，否则 false。 */
  consume(state: string): Promise<boolean>
  save(state: string, expiresAt: number): Promise<void>
}

/** 进程内实现（带过期清理）。 */
export class InMemoryWechatAuthorizationStateStore implements WechatAuthorizationStateStore {
  private states = new Map<string, number>()
  constructor(private readonly now = Date.now) {}

  async save(state: string, expiresAt: number): Promise<void> {
    this.states.set(state, expiresAt)
    if (this.states.size > 2000) this.prune()
  }

  async consume(state: string): Promise<boolean> {
    const expiresAt = this.states.get(state)
    if (expiresAt === undefined || expiresAt <= this.now()) {
      this.states.delete(state)
      return false
    }
    this.states.delete(state)
    return true
  }

  private prune(): void {
    const now = this.now()
    for (const [state, expiresAt] of this.states) {
      if (expiresAt <= now) this.states.delete(state)
    }
  }
}

interface PostgresLikeClient {
  query<Row extends Record<string, unknown>>(statement: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>
}

export class PostgresWechatAuthorizationStateStore implements WechatAuthorizationStateStore {
  constructor(private readonly client: PostgresLikeClient, private readonly now = Date.now) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_wechat_auth_state (
      state TEXT PRIMARY KEY,
      expires_at BIGINT NOT NULL
    )`)
  }

  async save(state: string, expiresAt: number): Promise<void> {
    // 顺手清理过期 state，避免表无限增长。
    await this.client.query('DELETE FROM proma_wechat_auth_state WHERE expires_at < $1', [this.now()])
    await this.client.query('INSERT INTO proma_wechat_auth_state (state, expires_at) VALUES ($1, $2)', [state, expiresAt])
  }

  async consume(state: string): Promise<boolean> {
    // DELETE 返回受影响行数：原子核销，并发回调只有一个能拿到 1。
    const result = await this.client.query<{ count: string }>(
      'DELETE FROM proma_wechat_auth_state WHERE state = $1 AND expires_at > $2 RETURNING state',
      [state, this.now()],
    )
    return result.rows.length > 0
  }
}

export interface WechatAuthorizationServiceOptions {
  componentAppId: string
  /** 在微信开放平台后台登记的授权回调 redirect_uri（必须与本服务对外地址一致）。 */
  authorizationRedirectUri: string
  ticketStore: WechatComponentTicketStore
  componentTokenService: WechatComponentTokenService
  authorizerStore: WechatAuthorizerStore
  stateStore: WechatAuthorizationStateStore
  /** state 有效期：默认 10 分钟。 */
  stateTtlMs?: number
  /** authorizer token 刷新提前量：默认 10 分钟。 */
  authorizerRefreshLeadMs?: number
  logger?: { info(message: string): void; warn(message: string): void }
  now?: () => number
  fetchFn?: typeof fetch
  apiBaseUrl?: string
  /** 扫码页账号类型：1 仅公众号，2 仅小程序，3 全部（默认）。 */
  authType?: number
}

export interface WechatAuthorizationUrlResult {
  url: string
  /** 预授权码有效期（秒），供前端展示倒计时。 */
  preAuthCodeExpiresIn: number
}

export interface WechatAuthorizedAccountSummary {
  authorizerAppId: string
  nickname: string
  accountType: string
  status: 'active' | 'revoked'
  authorizedAt: number
}

export class WechatAuthorizationService {
  private readonly stateTtlMs: number
  private readonly authorizerRefreshLeadMs: number
  private readonly logger: NonNullable<WechatAuthorizationServiceOptions['logger']>
  private readonly now: () => number
  private readonly fetchFn: typeof fetch
  private readonly apiBaseUrl: string
  private readonly authType: number
  /** authorizer token 刷新单飞：按 authorizerAppId 隔离。 */
  private inflightAuthorizerRefresh = new Map<string, Promise<string>>()

  constructor(private readonly options: WechatAuthorizationServiceOptions) {
    this.stateTtlMs = options.stateTtlMs ?? 10 * 60 * 1000
    this.authorizerRefreshLeadMs = options.authorizerRefreshLeadMs ?? 10 * 60 * 1000
    this.logger = options.logger ?? { info: () => undefined, warn: () => undefined }
    this.now = options.now ?? Date.now
    this.fetchFn = options.fetchFn ?? fetch
    this.apiBaseUrl = (options.apiBaseUrl ?? API_BASE).replace(/\/$/, '')
    this.authType = options.authType ?? 3
  }

  /**
   * 生成管理员扫码授权页 URL。
   * 预授权码来自微信 API；state 本地生成并登记，回调时必须原样带回。
   */
  async createAuthorizationUrl(): Promise<WechatAuthorizationUrlResult> {
    const componentToken = await this.options.componentTokenService.getToken()
    const payload = await this.postWechatJson<{ pre_auth_code?: string; expires_in?: number; errcode?: number; errmsg?: string }>(
      `${this.apiBaseUrl}/cgi-bin/component/api_create_preauthcode?component_access_token=${encodeURIComponent(componentToken)}`,
      { component_appid: this.options.componentAppId },
      '预授权码换取失败',
    )
    const state = randomUUID()
    await this.options.stateStore.save(state, this.now() + this.stateTtlMs)
    const redirectUri = encodeURIComponent(this.options.authorizationRedirectUri)
    const url = `${WECHAT_LOGIN_PAGE_BASE}?component_appid=${encodeURIComponent(this.options.componentAppId)}&pre_auth_code=${encodeURIComponent(payload.pre_auth_code ?? '')}&redirect_uri=${redirectUri}&auth_type=${this.authType}&state=${encodeURIComponent(state)}`
    this.logger.info(`[WeChat] 已生成授权页 URL（appId=${this.options.componentAppId}）`)
    return { url, preAuthCodeExpiresIn: payload.expires_in ?? 600 }
  }

  /**
   * 处理微信授权回调：核销 state → api_query_auth 换 token → 加密落库。
   * 重复授权（已 revoked 的账号重新扫码）会恢复为 active。
   */
  async handleAuthorizationCallback(input: { authCode: string; state: string }): Promise<WechatAuthorizedAccountSummary> {
    if (!input.authCode || !input.state) throw new Error('授权回调缺少 auth_code 或 state')
    if (!await this.options.stateStore.consume(input.state)) {
      this.logger.warn('[WeChat] 授权回调 state 无效、过期或已使用，拒绝处理')
      throw new Error('state 校验失败：请求可能被重放')
    }
    const componentToken = await this.options.componentTokenService.getToken()
    const payload = await this.postWechatJson<{
      authorization_info?: {
        authorizer_appid?: string
        authorizer_access_token?: string
        expires_in?: number
        authorizer_refresh_token?: string
        func_info?: unknown[]
      }
      authorizer_info?: { nick_name?: string; account_type?: string }
      errcode?: number
      errmsg?: string
    }>(
      `${this.apiBaseUrl}/cgi-bin/component/api_query_auth?component_access_token=${encodeURIComponent(componentToken)}`,
      { component_appid: this.options.componentAppId, authorization_code: input.authCode },
      '授权信息查询失败',
    )
    const info = payload.authorization_info
    if (!info?.authorizer_appid || !info.authorizer_access_token || !info.authorizer_refresh_token) {
      throw new Error('授权信息不完整：缺少 authorizer token')
    }
    const now = this.now()
    const account: WechatAuthorizerAccount = {
      authorizerAppId: info.authorizer_appid,
      authorizerAccessToken: info.authorizer_access_token,
      authorizerRefreshToken: info.authorizer_refresh_token,
      tokenExpiresAt: now + (info.expires_in ?? 7200) * 1000 - 30_000,
      tokenAcquiredAt: now,
      nickname: payload.authorizer_info?.nick_name ?? '',
      accountType: String(payload.authorizer_info?.account_type ?? ''),
      status: 'active',
      authorizedAt: now,
      updatedAt: now,
    }
    await this.options.authorizerStore.save(account)
    this.logger.info(`[WeChat] 商家授权成功（authorizer=${account.authorizerAppId}，昵称=${account.nickname}）`)
    return this.summarize(account)
  }

  /** 商家取消授权：标记 revoked；之后的 token 获取与调用一律拒绝。 */
  async handleUnauthorizedEvent(authorizerAppId: string): Promise<void> {
    if (!authorizerAppId) return
    await this.options.authorizerStore.markRevoked(authorizerAppId, this.now())
    this.logger.info(`[WeChat] 商家已取消授权（authorizer=${authorizerAppId}）`)
  }

  /** 取商家 authorizer_access_token：缓存 + 过期前刷新 + 单飞 + 失败回退旧值。 */
  async getAuthorizerAccessToken(authorizerAppId: string): Promise<string> {
    const account = await this.options.authorizerStore.load(authorizerAppId)
    if (!account) throw new Error(`未找到授权账号：${authorizerAppId}`)
    if (account.status === 'revoked') throw new Error(`授权账号已取消授权：${authorizerAppId}`)
    if (account.tokenExpiresAt - this.now() > this.authorizerRefreshLeadMs) {
      return account.authorizerAccessToken
    }
    try {
      return await this.refreshAuthorizerTokenSingleFlight(authorizerAppId)
    } catch (error) {
      if (account.tokenExpiresAt > this.now()) {
        this.logger.warn(`[WeChat] authorizer token 刷新失败，回退旧 token（authorizer=${authorizerAppId}，指纹=${ticketFingerprint(account.authorizerAccessToken)}）`)
        return account.authorizerAccessToken
      }
      throw error
    }
  }

  /** 列出全部授权账号（脱敏摘要，不含 token）。 */
  async listAuthorizedAccounts(): Promise<WechatAuthorizedAccountSummary[]> {
    const accounts = await this.options.authorizerStore.list()
    return accounts.map((account) => this.summarize(account))
  }

  private refreshAuthorizerTokenSingleFlight(authorizerAppId: string): Promise<string> {
    const existing = this.inflightAuthorizerRefresh.get(authorizerAppId)
    if (existing) return existing
    const pending = this.doRefreshAuthorizerToken(authorizerAppId)
      .finally(() => {
        this.inflightAuthorizerRefresh.delete(authorizerAppId)
      })
    this.inflightAuthorizerRefresh.set(authorizerAppId, pending)
    return pending
  }

  private async doRefreshAuthorizerToken(authorizerAppId: string): Promise<string> {
    const account = await this.options.authorizerStore.load(authorizerAppId)
    if (!account) throw new Error(`未找到授权账号：${authorizerAppId}`)
    if (account.status === 'revoked') throw new Error(`授权账号已取消授权：${authorizerAppId}`)
    const componentToken = await this.options.componentTokenService.getToken()
    const payload = await this.postWechatJson<{
      authorizer_access_token?: string
      expires_in?: number
      authorizer_refresh_token?: string
      errcode?: number
      errmsg?: string
    }>(
      `${this.apiBaseUrl}/cgi-bin/component/api_authorizer_token?component_access_token=${encodeURIComponent(componentToken)}`,
      {
        component_appid: this.options.componentAppId,
        authorizer_appid: authorizerAppId,
        authorizer_refresh_token: account.authorizerRefreshToken,
      },
      'authorizer token 刷新失败',
    )
    if (!payload.authorizer_access_token) throw new Error('authorizer token 刷新响应缺少 access_token')
    const now = this.now()
    const updated: WechatAuthorizerAccount = {
      ...account,
      authorizerAccessToken: payload.authorizer_access_token,
      // 微信可能轮换 refresh_token，存在则更新。
      authorizerRefreshToken: payload.authorizer_refresh_token ?? account.authorizerRefreshToken,
      tokenExpiresAt: now + (payload.expires_in ?? 7200) * 1000 - 30_000,
      tokenAcquiredAt: now,
      updatedAt: now,
    }
    await this.options.authorizerStore.save(updated)
    this.logger.info(`[WeChat] authorizer token 已刷新（authorizer=${authorizerAppId}，指纹=${ticketFingerprint(updated.authorizerAccessToken)}）`)
    return updated.authorizerAccessToken
  }

  private async postWechatJson<T>(url: string, body: Record<string, string>, failurePrefix: string): Promise<T> {
    let response: Response
    try {
      response = await this.fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    } catch (error) {
      throw new Error(`${failurePrefix}：网络错误 ${error instanceof Error ? error.message : String(error)}`)
    }
    let payload: T & { errcode?: number; errmsg?: string }
    try {
      payload = await response.json() as typeof payload
    } catch {
      throw new Error(`${failurePrefix}：响应不是合法 JSON（HTTP ${response.status}）`)
    }
    if (typeof payload.errcode === 'number' && payload.errcode !== 0) {
      throw new Error(`${failurePrefix}：errcode=${payload.errcode} errmsg=${payload.errmsg ?? '未知'}`)
    }
    return payload
  }

  private summarize(account: WechatAuthorizerAccount): WechatAuthorizedAccountSummary {
    return {
      authorizerAppId: account.authorizerAppId,
      nickname: account.nickname,
      accountType: account.accountType,
      status: account.status,
      authorizedAt: account.authorizedAt,
    }
  }
}
