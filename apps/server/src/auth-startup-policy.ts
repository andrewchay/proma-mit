export interface PromaWebAuthStartupPolicyInput {
  trustedHeaderAuth: boolean
  hostname: string
  nodeEnv?: string
}

/**
 * 可信 Header 只用于本机开发：部署到生产环境或监听非 loopback 地址时必须拒绝启动。
 * Header 本身不是可验证身份，不能作为公网服务的租户边界。
 */
export function assertTrustedHeaderAuthStartupPolicy(input: PromaWebAuthStartupPolicyInput): void {
  if (!input.trustedHeaderAuth) return

  if (input.nodeEnv !== 'development') {
    throw new Error('PROMA_WEB_TRUSTED_HEADER_AUTH 仅可在 NODE_ENV=development 时启用；生产环境必须使用 OIDC JWT')
  }

  if (!isLoopbackHostname(input.hostname)) {
    throw new Error('PROMA_WEB_TRUSTED_HEADER_AUTH 仅可监听 loopback 地址；请使用 127.0.0.1、::1 或 localhost')
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost'
}

/** 无鉴权会授予匿名管理员，仅限本机开发；可信 Header 有自己的启动限制。 */
export function assertNoneAuthStartupPolicy(input: { authMode: string; trustedHeaderAuth: boolean; hostname: string; nodeEnv?: string }): void {
  if (input.authMode !== 'none' || input.trustedHeaderAuth) return
  if (input.nodeEnv !== 'development' || !isLoopbackHostname(input.hostname)) {
    throw new Error('无鉴权模式仅可在 NODE_ENV=development 且监听本机地址时启用')
  }
}

/** 以明确配置的公开地址判断，不信任客户端提供的转发头。 */
export function resolveSecureSessionCookie(input: { publicBaseUrl?: string; hostname: string; nodeEnv?: string }): boolean {
  const localDevelopment = input.nodeEnv === 'development' && isLoopbackHostname(input.hostname)
  if (!input.publicBaseUrl) {
    if (localDevelopment) return false
    throw new Error('浏览器登录需要配置 HTTPS PROMA_WEB_PUBLIC_BASE_URL')
  }
  const url = new URL(input.publicBaseUrl)
  if (url.username || url.password) throw new Error('PROMA_WEB_PUBLIC_BASE_URL 不得包含凭据')
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:' && localDevelopment && isLoopbackHostname(url.hostname)) return false
  throw new Error('浏览器登录需要 HTTPS；仅本机开发允许 HTTP')
}

export interface PromaWebAuthModeStartupPolicyInput {
  trustedHeaderAuth: boolean
  authMode?: 'local' | 'oidc' | 'both' | 'none' | string
  hasLocalAdmin: boolean
  hasOidcClient: boolean
}

export function resolveDefaultAuthMode(hasOidc: boolean, hasLocalAdmin: boolean): 'local' | 'oidc' | 'both' | 'none' {
  return hasOidc ? (hasLocalAdmin ? 'both' : 'oidc') : hasLocalAdmin ? 'local' : 'none'
}

/**
 * authMode 启动策略：保证私有部署"登录闭环"被正确配置。
 * - local/both：必须提供 PROMA_WEB_ADMIN（本地 bootstrap 管理员）
 * - oidc/both：必须提供 OIDC client 配置（authorization endpoint 等由 index.ts 保证）
 * - 与 trustedHeaderAuth 互斥：可信 Header 是开发专用，启用时不得同时用 authMode
 */
export function assertAuthModeStartupPolicy(input: PromaWebAuthModeStartupPolicyInput): void {
  if (input.trustedHeaderAuth) return // trusted-header 模式不涉及 authMode

  const mode = input.authMode ?? 'none'
  if (mode === 'none') return // 无鉴权模式的环境边界由 assertNoneAuthStartupPolicy 校验。

  if (mode !== 'local' && mode !== 'oidc' && mode !== 'both') {
    throw new Error(`PROMA_WEB_AUTH_MODE 必须是 local|oidc|both|none 之一，收到: ${mode}`)
  }

  // local 或 both 需要本地管理员
  if ((mode === 'local' || mode === 'both') && !input.hasLocalAdmin) {
    throw new Error(`authMode=${mode} 需要配置 PROMA_WEB_ADMIN=<username>:<tenantId>:<password>`)
  }

  // oidc 或 both 需要 OIDC client
  if ((mode === 'oidc' || mode === 'both') && !input.hasOidcClient) {
    throw new Error(`authMode=${mode} 需要完整 OIDC 客户端配置（PROMA_WEB_OIDC_*）`)
  }
}
