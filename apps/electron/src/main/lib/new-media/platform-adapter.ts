import type {
  NewMediaAdapterInfo,
  NewMediaAuthorizationMethod,
  NewMediaConnectedAccount,
  NewMediaPlatform,
  NewMediaPlatformCapabilities,
} from '@gravitas/shared'

export interface AuthorizationMaterial {
  accessToken: string
  refreshToken?: string
  clientSecret?: string
  expiresAt?: number
  scopes?: string[]
}

export interface AuthorizationValidationResult {
  externalAccountId: string
  displayName?: string
  grantedScopes: string[]
  expiresAt?: number
}

export interface AuthorizationDescriptor {
  method: NewMediaAuthorizationMethod
  available: boolean
  description: string
  requestedScopes: string[]
}

export interface PlatformAdapter {
  readonly platform: NewMediaPlatform
  readonly displayName: string
  readonly authorization: AuthorizationDescriptor
  getCapabilities(account?: NewMediaConnectedAccount): NewMediaPlatformCapabilities
  beginAuthorization(account: NewMediaConnectedAccount): Promise<void>
  validateAuthorization(material: AuthorizationMaterial, account: NewMediaConnectedAccount): Promise<AuthorizationValidationResult>
  revokeAuthorization?(material: AuthorizationMaterial, account: NewMediaConnectedAccount): Promise<void>
}

export type PlatformAdapterErrorCode =
  | 'authorization_unavailable'
  | 'invalid_credentials'
  | 'expired'
  | 'insufficient_scope'
  | 'temporarily_unavailable'
  | 'adapter_not_found'
  /** 出口 IP 不在平台白名单内：需要用户去平台后台配置，而不是重试。 */
  | 'ip_not_whitelisted'
  /** 素材类型不被平台接受（类型与模式组合错误）。 */
  | 'invalid_media_type'
  /** 素材格式不被平台接受。 */
  | 'invalid_media_format'
  /** 素材体积超出平台上限。 */
  | 'invalid_media_size'
  /** 平台侧 media_id 无效或已删除。 */
  | 'invalid_media_id'

export class PlatformAdapterError extends Error {
  constructor(readonly code: PlatformAdapterErrorCode, message: string) {
    super(message)
    this.name = 'PlatformAdapterError'
  }
}

export function adapterInfo(adapter: PlatformAdapter): NewMediaAdapterInfo {
  return {
    platform: adapter.platform,
    displayName: adapter.displayName,
    authorizationMethod: adapter.authorization.method,
    authorizationAvailable: adapter.authorization.available,
    authorizationDescription: adapter.authorization.description,
    requestedScopes: [...adapter.authorization.requestedScopes],
    capabilities: adapter.getCapabilities(),
  }
}

export const LOCAL_ONLY_CAPABILITIES: NewMediaPlatformCapabilities = {
  localDraft: true,
  remoteDraft: false,
  publish: false,
  readEngagements: false,
  sendReply: false,
  readMetrics: false,
}
