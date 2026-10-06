import type { EntitlementSnapshot } from '@gravitas/shared'
import type { SubscriptionStore } from '../db/subscription-store'
import { hashRefreshToken as depsHashRefreshToken, type TokenService } from '../services/token-service'
import type { EntitlementService } from '../services/entitlement-service'
import {
  normalizeEmail,
  hashEmail,
  generateOtpCode,
  hashOtpCode,
  verifyOtpCode,
  isOtpExpired,
  canResendOtp,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
} from '../services/email-otp'
import type { EmailSender } from '../services/email-sender'
import {
  generateOAuthState,
  resolveGitHubIdentity,
  resolveGoogleIdentity,
  OAUTH_STATE_TTL_MS,
  type OAuthProviderId,
} from '../services/oauth'

/**
 * 认证路由。
 *
 * 登录方式（两种，账号按邮箱归并）：
 * 1. 邮箱验证码：POST /v1/auth/email/request → POST /v1/auth/email/verify
 * 2. OAuth：GET /v1/auth/oauth/:provider/start → POST /v1/auth/oauth/:provider/callback
 *
 * 已移除原「仅凭手机号即登录」的路径：那等于知道手机号就能接管账号。
 */

export interface AuthRouteDependencies {
  store: SubscriptionStore
  tokenService: TokenService
  entitlementService: EntitlementService
  emailSender: EmailSender
  /** 邮箱与验证码哈希使用的服务端 pepper */
  emailPepper: string
}

export interface LoginResponse {
  accountId: string
  displayName?: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  entitlement: EntitlementSnapshot
}

export interface RefreshResponse {
  accessToken: string
  refreshToken: string
  expiresAt: number
  entitlement: EntitlementSnapshot
}

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

function jsonError(code: string, message: string, status: number, retryable = false): Response {
  return Response.json({ code, message, retryable }, { status })
}

/** 登录成功后统一签发 token 并确保存在权益快照 */
async function completeLogin(
  deps: AuthRouteDependencies,
  params: {
    account: { id: string; displayName?: string }
    deviceId?: string
  },
): Promise<Response> {
  const sessionId = deps.tokenService.createSessionId()
  const tokens = deps.tokenService.issueTokenPair(params.account.id, sessionId)

  await deps.store.createAuthSession({
    accountId: params.account.id,
    refreshTokenHash: tokens.refreshTokenHash,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    ...(params.deviceId ? { deviceId: params.deviceId } : {}),
  })

  const entitlement =
    (await deps.entitlementService.getCurrentSnapshot(params.account.id)) ??
    (await deps.entitlementService.issueEntitlement({
      accountId: params.account.id,
      planId: 'free',
      status: 'active',
      reason: 'account.login',
    }))

  const response: LoginResponse = {
    accountId: params.account.id,
    ...(params.account.displayName ? { displayName: params.account.displayName } : {}),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    entitlement,
  }
  return Response.json(response)
}

/**
 * 第一步：请求邮箱验证码。
 *
 * 无论邮箱是否已注册都返回相同响应，避免账号枚举。
 * 邮箱未注册时在验证通过后才创建账号。
 */
export async function handleRequestEmailOtp(
  request: Request,
  deps: AuthRouteDependencies,
): Promise<Response> {
  const body = await request.json().catch(() => undefined)
  const rawEmail = typeof body?.email === 'string' ? body.email : ''
  const email = normalizeEmail(rawEmail)

  // 邮箱格式非法：仍返回统一成功响应，不暴露格式校验细节
  if (!email) {
    return Response.json({ ok: true, expiresInSeconds: Math.floor(OTP_TTL_MS / 1000) })
  }

  const emailHash = hashEmail(email, deps.emailPepper)
  const now = Date.now()

  // 发送频率限制：同一邮箱两次发码之间有最小间隔
  const lastSentAt = await deps.store.findLastEmailOtpSentAt(emailHash)
  if (!canResendOtp(lastSentAt, now)) {
    return jsonError('too_many_requests', '请求过于频繁，请稍后再试', 429, true)
  }

  const code = generateOtpCode()
  await deps.store.createEmailOtp({
    emailHash,
    codeHash: hashOtpCode(code, deps.emailPepper, emailHash),
    purpose: 'login',
    expiresAt: now + OTP_TTL_MS,
  })

  const outcome = await deps.emailSender.sendOtpEmail({
    to: email,
    code,
    expiresMinutes: Math.floor(OTP_TTL_MS / 60000),
  })

  if (!outcome.ok) {
    // 邮件服务不可用是服务端问题，需要让用户知道可以重试，
    // 但不泄露具体内部原因
    return jsonError('email_send_failed', '验证码发送失败，请稍后重试', 503, true)
  }

  return Response.json({ ok: true, expiresInSeconds: Math.floor(OTP_TTL_MS / 1000) })
}

