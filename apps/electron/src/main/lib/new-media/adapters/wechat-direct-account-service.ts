/**
 * 微信公众号 direct 账号配置服务。
 *
 * 职责边界：
 * - 只负责「保存凭据 + 记录账号档案 + 重新协商能力」，不发起任何网络调用。
 * - AppSecret 只写加密 Secret Store；账号记录里只有 AppID 与非敏感描述符。
 * - P2-02 之前账号状态不会被改成 connected；因此协商结果必然全部关闭，
 *   并给出 not_connected 原因，而不是假装能力可用。
 */
import { randomUUID } from 'node:crypto'
import type { NewMediaConnectedAccount, WechatDirectAccountProfile } from '@gravitas/shared'
import { PlatformAdapterError } from '../platform-adapter'
import { appendNewMediaAudit, createNewMediaAuditEntry } from '../new-media-audit'
import { getNewMediaCredentialProtection } from '../new-media-account-secret-store'
import { getWechatAccessToken, type WechatTokenDependencies } from './wechat-direct-token-service'
import {
  accountTypeLabel,
  negotiateWechatDirectCapabilities,
  toWechatPlatformCapabilities,
} from './wechat-direct-capability'
import {
  assertWechatDirectCredentialFormat,
  describeWechatDirectCredential,
  removeWechatDirectCredential,
  saveWechatDirectCredential,
} from './wechat-direct-credential'

const ACCOUNT_KIND = 'connected-account'

export interface WechatDirectConfigureInput {
  appId: string
  appSecret: string
  accountType: WechatDirectAccountProfile['accountType']
  verificationStatus: WechatDirectAccountProfile['verificationStatus']
  ipWhitelistConfigured: boolean
  /**
   * 平台已返回的接口权限名。只有真正调用过微信接口并拿到权限集时才可传入；
   * 在 P2-02 之前调用方必须传空数组。
   */
  grantedScopes?: string[]
}

export interface WechatDirectProfileUpdateInput {
  accountType?: WechatDirectAccountProfile['accountType']
  verificationStatus?: WechatDirectAccountProfile['verificationStatus']
  ipWhitelistConfigured?: boolean
  grantedScopes?: string[]
}

/** 平台是否已确认账号可用。P2-02 之前恒为 false。 */
function isPlatformConfirmed(account: NewMediaConnectedAccount): boolean {
  return account.status === 'connected'
}

function negotiateFor(account: NewMediaConnectedAccount, profile: WechatDirectAccountProfile) {
  return negotiateWechatDirectCapabilities({
    accountType: profile.accountType,
    verificationStatus: profile.verificationStatus,
    grantedScopes: profile.grantedScopes,
    ipWhitelistConfigured: profile.ipWhitelistConfigured,
    hasCredential: Boolean(account.credentialRef),
    connected: isPlatformConfirmed(account),
  })
}

export async function configureWechatDirectAccount(
  account: NewMediaConnectedAccount,
  input: WechatDirectConfigureInput,
): Promise<NewMediaConnectedAccount> {
  // 格式错误在写入前拒绝；错误信息不回显凭据内容。
  const { appId, appSecret } = assertWechatDirectCredentialFormat(input)
  if (!isPlatformConfirmed(account) && (input.grantedScopes?.length ?? 0) > 0) {
    throw new Error('账号尚未通过微信侧校验，不能写入接口权限集；请先完成 token 校验')
  }

  const credentialRef = account.credentialRef ?? randomUUID()
  saveWechatDirectCredential(credentialRef, { appId, appSecret }, { accessToken: '', scopes: [] })

  const profile: WechatDirectAccountProfile = {
    appId,
    accountType: input.accountType,
    verificationStatus: input.verificationStatus,
    grantedScopes: [],
    ipWhitelistConfigured: input.ipWhitelistConfigured,
  }
  const next: NewMediaConnectedAccount = {
    ...account,
    credentialRef,
    credentialProtection: getNewMediaCredentialProtection(),
    wechatDirect: profile,
    capabilityStates: [],
    updatedAt: Date.now(),
  }
  const negotiation = negotiateFor(next, profile)
  next.capabilityStates = negotiation.capabilities
  next.capabilities = toWechatPlatformCapabilities(negotiation)

  try {
    await appendNewMediaAudit(
      await createNewMediaAuditEntry({
        domain: 'account',
        event: 'authorization_started',
        actor: 'local-user',
        subjectId: account.id,
        detail: `已保存微信公众号凭据（${accountTypeLabel(profile.accountType)}，${profile.verificationStatus === 'verified' ? '已认证' : '未认证'}）；凭据仅写入加密存储，尚未通过微信侧校验。`,
        metadata: {
          appId: profile.appId,
          accountType: profile.accountType,
          verificationStatus: profile.verificationStatus,
          ipWhitelistConfigured: profile.ipWhitelistConfigured,
          enabledCapabilities: negotiation.enabledCapabilities.length,
        },
      }),
      [{ kind: ACCOUNT_KIND, value: next }],
    )
  } catch (error) {
    removeWechatDirectCredential(credentialRef)
    throw error
  }
  return next
}

