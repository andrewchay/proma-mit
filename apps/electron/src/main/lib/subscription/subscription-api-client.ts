import type { EntitlementSnapshot } from '@gravitas/shared'

export interface SubscriptionApiConfig {
  baseUrl: string
}

export interface SubscriptionLoginResponse {
  accountId: string
  displayName?: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  entitlement: EntitlementSnapshot
}

export interface SubscriptionRefreshResponse {
  accessToken: string
  refreshToken: string
  expiresAt: number
  entitlement: EntitlementSnapshot
}

export interface SubscriptionCheckoutResponse {
  orderId: string
  provider: string
  amountCny: number
  currency: 'CNY'
  status: string
  qrCodeContent?: string
  redirectUrl?: string
}

export interface SubscriptionOrderView {
  order: {
    id: string
    status: string
    planId?: string
    amountCny?: number
  }
  synced?: boolean
  channelPaid?: boolean
  awaitingCallback?: boolean
}

/** 服务端返回的结构化错误，便于 UI 区分「未登录」与「服务不可用」 */
export class SubscriptionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryable?: boolean,
  ) {
    super(message)
    this.name = 'SubscriptionApiError'
  }
}

const REQUEST_TIMEOUT_MS = 15_000

export class SubscriptionApiClient {
  constructor(private readonly config: SubscriptionApiConfig) {}

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    // 加超时，避免服务不可达时界面长时间无响应
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /** 解析错误响应体，尽力提取服务端的错误码与提示 */
  private async toError(response: Response, fallback: string): Promise<SubscriptionApiError> {
    let code: string | undefined
    let message = fallback
    let retryable: boolean | undefined
    try {
      const body = (await response.json()) as {
        code?: string
        message?: string
        retryable?: boolean
      }
      code = body.code
      if (body.message) message = body.message
      retryable = body.retryable
    } catch {
      // 响应体不是 JSON，保留兜底文案
    }
    return new SubscriptionApiError(message, response.status, code, retryable)
  }

  /** 请求邮箱验证码 */
  async requestEmailOtp(input: { email: string }): Promise<{ ok: true; expiresInSeconds: number }> {
    const response = await this.request('/v1/auth/email/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw await this.toError(response, '验证码发送失败')
    return (await response.json()) as { ok: true; expiresInSeconds: number }
  }

  /** 校验邮箱验证码并登录 */
  async verifyEmailOtp(input: {
    email: string
    code: string
    deviceId?: string
  }): Promise<SubscriptionLoginResponse> {
    const response = await this.request('/v1/auth/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw await this.toError(response, '验证码校验失败')
    return (await response.json()) as SubscriptionLoginResponse
  }

  /** 获取第三方登录授权地址 */
  async startOAuth(provider: 'github' | 'google'): Promise<{ authorizeUrl: string; state: string }> {
    const response = await this.request(`/v1/auth/oauth/${provider}/start`)
    if (!response.ok) throw await this.toError(response, '第三方登录不可用')
    return (await response.json()) as { authorizeUrl: string; state: string }
  }

  /** 用授权码完成第三方登录 */
  async completeOAuth(input: {
    provider: 'github' | 'google'
    code: string
    state: string
    deviceId?: string
  }): Promise<SubscriptionLoginResponse> {
    const response = await this.request(`/v1/auth/oauth/${input.provider}/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: input.code,
        state: input.state,
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      }),
    })
    if (!response.ok) throw await this.toError(response, '第三方登录失败')
    return (await response.json()) as SubscriptionLoginResponse
  }

  async refresh(refreshToken: string): Promise<SubscriptionRefreshResponse> {
    const response = await this.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!response.ok) throw await this.toError(response, '会话刷新失败')
    return (await response.json()) as SubscriptionRefreshResponse
  }

  async logout(accessToken: string): Promise<void> {
    const response = await this.request('/v1/auth/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw await this.toError(response, '登出失败')
  }

  async getEntitlements(accessToken: string): Promise<{ entitlement: EntitlementSnapshot }> {
    const response = await this.request('/v1/entitlements', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw await this.toError(response, '获取权益失败')
    return (await response.json()) as { entitlement: EntitlementSnapshot }
  }

  async createCheckout(
    accessToken: string,
    input: { planId: string; provider: string; period: string },
  ): Promise<SubscriptionCheckoutResponse> {
    const response = await this.request('/v1/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw await this.toError(response, '创建支付失败')
    return (await response.json()) as SubscriptionCheckoutResponse
  }

  async getOrder(accessToken: string, orderId: string): Promise<SubscriptionOrderView> {
    const response = await this.request(`/v1/orders/${orderId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw await this.toError(response, '查询订单失败')
    return (await response.json()) as SubscriptionOrderView
  }

  /** 主动查单兜底，用于回调丢失时同步渠道支付状态 */
  async syncOrder(accessToken: string, orderId: string): Promise<SubscriptionOrderView> {
    const response = await this.request(`/v1/orders/${orderId}/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw await this.toError(response, '同步订单失败')
    return (await response.json()) as SubscriptionOrderView
  }
}