/**
 * 第二步：校验验证码并登录。
 *
 * 校验失败会累加尝试次数，达到上限后该验证码作废，防止暴力破解。
 */
export async function handleVerifyEmailOtp(
  request: Request,
  deps: AuthRouteDependencies,
): Promise<Response> {
  const body = await request.json().catch(() => undefined)
  const email = normalizeEmail(typeof body?.email === 'string' ? body.email : '')
  const code = typeof body?.code === 'string' ? body.code.trim() : ''
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : undefined

  if (!email || !code) {
    return jsonError('invalid_request', '缺少邮箱或验证码', 400)
  }

  const emailHash = hashEmail(email, deps.emailPepper)
  const now = Date.now()

  const otp = await deps.store.findLatestEmailOtp(emailHash, now)
  if (!otp || isOtpExpired(otp.expiresAt, now)) {
    return jsonError('invalid_code', '验证码无效或已过期', 400)
  }

  if (otp.attemptCount >= OTP_MAX_ATTEMPTS) {
    return jsonError('too_many_attempts', '尝试次数过多，请重新获取验证码', 429)
  }

  const matched = verifyOtpCode(code, otp.codeHash, deps.emailPepper, emailHash)
  if (!matched) {
    await deps.store.incrementEmailOtpAttempt(otp.id)
    return jsonError('invalid_code', '验证码无效或已过期', 400)
  }

  // 立刻消费验证码，防止重放
  await deps.store.consumeEmailOtp(otp.id, now)

  let account = await deps.store.findAccountByEmailHash(emailHash)
  if (!account) {
    account = await deps.store.createAccount({
      emailHash,
      emailVerifiedAt: now,
      displayName: email.split('@')[0],
    })
  } else if (!account.emailVerifiedAt) {
    await deps.store.markEmailVerified(account.id, now)
  }

  if (account.disabledAt) {
    return jsonError('account_disabled', '账号已禁用', 403)
  }

  return completeLogin(deps, {
    account: {
      id: account.id,
      ...(account.displayName ? { displayName: account.displayName } : {}),
    },
    ...(deviceId ? { deviceId } : {}),
  })
}

export interface OAuthStartInput {
  provider: string
  redirectUri: string
  clientId: string
}

export async function handleOAuthStart(
  deps: AuthRouteDependencies,
  input: OAuthStartInput,
): Promise<Response> {
  if (input.provider !== 'github' && input.provider !== 'google') {
    return jsonError('unsupported_provider', '不支持的登录方式', 400)
  }
  if (!input.clientId || !input.redirectUri) {
    return jsonError('provider_not_configured', '登录方式未配置', 503)
  }

  const state = generateOAuthState()
  await deps.store.createOAuthState({
    state,
    provider: input.provider,
    redirectUri: input.redirectUri,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
  })

  const { buildGitHubAuthorizeUrl, buildGoogleAuthorizeUrl } = await import('../services/oauth')
  const authorizeUrl =
    input.provider === 'github'
      ? buildGitHubAuthorizeUrl({
          clientId: input.clientId,
          redirectUri: input.redirectUri,
          state,
        })
      : buildGoogleAuthorizeUrl({
          clientId: input.clientId,
          redirectUri: input.redirectUri,
          state,
        })

  return Response.json({ authorizeUrl, state, expiresInSeconds: Math.floor(OAUTH_STATE_TTL_MS / 1000) })
}

export interface OAuthCallbackInput {
  provider: OAuthProviderId
  code: string
  state: string
  clientId: string
  clientSecret: string
  deviceId?: string
}