export async function updateWechatDirectAccountProfile(
  account: NewMediaConnectedAccount,
  input: WechatDirectProfileUpdateInput,
): Promise<NewMediaConnectedAccount> {
  const current = account.wechatDirect
  if (!current) throw new Error('账号尚未配置微信公众号凭据')
  if (!isPlatformConfirmed(account) && (input.grantedScopes?.length ?? 0) > 0) {
    throw new Error('账号尚未通过微信侧校验，不能写入接口权限集；请先完成 token 校验')
  }
  const profile: WechatDirectAccountProfile = {
    ...current,
    accountType: input.accountType ?? current.accountType,
    verificationStatus: input.verificationStatus ?? current.verificationStatus,
    ipWhitelistConfigured: input.ipWhitelistConfigured ?? current.ipWhitelistConfigured,
    grantedScopes: input.grantedScopes ? [...input.grantedScopes] : [...current.grantedScopes],
  }
  const next: NewMediaConnectedAccount = { ...account, wechatDirect: profile, updatedAt: Date.now() }
  const negotiation = negotiateFor(next, profile)
  next.capabilityStates = negotiation.capabilities
  next.capabilities = toWechatPlatformCapabilities(negotiation)

  await appendNewMediaAudit(
    await createNewMediaAuditEntry({
      domain: 'account',
      event: 'authorization_started',
      actor: 'local-user',
      subjectId: account.id,
      detail: `已更新微信公众号账号档案：${accountTypeLabel(profile.accountType)}，${profile.verificationStatus === 'verified' ? '已认证' : '未认证'}，白名单${profile.ipWhitelistConfigured ? '已配置' : '未配置'}。`,
      metadata: {
        accountType: profile.accountType,
        verificationStatus: profile.verificationStatus,
        ipWhitelistConfigured: profile.ipWhitelistConfigured,
        grantedScopeCount: profile.grantedScopes.length,
        enabledCapabilities: negotiation.enabledCapabilities.length,
      },
    }),
    [{ kind: ACCOUNT_KIND, value: next }],
  )
  return next
}

/**
 * 用 stable token 校验凭据连接账号。
 *
 * 注意微信 direct 不会返回接口权限清单：token 只能证明凭据可用，
 * 不能证明任何业务接口已获授权。因此这里连接成功后 grantedScopes 仍为空，
 * 具体权限只能由 P2-03 之后的真实接口调用结果来观察（见 recordWechatObservedScopes）。
 */
