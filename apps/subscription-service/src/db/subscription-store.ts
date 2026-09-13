import { randomUUID } from 'node:crypto'
import type { AgentRuntimePostgresClient } from '@gravitas/shared/utils'
import type { SubscriptionCapabilityId, SubscriptionPlanId } from '@gravitas/shared'

export type SubscriptionOrderStatus = 'pending' | 'paid' | 'cancelled' | 'refunded' | 'expired'
export type SubscriptionProvider = 'wechat-pay' | 'alipay'

export interface SubscriptionAccountRecord {
  id: string
  phoneHash?: string
  emailHash?: string
  emailVerifiedAt?: number
  oauthSubjectHash?: string
  displayName?: string
  disabledAt?: number
  createdAt: number
  updatedAt: number
}

export interface SubscriptionAuthSessionRecord {
  id: string
  accountId: string
  refreshTokenHash: string
  deviceId?: string
  revokedAt?: number
  expiresAt: number
  createdAt: number
}

export interface SubscriptionOrderRecord {
  id: string
  accountId: string
  planId: SubscriptionPlanId
  provider: SubscriptionProvider
  amountCny: number
  currency: 'CNY'
  status: SubscriptionOrderStatus
  period: 'monthly' | 'yearly'
  providerTransactionId?: string
  expiresAt: number
  paidAt?: number
  createdAt: number
  updatedAt: number
}

export interface SubscriptionPaymentEventRecord {
  id: string
  orderId: string
  provider: SubscriptionProvider
  eventType: string
  idempotencyKey: string
  verified: boolean
  payloadSummary: Record<string, unknown>
  createdAt: number
}

export interface SubscriptionEntitlementRevisionRecord {
  id: string
  accountId: string
  planId: SubscriptionPlanId
  capabilities: SubscriptionCapabilityId[]
  status: 'active' | 'expired' | 'revoked'
  validUntil?: number
  reason: string
  revision: number
  createdAt: number
}

export interface CreateOrderInput {
  accountId: string
  planId: SubscriptionPlanId
  provider: SubscriptionProvider
  amountCny: number
  period: 'monthly' | 'yearly'
  expiresAt: number
}

export interface MarkOrderPaidInput {
  orderId: string
  providerTransactionId: string
  paidAt: number
}

export class SubscriptionStore {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(schemaSql: string): Promise<void> {
    await this.client.query(schemaSql)
  }

  async createAccount(input: {
    phoneHash?: string
    emailHash?: string
    emailVerifiedAt?: number
    oauthSubjectHash?: string
    displayName?: string
  }): Promise<SubscriptionAccountRecord> {
    const now = Date.now()
    const record: SubscriptionAccountRecord = {
      id: randomUUID(),
      ...(input.phoneHash ? { phoneHash: input.phoneHash } : {}),
      ...(input.emailHash ? { emailHash: input.emailHash } : {}),
      ...(input.emailVerifiedAt ? { emailVerifiedAt: input.emailVerifiedAt } : {}),
      ...(input.oauthSubjectHash ? { oauthSubjectHash: input.oauthSubjectHash } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await this.client.query(
      `INSERT INTO subscription_accounts (id, phone_hash, email_hash, email_verified_at, oauth_subject_hash, display_name, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        record.id,
        record.phoneHash ?? null,
        record.emailHash ?? null,
        record.emailVerifiedAt ?? null,
        record.oauthSubjectHash ?? null,
        record.displayName ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    )
    return record
  }

  async findAccountById(accountId: string): Promise<SubscriptionAccountRecord | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, phone_hash, email_hash, email_verified_at, oauth_subject_hash, display_name, disabled_at, created_at, updated_at
       FROM subscription_accounts WHERE id = $1`,
      [accountId],
    )
    const row = result.rows[0]
    return row ? toAccountRecord(row) : undefined
  }

  async findAccountByPhoneHash(phoneHash: string): Promise<SubscriptionAccountRecord | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, phone_hash, email_hash, email_verified_at, oauth_subject_hash, display_name, disabled_at, created_at, updated_at
       FROM subscription_accounts WHERE phone_hash = $1`,
      [phoneHash],
    )
    const row = result.rows[0]
    return row ? toAccountRecord(row) : undefined
  }

  async findAccountByEmailHash(emailHash: string): Promise<SubscriptionAccountRecord | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, phone_hash, email_hash, email_verified_at, oauth_subject_hash, display_name, disabled_at, created_at, updated_at
       FROM subscription_accounts WHERE email_hash = $1`,
      [emailHash],
    )
    const row = result.rows[0]
    return row ? toAccountRecord(row) : undefined
  }

