/**
 * 微信回调轮询兜底与对账（P3-09）。
 *
 * 两类兜底：
 * 1. ticket 新鲜度巡检：微信每 10 分钟推一次 ticket；超过阈值未更新说明回调链路
 *    中断（丢回调/服务停机），需要告警人工介入——inbox dead-letter 里可能已有积压。
 * 2. 授权账号对账：轮询 api_get_authorizer_list，把「本地 active 但远端已消失」的账号
 *    标记 revoked——这是 unauthorized 回调丢失时的恢复手段（轮询可恢复丢回调）。
 *
 * 只做对账与告警，不自动复活账号：重新授权必须走扫码（无法凭远端列表恢复 token）。
 */
import type { WechatComponentTicketStore } from './ticket-store'
import type { WechatComponentTokenService } from './component-token-service'
import type { WechatAuthorizerStore } from './authorizer-store'

/** 微信每 10 分钟推一次 ticket；15 分钟没更新即视为链路中断。 */
export const DEFAULT_MAX_TICKET_AGE_MS = 15 * 60 * 1000

export interface WechatReconciliationReport {
  ticketFresh: boolean
  ticketLastReceivedAt?: number
  revokedByReconciliation: string[]
  missingLocally: string[]
  checkedAt: number
}

export interface WechatReconciliationOptions {
  componentAppId: string
  ticketStore: WechatComponentTicketStore
  componentTokenService: WechatComponentTokenService
  authorizerStore: WechatAuthorizerStore
  maxTicketAgeMs?: number
  logger?: { info(message: string): void; warn(message: string): void }
  now?: () => number
  fetchFn?: typeof fetch
  apiBaseUrl?: string
}

export class WechatReconciliationService {
  private readonly maxTicketAgeMs: number
  private readonly logger: NonNullable<WechatReconciliationOptions['logger']>
  private readonly now: () => number
  private readonly fetchFn: typeof fetch
  private readonly apiBaseUrl: string

  constructor(private readonly options: WechatReconciliationOptions) {
    this.maxTicketAgeMs = options.maxTicketAgeMs ?? DEFAULT_MAX_TICKET_AGE_MS
    this.logger = options.logger ?? { info: () => undefined, warn: () => undefined }
    this.now = options.now ?? Date.now
    this.fetchFn = options.fetchFn ?? fetch
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.weixin.qq.com').replace(/\/$/, '')
  }

  /** 执行一次完整对账：ticket 新鲜度 + 授权账号名单核对。 */
  async reconcile(): Promise<WechatReconciliationReport> {
    const now = this.now()
    const report: WechatReconciliationReport = {
      ticketFresh: true,
      revokedByReconciliation: [],
      missingLocally: [],
      checkedAt: now,
    }

    // 1) ticket 新鲜度
    const ticket = await this.options.ticketStore.load(this.options.componentAppId)
    if (!ticket) {
      report.ticketFresh = false
      this.logger.warn(`[WeChat] 对账：从未收到 component_verify_ticket（appId=${this.options.componentAppId}）`)
    } else {
      report.ticketLastReceivedAt = ticket.receivedAt
      const age = now - ticket.receivedAt
      if (age > this.maxTicketAgeMs) {
        report.ticketFresh = false
        this.logger.warn(`[WeChat] 对账：ticket 已 ${Math.round(age / 60000)} 分钟未更新，回调链路可能中断（appId=${this.options.componentAppId}）`)
      }
    }

    // 2) 授权账号名单核对（轮询恢复丢回调的 unauthorized 事件）
    const remote = await this.fetchAuthorizerList()
    if (remote) {
      const remoteIds = new Set(remote)
      const localActive = (await this.options.authorizerStore.list()).filter((account) => account.status === 'active')
      for (const account of localActive) {
        if (!remoteIds.has(account.authorizerAppId)) {
          await this.options.authorizerStore.markRevoked(account.authorizerAppId, now)
          report.revokedByReconciliation.push(account.authorizerAppId)
          this.logger.warn(`[WeChat] 对账：本地 active 但远端已移除，标记 revoked（authorizer=${account.authorizerAppId}）`)
        }
      }
      const localIds = new Set((await this.options.authorizerStore.list()).map((account) => account.authorizerAppId))
      for (const remoteId of remoteIds) {
        if (!localIds.has(remoteId)) report.missingLocally.push(remoteId)
      }
      if (report.missingLocally.length > 0) {
        this.logger.warn(`[WeChat] 对账：远端存在本地未登记的授权账号（${report.missingLocally.length} 个），需要人工确认`)
      }
    }
    return report
  }

  /** 拉取远端授权账号列表；接口失败返回 undefined（对账降级为只做 ticket 检查）。 */
  private async fetchAuthorizerList(): Promise<string[] | undefined> {
    try {
      const componentToken = await this.options.componentTokenService.getToken()
      const response = await this.fetchFn(
        `${this.apiBaseUrl}/cgi-bin/component/api_get_authorizer_list?component_access_token=${encodeURIComponent(componentToken)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ component_appid: this.options.componentAppId }),
        },
      )
      const payload = await response.json() as { authorizer_list?: Array<{ authorizer_appid?: string }>; errcode?: number; errmsg?: string }
      if (!Array.isArray(payload.authorizer_list)) {
        this.logger.warn(`[WeChat] 对账：拉取授权账号列表失败 errcode=${payload.errcode ?? '未知'}`)
        return undefined
      }
      return payload.authorizer_list.map((item) => item.authorizer_appid ?? '').filter(Boolean)
    } catch (error) {
      this.logger.warn(`[WeChat] 对账：拉取授权账号列表网络失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}
