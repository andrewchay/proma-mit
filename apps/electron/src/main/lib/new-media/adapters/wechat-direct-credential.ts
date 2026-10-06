/**
 * 微信公众号 direct（自有账号直连）凭据模型。
 *
 * 设计要点：
 * - AppID 不是秘密，可以作为账号元数据保存在业务数据库；
 *   AppSecret 必须只进入主进程加密 Secret Store，任何界面、日志、审计都不得出现。
 * - 本地只做格式与一致性校验，不在这里发起任何网络请求；真实换取
 *   stable token 属于 P2-02，只有拿到平台返回值才可进入 connected。
 * - 出口 IP 白名单是微信侧的前置条件，本地只能记录「是否已配置」，
 *   不能代替平台校验结果。
 */
import type { WechatAccountType, WechatDirectAccountProfile, WechatVerificationStatus } from '@gravitas/shared'
import type { AuthorizationMaterial } from '../platform-adapter'
import { getNewMediaCredentialProtection, loadNewMediaAccountSecret, removeNewMediaAccountSecret, saveNewMediaAccountSecret } from '../new-media-account-secret-store'

/** 微信 AppID 形如 wx + 16 位十六进制。 */
const APP_ID_PATTERN = /^wx[0-9a-f]{16}$/i
/** AppSecret 为 32 位十六进制；平台通常只展示一次，发现后必须立即保存。 */
const APP_SECRET_PATTERN = /^[0-9a-f]{32}$/i

export type { WechatAccountType, WechatDirectAccountProfile, WechatVerificationStatus }

export interface WechatDirectCredentialInput {
  appId: string
  appSecret: string
}

/** 微信侧授权材料：AccessToken/RefreshToken 复用统一凭据结构。 */
export interface WechatDirectAuthorizationMaterial extends AuthorizationMaterial {
  appId: string
  appSecret: string
}

/** 可以安全展示与持久化的非敏感信息。 */
export interface WechatDirectCredentialDescriptor {
  appId: string
  credentialRef: string
  credentialProtection: 'none' | 'encrypted' | 'degraded'
  hasAppSecret: boolean
  hasAccessToken: boolean
  tokenExpiresAt?: number
}

export function isValidWechatAppId(value: unknown): value is string {
  return typeof value === 'string' && APP_ID_PATTERN.test(value.trim())
}

export function isValidWechatAppSecret(value: unknown): value is string {
  return typeof value === 'string' && APP_SECRET_PATTERN.test(value.trim())
}

/**
 * 校验凭据格式。错误信息不回显任何凭据内容，只说明问题所在。
 */
export function assertWechatDirectCredentialFormat(input: WechatDirectCredentialInput): { appId: string; appSecret: string } {
  const appId = String(input.appId ?? '').trim()
  const appSecret = String(input.appSecret ?? '').trim()
  if (!appId) throw new Error('AppID 不能为空')
  if (!APP_ID_PATTERN.test(appId)) throw new Error('AppID 格式不正确：应为 wx 开头的 16 位十六进制字符串')
  if (!appSecret) throw new Error('AppSecret 不能为空')
  if (!APP_SECRET_PATTERN.test(appSecret)) throw new Error('AppSecret 格式不正确：应为 32 位十六进制字符串')
  return { appId, appSecret }
}

/**
 * 保存微信 direct 凭据：仅写入主进程加密 Secret Store。
 * 返回的描述符不含任何密钥内容，可以安全进入业务数据库或 UI。
 */
export function saveWechatDirectCredential(
  credentialRef: string,
  input: WechatDirectCredentialInput,
  extra: Pick<WechatDirectAuthorizationMaterial, 'accessToken' | 'refreshToken' | 'expiresAt' | 'scopes'> = { accessToken: '' },
): WechatDirectCredentialDescriptor {
  if (!credentialRef.trim()) throw new Error('凭据引用不能为空')
  const { appId, appSecret } = assertWechatDirectCredentialFormat(input)
  const material: WechatDirectAuthorizationMaterial = { ...extra, appId, appSecret }
  saveNewMediaAccountSecret(credentialRef, material)
  return describeWechatDirectCredential(credentialRef)
}

export function loadWechatDirectCredential(credentialRef: string): WechatDirectAuthorizationMaterial | undefined {
  const material = loadNewMediaAccountSecret(credentialRef) as WechatDirectAuthorizationMaterial | undefined
  if (!material || !material.appSecret) return undefined
  return material
}

export function removeWechatDirectCredential(credentialRef: string): boolean {
  return removeNewMediaAccountSecret(credentialRef)
}

export function describeWechatDirectCredential(credentialRef: string): WechatDirectCredentialDescriptor {
  const material = loadNewMediaAccountSecret(credentialRef) as WechatDirectAuthorizationMaterial | undefined
  return {
    appId: material?.appId ?? '',
    credentialRef,
    credentialProtection: material ? getNewMediaCredentialProtection() : 'none',
    hasAppSecret: Boolean(material?.appSecret),
    hasAccessToken: Boolean(material?.accessToken),
    tokenExpiresAt: material?.expiresAt,
  }
}

/**
 * 生成可写入业务数据库的账号能力入参片段。
 * 注意：这里只做投影，不包含 appSecret。
 */
export function toWechatDirectAccountMetadata(profile: WechatDirectAccountProfile): Omit<WechatDirectAccountProfile, never> {
  return { ...profile, grantedScopes: [...profile.grantedScopes] }
}
