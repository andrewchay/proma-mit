import type { EntitlementSnapshot } from '@gravitas/shared'
import type { SubscriptionStore } from '../db/subscription-store'
import { hashRefreshToken as depsHashRefreshToken, type TokenService } from '../services/token-service'
import type { EntitlementService } from '../services/entitlement-service'

export interface AuthRouteDependencies {
  store: SubscriptionStore
  tokenService: TokenService
  entitlementService: EntitlementService
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

export async function handleLogin(
  request: Request,
  deps: AuthRouteDependencies,
): Promise<Response> {
  const body = await request.json().catch(() => undefined)
  const phone = typeof body?.phone === 'string' ? body.phone.trim() : ''
  const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : undefined
  if (!phone) return Response.json({ code: 'invalid_request', message: '缺少手机号', retryable: false }, { status: 400 })

  const phoneHash = hashPhone(phone)
  let account = await deps.store.findAccountByPhoneHash(phoneHash)
  if (!account) {
    account = await deps.store.createAccount({ phoneHash, ...(displayName ? { displayName } : {}) })
  }
  if (account.disabledAt) return Response.json({ code: 'account_disabled', message: '账号已禁用', retryable: false }, { status: 403 })

  const sessionId = deps.tokenService.createSessionId()
  const tokens = deps.tokenService.issueTokenPair(account.id, sessionId)
  await deps.store.createAuthSession({
    accountId: account.id,
    refreshTokenHash: tokens.refreshTokenHash,
    expiresAt: tokens.expiresAt,
  })

  const entitlement = await deps.entitlementService.issueEntitlement({
    accountId: account.id,
    planId: 'free',
    status: 'active',
    reason: 'account.login',
  })

  const response: LoginResponse = {
    accountId: account.id,
    ...(account.displayName ? { displayName: account.displayName } : {}),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    entitlement,
  }
  return Response.json(response)
}

export async function handleRefresh(
  request: Request,
  deps: AuthRouteDependencies,
): Promise<Response> {
  const body = await request.json().catch(() => undefined)
  const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken : ''
  if (!refreshToken) return Response.json({ code: 'invalid_request', message: '缺少 refreshToken', retryable: false }, { status: 400 })

  const session = await deps.store.findAuthSessionByRefreshTokenHash(hashRefreshToken(refreshToken))
  if (!session || session.revokedAt || session.expiresAt < Date.now()) {
    return Response.json({ code: 'invalid_refresh_token', message: '会话已失效', retryable: false }, { status: 401 })
  }

  const account = await deps.store.findAccountById(session.accountId)
  if (!account || account.disabledAt) return Response.json({ code: 'account_disabled', message: '账号不可用', retryable: false }, { status: 403 })

  const rotated = deps.tokenService.rotateRefreshToken()
  await deps.store.revokeAuthSession(session.id)
  await deps.store.createAuthSession({
    accountId: account.id,
    refreshTokenHash: rotated.refreshTokenHash,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    ...(session.deviceId ? { deviceId: session.deviceId } : {}),
  })

  const tokens = deps.tokenService.issueTokenPair(account.id, session.id)
  const entitlement = await deps.entitlementService.getCurrentSnapshot(account.id) ?? await deps.entitlementService.issueEntitlement({
    accountId: account.id,
    planId: 'free',
    status: 'active',
    reason: 'account.refresh',
  })

  const response: RefreshResponse = {
    accessToken: tokens.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
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
  if (!account) return Response.json({ code: 'account_not_found', message: '账号不存在', retryable: false }, { status: 404 })
  const entitlement = await deps.entitlementService.getCurrentSnapshot(accountId)
  return Response.json({ accountId: account.id, displayName: account.displayName, entitlement })
}

function hashPhone(phone: string): string {
  return `phone:${phone.replace(/\D/g, '')}`
}

function hashRefreshToken(refreshToken: string): string {
  return depsHashRefreshToken(refreshToken)
}
