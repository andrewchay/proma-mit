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