export async function handleOAuthCallback(
  deps: AuthRouteDependencies,
  input: OAuthCallbackInput,
): Promise<Response> {
  const now = Date.now()

  // state 一次性消费：防 CSRF，且阻止回调重放
  const stateRecord = await deps.store.consumeOAuthState(input.state, now)
  if (!stateRecord) {
    return jsonError('invalid_state', '登录会话已失效，请重新登录', 400)
  }
  if (stateRecord.provider !== input.provider) {
    return jsonError('invalid_state', '登录方式不匹配', 400)
  }

  let identity
  try {
    identity =
      input.provider === 'github'
        ? await resolveGitHubIdentity({
            code: input.code,
            clientId: input.clientId,
            clientSecret: input.clientSecret,
            redirectUri: stateRecord.redirectUri,
          })
        : await resolveGoogleIdentity({
            code: input.code,
            clientId: input.clientId,
            clientSecret: input.clientSecret,
            redirectUri: stateRecord.redirectUri,
          })
  } catch (error) {
    return jsonError(
      'oauth_failed',
      error instanceof Error ? error.message : '第三方登录失败',
      400,
    )
  }

  const emailHash = hashEmail(identity.email, deps.emailPepper)
  const oauthSubjectHash = hashEmail(`${identity.provider}:${identity.subjectId}`, deps.emailPepper)

  // 优先按邮箱归并：同一邮箱用验证码或 OAuth 登录都指向同一账号
  let account = await deps.store.findAccountByEmailHash(emailHash)
  if (!account) {
    account = await deps.store.createAccount({
      emailHash,
      emailVerifiedAt: now,
      oauthSubjectHash,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
    })
  } else if (!account.emailVerifiedAt) {
    await deps.store.markEmailVerified(account.id, now)
  }

  if (account.disabledAt) {
    return jsonError('account_disabled', '账号已禁用', 403)
  }

  return completeLogin(deps, {
    account: {
      id: account.id,
      ...(account.displayName ? { displayName: account.displayName } : {}),
    },
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
  })
}

export async function handleRefresh(
  request: Request,
  deps: AuthRouteDependencies,
): Promise<Response> {
  const body = await request.json().catch(() => undefined)
  const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : ''
  if (!refreshToken) return jsonError('invalid_request', '缺少 refreshToken', 400)

  const session = await deps.store.findAuthSessionByRefreshTokenHash(hashRefreshToken(refreshToken))
  if (!session || session.revokedAt || session.expiresAt < Date.now()) {
    return jsonError('invalid_refresh_token', '会话已失效', 401)
  }

  const account = await deps.store.findAccountById(session.accountId)
  if (!account || account.disabledAt) return jsonError('account_disabled', '账号不可用', 403)

  const rotated = deps.tokenService.rotateRefreshToken()
  // 先吊销旧会话，再创建新会话，并把 access token 绑定到**新会话 id**。
  // 此前的实现把新 refresh token 存进新会话却把 access token 的 sid 指向已吊销的旧会话，
  // 导致登出时 revokeAuthSession 命中 0 行，登出形同虚设。
  await deps.store.revokeAuthSession(session.id)
  const newSession = await deps.store.createAuthSession({
    accountId: account.id,
    refreshTokenHash: rotated.refreshTokenHash,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    ...(session.deviceId ? { deviceId: session.deviceId } : {}),
  })

  const tokens = deps.tokenService.issueTokenPair(account.id, newSession.id)
  const entitlement =
    (await deps.entitlementService.getCurrentSnapshot(account.id)) ??
    (await deps.entitlementService.issueEntitlement({
      accountId: account.id,
      planId: 'free',
      status: 'active',
      reason: 'account.refresh',
    }))

  const response: RefreshResponse = {
    accessToken: tokens.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    entitlement,
  }
  return Response.json(response)
}

export async function handleLogout(
  request: Request,
  deps: AuthRouteDependencies,
  sessionId: string,
): Promise<Response> {
  await deps.store.revokeAuthSession(sessionId)
  return Response.json({ ok: true })
}

export async function handleMe(
  deps: AuthRouteDependencies,
  accountId: string,
): Promise<Response> {
  const account = await deps.store.findAccountById(accountId)
  if (!account) return jsonError('account_not_found', '账号不存在', 404)
  const entitlement = await deps.entitlementService.getCurrentSnapshot(accountId)
  return Response.json({
    accountId: account.id,
    ...(account.displayName ? { displayName: account.displayName } : {}),
    entitlement,
  })
}

function hashRefreshToken(refreshToken: string): string {
  return depsHashRefreshToken(refreshToken)
}
