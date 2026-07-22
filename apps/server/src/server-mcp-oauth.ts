import type { McpServerEntry } from '@proma/shared'
import type { TenantMcpOAuthTokens } from '@proma/shared/utils'

export interface ServerMcpOAuthStartInput {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  scope?: string
  state: string
}

/** 构造 OAuth 授权码跳转；state 由上层持久化并绑定 tenant/user/workspace/server。 */
export function createMcpOAuthAuthorizationUrl(input: ServerMcpOAuthStartInput): string {
  const url = new URL(input.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  if (input.scope) url.searchParams.set('scope', input.scope)
  return url.toString()
}

export async function exchangeMcpAuthorizationCode(entry: McpServerEntry, code: string, clientSecret?: string): Promise<TenantMcpOAuthTokens> {
  const auth = entry.auth
  if (auth?.type !== 'oauthAuthorizationCode' || !auth.tokenEndpoint || !auth.clientId || !auth.redirectUri) {
    throw new Error('MCP OAuth 授权码配置不完整')
  }
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: auth.clientId, redirect_uri: auth.redirectUri })
  if (clientSecret) form.set('client_secret', clientSecret)
  const response = await fetch(auth.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })
  if (!response.ok) throw new Error(`MCP OAuth 换取 token 失败: HTTP ${response.status}`)
  const body = await response.json() as unknown
  if (!body || typeof body !== 'object' || !('access_token' in body) || typeof body.access_token !== 'string') throw new Error('MCP OAuth 响应缺少 access_token')
  return {
    accessToken: body.access_token,
    refreshToken: 'refresh_token' in body && typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: 'expires_in' in body && typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1_000 : undefined,
    raw: body,
  }
}