  /** 标记邮箱已验证 */
  async markEmailVerified(accountId: string, verifiedAt: number): Promise<void> {
    await this.client.query(
      `UPDATE subscription_accounts SET email_verified_at = $2, updated_at = $2 WHERE id = $1`,
      [accountId, verifiedAt],
    )
  }

  /**
   * 写入验证码记录。
   * 同一邮箱的旧验证码保留，校验时按创建时间倒序取最新一条。
   */
  async createEmailOtp(input: {
    emailHash: string
    codeHash: string
    purpose: string
    expiresAt: number
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO subscription_email_otp (id, email_hash, code_hash, purpose, attempt_count, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), input.emailHash, input.codeHash, input.purpose, 0, input.expiresAt, Date.now()],
    )
  }

  /** 取该邮箱最新的未消费验证码 */
  async findLatestEmailOtp(emailHash: string, now: number): Promise<
    | { id: string; codeHash: string; attemptCount: number; expiresAt: number }
    | undefined
  > {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, code_hash, attempt_count, expires_at
       FROM subscription_email_otp
       WHERE email_hash = $1 AND consumed_at IS NULL AND expires_at > $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [emailHash, now],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return {
      id: String(row.id),
      codeHash: String(row.code_hash),
      attemptCount: Number(row.attempt_count),
      expiresAt: Number(row.expires_at),
    }
  }

  /** 验证码校验失败时累加尝试次数，防止暴力破解 */
  async incrementEmailOtpAttempt(otpId: string): Promise<void> {
    await this.client.query(
      `UPDATE subscription_email_otp SET attempt_count = attempt_count + 1 WHERE id = $1`,
      [otpId],
    )
  }

  /** 标记验证码已使用，防止重放 */
  async consumeEmailOtp(otpId: string, consumedAt: number): Promise<void> {
    await this.client.query(
      `UPDATE subscription_email_otp SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL`,
      [otpId, consumedAt],
    )
  }

  /** 查询该邮箱最近一次发码时间，用于发送频率限制 */
  async findLastEmailOtpSentAt(emailHash: string): Promise<number | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT created_at FROM subscription_email_otp
       WHERE email_hash = $1
       ORDER BY created_at DESC LIMIT 1`,
      [emailHash],
    )
    const row = result.rows[0]
    return row ? Number(row.created_at) : undefined
  }

  /** 统计窗口内该邮箱的发码次数 */
  async countEmailOtpInWindow(emailHash: string, since: number): Promise<number> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS total FROM subscription_email_otp
       WHERE email_hash = $1 AND created_at >= $2`,
      [emailHash, since],
    )
    return Number(result.rows[0]?.total ?? 0)
  }

  /** 写入 OAuth state */
  async createOAuthState(input: {
    state: string
    provider: string
    redirectUri: string
    expiresAt: number
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO subscription_oauth_states (state, provider, redirect_uri, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.state, input.provider, input.redirectUri, input.expiresAt, Date.now()],
    )
  }

  /** 消费 OAuth state，返回是否有效。已消费或过期的 state 不可重复使用。 */
  async consumeOAuthState(
    state: string,
    now: number,
  ): Promise<{ provider: string; redirectUri: string } | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `UPDATE subscription_oauth_states
       SET consumed_at = $2
       WHERE state = $1 AND consumed_at IS NULL AND expires_at > $2
       RETURNING provider, redirect_uri`,
      [state, now],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return { provider: String(row.provider), redirectUri: String(row.redirect_uri) }
  }

  async createAuthSession(input: { accountId: string; refreshTokenHash: string; deviceId?: string; expiresAt: number }): Promise<SubscriptionAuthSessionRecord> {
    const record: SubscriptionAuthSessionRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      refreshTokenHash: input.refreshTokenHash,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    }
    await this.client.query(
      `INSERT INTO subscription_auth_sessions (id, account_id, refresh_token_hash, device_id, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [record.id, record.accountId, record.refreshTokenHash, record.deviceId ?? null, record.expiresAt, record.createdAt],
    )
    return record
  }

  async findAuthSessionByRefreshTokenHash(refreshTokenHash: string): Promise<SubscriptionAuthSessionRecord | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, account_id, refresh_token_hash, device_id, revoked_at, expires_at, created_at
       FROM subscription_auth_sessions WHERE refresh_token_hash = $1`,
      [refreshTokenHash],
    )
    const row = result.rows[0]
    return row ? toAuthSessionRecord(row) : undefined
  }

  async revokeAuthSession(sessionId: string): Promise<void> {
    await this.client.query(
      `UPDATE subscription_auth_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, Date.now()],
    )
  }

  async createOrder(input: CreateOrderInput): Promise<SubscriptionOrderRecord> {
    const now = Date.now()
    const record: SubscriptionOrderRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      planId: input.planId,
      provider: input.provider,
      amountCny: input.amountCny,
      currency: 'CNY',
      status: 'pending',
      period: input.period,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    }
    await this.client.query(
      `INSERT INTO subscription_orders (id, account_id, plan_id, provider, amount_cny, currency, status, period, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [record.id, record.accountId, record.planId, record.provider, record.amountCny, record.currency, record.status, record.period, record.expiresAt, record.createdAt, record.updatedAt],
    )
    return record
  }

  async findOrderById(orderId: string): Promise<SubscriptionOrderRecord | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, account_id, plan_id, provider, amount_cny, currency, status, period, provider_transaction_id, expires_at, paid_at, created_at, updated_at
       FROM subscription_orders WHERE id = $1`,
      [orderId],
    )
    const row = result.rows[0]
    return row ? toOrderRecord(row) : undefined
  }

  async markOrderPaid(input: MarkOrderPaidInput): Promise<SubscriptionOrderRecord | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `UPDATE subscription_orders
       SET status = 'paid', provider_transaction_id = $2, paid_at = $3, updated_at = $4
       WHERE id = $1 AND status = 'pending'
       RETURNING id, account_id, plan_id, provider, amount_cny, currency, status, period, provider_transaction_id, expires_at, paid_at, created_at, updated_at`,
      [input.orderId, input.providerTransactionId, input.paidAt, Date.now()],
    )
    const row = result.rows[0]
    return row ? toOrderRecord(row) : undefined
  }

  /**
   * 标记订单已退款。
   *
   * 条件限定为 status = 'paid'：只有已支付的订单才可能被退款，
   * 这样重复的退款通知第二次执行时不会命中任何行，天然幂等。
   */
  async markOrderRefunded(input: {
    orderId: string
    refundedAt: number
  }): Promise<SubscriptionOrderRecord | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `UPDATE subscription_orders
       SET status = 'refunded', updated_at = $2
       WHERE id = $1 AND status = 'paid'
       RETURNING id, account_id, plan_id, provider, amount_cny, currency, status, period, provider_transaction_id, expires_at, paid_at, created_at, updated_at`,
      [input.orderId, input.refundedAt],
    )
    const row = result.rows[0]
    return row ? toOrderRecord(row) : undefined
  }

  /** 撤销某账号当前所有生效中的订阅（退款或强制收回时使用） */
  async revokeActiveSubscriptions(input: {
    accountId: string
    revokedAt: number
  }): Promise<number> {
    const result = await this.client.query<Record<string, unknown>>(
      `UPDATE subscription_subscriptions
       SET status = 'revoked', updated_at = $2
       WHERE account_id = $1 AND status = 'active'
       RETURNING id`,
      [input.accountId, input.revokedAt],
    )
    return result.rows.length
  }

  /**
   * 找出所有已到期但仍标记为 active 的订阅，供定时任务降级。
   *
   * 限制返回条数避免单次扫描占用过多内存，由调用方循环处理。
   */
  async findExpiredActiveSubscriptions(input: {
    now: number
    limit: number
  }): Promise<Array<{ id: string; accountId: string; planId: SubscriptionPlanId; currentPeriodEnd: number }>> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, account_id, plan_id, current_period_end
       FROM subscription_subscriptions
       WHERE status = 'active' AND current_period_end <= $1
       ORDER BY current_period_end ASC
       LIMIT $2`,
      [input.now, input.limit],
    )
    return result.rows.map((row) => ({
      id: String(row.id),
      accountId: String(row.account_id),
      planId: String(row.plan_id) as SubscriptionPlanId,
      currentPeriodEnd: Number(row.current_period_end),
    }))
  }

  /** 将指定订阅标记为已过期 */
  async markSubscriptionExpired(input: { subscriptionId: string; expiredAt: number }): Promise<void> {
    await this.client.query(
      `UPDATE subscription_subscriptions
       SET status = 'expired', updated_at = $2
       WHERE id = $1 AND status = 'active'`,
      [input.subscriptionId, input.expiredAt],
    )
  }

  /** 查询账号当前生效的订阅完整信息，含状态，用于权益推导 */
  async findCurrentSubscription(accountId: string): Promise<
    | { id: string; planId: SubscriptionPlanId; status: 'active' | 'expired' | 'revoked'; currentPeriodEnd: number; orderId: string }
    | undefined
  > {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, plan_id, status, current_period_end, order_id
       FROM subscription_subscriptions
       WHERE account_id = $1
       ORDER BY current_period_end DESC
       LIMIT 1`,
      [accountId],
    )
    const row = result.rows[0]
    if (!row) return undefined
    return {
      id: String(row.id),
      planId: String(row.plan_id) as SubscriptionPlanId,
      status: String(row.status) as 'active' | 'expired' | 'revoked',
      currentPeriodEnd: Number(row.current_period_end),
      orderId: String(row.order_id),
    }
  }

  async insertPaymentEvent(input: Omit<SubscriptionPaymentEventRecord, 'id' | 'createdAt'>): Promise<SubscriptionPaymentEventRecord> {
    const record: SubscriptionPaymentEventRecord = {
      id: randomUUID(),
      ...input,
      createdAt: Date.now(),
    }
    await this.client.query(
      `INSERT INTO subscription_payment_events (id, order_id, provider, event_type, idempotency_key, verified, payload_summary, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [record.id, record.orderId, record.provider, record.eventType, record.idempotencyKey, record.verified, JSON.stringify(record.payloadSummary), record.createdAt],
    )
    return record
  }

  async findPaymentEventByIdempotencyKey(idempotencyKey: string): Promise<SubscriptionPaymentEventRecord | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, order_id, provider, event_type, idempotency_key, verified, payload_summary, created_at
       FROM subscription_payment_events WHERE idempotency_key = $1`,
      [idempotencyKey],
    )
    const row = result.rows[0]
    return row ? toPaymentEventRecord(row) : undefined
  }

  async createSubscription(input: { accountId: string; planId: SubscriptionPlanId; orderId: string; currentPeriodStart: number; currentPeriodEnd: number }): Promise<void> {
    const now = Date.now()
    await this.client.query(
      `INSERT INTO subscription_subscriptions (id, account_id, plan_id, order_id, status, current_period_start, current_period_end, auto_renew, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [randomUUID(), input.accountId, input.planId, input.orderId, 'active', input.currentPeriodStart, input.currentPeriodEnd, false, now, now],
    )
  }

  async findActiveSubscription(accountId: string, now: number): Promise<{ planId: SubscriptionPlanId; currentPeriodEnd: number } | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT plan_id, current_period_end
       FROM subscription_subscriptions
       WHERE account_id = $1 AND status = 'active' AND current_period_end > $2
       ORDER BY current_period_end DESC
       LIMIT 1`,
      [accountId, now],
    )
    const row = result.rows[0]
    return row ? { planId: String(row.plan_id) as SubscriptionPlanId, currentPeriodEnd: Number(row.current_period_end) } : undefined
  }

  async createEntitlementRevision(input: Omit<SubscriptionEntitlementRevisionRecord, 'id' | 'createdAt' | 'revision'> & { revision: number }): Promise<SubscriptionEntitlementRevisionRecord> {
    const record: SubscriptionEntitlementRevisionRecord = {
      id: randomUUID(),
      ...input,
      createdAt: Date.now(),
    }
    await this.client.query(
      `INSERT INTO subscription_entitlement_revisions (id, account_id, plan_id, capabilities, status, valid_until, reason, revision, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [record.id, record.accountId, record.planId, JSON.stringify(record.capabilities), record.status, record.validUntil ?? null, record.reason, record.revision, record.createdAt],
    )
    return record
  }

  async findLatestEntitlementRevision(accountId: string): Promise<SubscriptionEntitlementRevisionRecord | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT id, account_id, plan_id, capabilities, status, valid_until, reason, revision, created_at
       FROM subscription_entitlement_revisions
       WHERE account_id = $1
       ORDER BY revision DESC
       LIMIT 1`,
      [accountId],
    )
    const row = result.rows[0]
    return row ? toEntitlementRevisionRecord(row) : undefined
  }

  async nextEntitlementRevision(accountId: string): Promise<number> {
    const result = await this.client.query<{ revision: number | string | null }>(
      `SELECT MAX(revision) AS revision FROM subscription_entitlement_revisions WHERE account_id = $1`,
      [accountId],
    )
    return Number(result.rows[0]?.revision ?? 0) + 1
  }
}

function toAccountRecord(row: Record<string, unknown>): SubscriptionAccountRecord {
  return {
    id: String(row.id),
    ...(row.phone_hash == null ? {} : { phoneHash: String(row.phone_hash) }),
    ...(row.email_hash == null ? {} : { emailHash: String(row.email_hash) }),
    ...(row.email_verified_at == null ? {} : { emailVerifiedAt: Number(row.email_verified_at) }),
    ...(row.oauth_subject_hash == null ? {} : { oauthSubjectHash: String(row.oauth_subject_hash) }),
    ...(row.display_name == null ? {} : { displayName: String(row.display_name) }),
    ...(row.disabled_at == null ? {} : { disabledAt: Number(row.disabled_at) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function toAuthSessionRecord(row: Record<string, unknown>): SubscriptionAuthSessionRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    refreshTokenHash: String(row.refresh_token_hash),
    ...(row.device_id == null ? {} : { deviceId: String(row.device_id) }),
    ...(row.revoked_at == null ? {} : { revokedAt: Number(row.revoked_at) }),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
  }
}

function toOrderRecord(row: Record<string, unknown>): SubscriptionOrderRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    planId: String(row.plan_id) as SubscriptionPlanId,
    provider: String(row.provider) as SubscriptionProvider,
    amountCny: Number(row.amount_cny),
    currency: 'CNY',
    status: String(row.status) as SubscriptionOrderStatus,
    period: String(row.period) as 'monthly' | 'yearly',
    ...(row.provider_transaction_id == null ? {} : { providerTransactionId: String(row.provider_transaction_id) }),
    expiresAt: Number(row.expires_at),
    ...(row.paid_at == null ? {} : { paidAt: Number(row.paid_at) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function toPaymentEventRecord(row: Record<string, unknown>): SubscriptionPaymentEventRecord {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    provider: String(row.provider) as SubscriptionProvider,
    eventType: String(row.event_type),
    idempotencyKey: String(row.idempotency_key),
    verified: Boolean(row.verified),
    payloadSummary: JSON.parse(String(row.payload_summary ?? '{}')),
    createdAt: Number(row.created_at),
  }
}

function toEntitlementRevisionRecord(row: Record<string, unknown>): SubscriptionEntitlementRevisionRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    planId: String(row.plan_id) as SubscriptionPlanId,
    capabilities: JSON.parse(String(row.capabilities ?? '[]')) as SubscriptionCapabilityId[],
    status: String(row.status) as SubscriptionEntitlementRevisionRecord['status'],
    ...(row.valid_until == null ? {} : { validUntil: Number(row.valid_until) }),
    reason: String(row.reason),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
  }
}
