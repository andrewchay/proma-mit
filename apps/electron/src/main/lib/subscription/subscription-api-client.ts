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

export class SubscriptionApiClient {
  constructor(private readonly config: SubscriptionApiConfig) {}

  async login(input: { phone: string; displayName?: string }): Promise<SubscriptionLoginResponse> {
    const response = await fetch(`${this.config.baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(`login failed: ${response.status}`)
    return (await response.json()) as SubscriptionLoginResponse
  }

  async refresh(refreshToken: string): Promise<SubscriptionRefreshResponse> {
    const response = await fetch(`${this.config.baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!response.ok) throw new Error(`refresh failed: ${response.status}`)
    return (await response.json()) as SubscriptionRefreshResponse
  }

  async getEntitlements(accessToken: string): Promise<{ entitlement: EntitlementSnapshot }> {
    const response = await fetch(`${this.config.baseUrl}/v1/entitlements`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw new Error(`get entitlements failed: ${response.status}`)
    return (await response.json()) as { entitlement: EntitlementSnapshot }
  }

  async createCheckout(accessToken: string, input: { planId: string; provider: string; period: string }): Promise<SubscriptionCheckoutResponse> {
    const response = await fetch(`${this.config.baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(`checkout failed: ${response.status}`)
    return (await response.json()) as SubscriptionCheckoutResponse
  }

  async getOrder(accessToken: string, orderId: string): Promise<{ order: { id: string; status: string } }> {
    const response = await fetch(`${this.config.baseUrl}/v1/orders/${orderId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw new Error(`get order failed: ${response.status}`)
    return (await response.json()) as { order: { id: string; status: string } }
  }
}
