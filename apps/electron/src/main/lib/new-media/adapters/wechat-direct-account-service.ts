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
import { appendNewMediaAudit, createNewMediaAuditEntry } from '../new-media-audit'
import { getNewMediaCredentialProtection } from '../new-media-account-secret-store'
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

/** 账号被删除/断开时清理凭据。凭据不存在时返回 false。 */
export function clearWechatDirectCredential(account: NewMediaConnectedAccount): boolean {
  return account.credentialRef ? removeWechatDirectCredential(account.credentialRef) : false
}

export { describeWechatDirectCredential }