export async function connectWechatDirectAccount(
  account: NewMediaConnectedAccount,
  dependencies: WechatTokenDependencies = {},
): Promise<NewMediaConnectedAccount> {
  const profile = account.wechatDirect
  if (!profile) throw new Error('账号尚未配置微信公众号凭据')
  if (!account.credentialRef) throw new Error('账号缺少凭据引用')

  try {
    const token = await getWechatAccessToken(account.credentialRef, { forceRefresh: true, dependencies })
    const next: NewMediaConnectedAccount = {
      ...account,
      status: 'connected',
      errorCode: undefined,
      authorizedAt: account.authorizedAt ?? Date.now(),
      expiresAt: token.expiresAt,
      lastValidatedAt: Date.now(),
      wechatDirect: { ...profile, stableTokenExpiresAt: token.expiresAt, lastTokenRefreshedAt: Date.now() },
      updatedAt: Date.now(),
    }
    const negotiation = negotiateFor(next, next.wechatDirect as WechatDirectAccountProfile)
    next.capabilityStates = negotiation.capabilities
    next.capabilities = toWechatPlatformCapabilities(negotiation)
    await appendNewMediaAudit(
      await createNewMediaAuditEntry({
        domain: 'account',
        event: 'connected',
        actor: 'local-user',
        subjectId: account.id,
        detail: '微信公众号凭据已通过 stable token 校验；接口权限仍需逐个调用观察，未观察到的能力保持关闭。',
        metadata: {
          appId: profile.appId,
          accountType: profile.accountType,
          tokenExpiresAt: token.expiresAt,
          enabledCapabilities: negotiation.enabledCapabilities.length,
        },
      }),
      [{ kind: ACCOUNT_KIND, value: next }],
    )
    return next
  } catch (error) {
    const code = error instanceof PlatformAdapterError ? error.code : 'temporarily_unavailable'
    const failed: NewMediaConnectedAccount = { ...account, status: 'error', errorCode: code, lastValidatedAt: Date.now(), updatedAt: Date.now() }
    await appendNewMediaAudit(
      await createNewMediaAuditEntry({
        domain: 'account',
        event: 'validation_failed',
        actor: 'local-user',
        subjectId: account.id,
        detail: `微信公众号凭据校验失败：${code}。${error instanceof Error ? error.message : ''}`,
        metadata: { appId: profile.appId, errorCode: code },
      }),
      [{ kind: ACCOUNT_KIND, value: failed }],
    )
    throw error
  }
}

/**
 * 记录一次真实接口调用观察到的权限。
 *
 * 微信不会主动返回权限清单，`48001 api unauthorized` 是唯一可靠的「未授权」信号。
 * 只有 P2-03 之后的真实调用才应调用本方法；本地不得凭账号类型推断权限。
 */
export async function recordWechatObservedScopes(
  account: NewMediaConnectedAccount,
  observation: { grantedScopes?: string[]; deniedScopes?: string[] },
): Promise<NewMediaConnectedAccount> {
  const profile = account.wechatDirect
  if (!profile) throw new Error('账号尚未配置微信公众号凭据')
  if (account.status !== 'connected') throw new Error('账号尚未连接，不能记录接口权限观察结果')

  const granted = new Set(profile.grantedScopes)
  let changed = false
  for (const scope of observation.grantedScopes ?? []) {
    const normalized = scope.trim().toLowerCase()
    if (!normalized || granted.has(normalized)) continue
    granted.add(normalized)
    changed = true
  }
  for (const scope of observation.deniedScopes ?? []) {
    const normalized = scope.trim().toLowerCase()
    if (!normalized) continue
    // 明确拒绝的权限必须移除，避免历史观察残留导致越权尝试。
    if (granted.delete(normalized)) changed = true
  }
  if (!changed) return account

  const next: NewMediaConnectedAccount = { ...account, wechatDirect: { ...profile, grantedScopes: [...granted] }, updatedAt: Date.now() }
  const negotiation = negotiateFor(next, next.wechatDirect as WechatDirectAccountProfile)
  next.capabilityStates = negotiation.capabilities
  next.capabilities = toWechatPlatformCapabilities(negotiation)

  await appendNewMediaAudit(
    await createNewMediaAuditEntry({
      domain: 'account',
      event: 'connected',
      actor: 'local-user',
      subjectId: account.id,
      detail: `已按真实接口调用结果更新微信接口权限：现有 ${granted.size} 项，启用能力 ${negotiation.enabledCapabilities.length} 项。`,
      metadata: { appId: profile.appId, grantedScopeCount: granted.size, enabledCapabilities: negotiation.enabledCapabilities.length },
    }),
    [{ kind: ACCOUNT_KIND, value: next }],
  )
  return next
}

/** 账号被删除/断开时清理凭据。凭据不存在时返回 false。 */
export function clearWechatDirectCredential(account: NewMediaConnectedAccount): boolean {
  return account.credentialRef ? removeWechatDirectCredential(account.credentialRef) : false
}

export { describeWechatDirectCredential }
