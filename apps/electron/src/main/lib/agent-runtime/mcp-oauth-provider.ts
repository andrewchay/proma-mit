/**
 * MCP OAuth Client Provider
 *
 * 为 @modelcontextprotocol/sdk 的 http/sse transport 提供 OAuthClientProvider 实现，
 * 支持 authorization_code 与 client_credentials 两种 grant type。
 *
 * - token 通过 mcp-oauth-store 加密持久化。
 * - authorization_code 模式会调用系统浏览器打开授权页，并通过 proma://mcp-auth
 *   DeepLink 回调完成授权码交换。
 * - client_credentials 模式无用户交互，直接换取 access token。
 *
 * 通过动态导入 electron，避免在测试环境静态引入 electron 导致模块解析失败。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpServerAuthConfig } from '@proma/shared'
import { loadMcpOAuthTokens, saveMcpOAuthTokens, type McpOAuthTokens } from './mcp-oauth-store'

export interface McpOAuthProviderOptions {
  workspaceSlug: string
  serverName: string
  auth: McpServerAuthConfig
  /** 自定义打开授权页的方式，默认使用 electron.shell.openExternal */
  openExternal?: (url: string) => void | Promise<void>
}

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly stateValue: string
  private codeVerifierValue: string

  constructor(private readonly options: McpOAuthProviderOptions) {
    this.stateValue = randomUUID()
    this.codeVerifierValue = generateCodeVerifier()
  }

  get redirectUrl(): string | URL | undefined {
    // 使用 proma 自定义协议回调，URL 中携带 workspace/server 便于主进程路由
    return `proma://mcp-auth?workspace=${encodeURIComponent(this.options.workspaceSlug)}&server=${encodeURIComponent(this.options.serverName)}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [String(this.redirectUrl)],
      grant_types: this.grantTypes(),
      token_endpoint_auth_method: this.options.auth.clientSecret ? 'client_secret_basic' : 'none',
      client_name: 'Proma',
      scope: this.options.auth.scope,
    }
  }

  clientInformation(): OAuthClientInformation | undefined {
    if (!this.options.auth.clientId) return undefined
    const info: OAuthClientInformation = { client_id: this.options.auth.clientId }
    if (this.options.auth.clientSecret) {
      info.client_secret = this.options.auth.clientSecret
    }
    return info
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const stored = (await loadMcpOAuthTokens(this.options.workspaceSlug))[this.options.serverName]
    if (!stored) return undefined
    const nowSeconds = Math.floor(Date.now() / 1000)
    const expiresIn = stored.expiresAt && stored.expiresAt > nowSeconds ? stored.expiresAt - nowSeconds : undefined
    return {
      access_token: stored.accessToken,
      token_type: 'Bearer',
      refresh_token: stored.refreshToken,
      expires_in: expiresIn,
      scope: stored.scope,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const all = await loadMcpOAuthTokens(this.options.workspaceSlug)
    const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined
    const stored: McpOAuthTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
      scope: tokens.scope,
    }
    all[this.options.serverName] = stored
    await saveMcpOAuthTokens(this.options.workspaceSlug, all)
    console.log(`[MCP OAuth] token 已保存: ${this.options.workspaceSlug}/${this.options.serverName}`)
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    console.log(`[MCP OAuth] 打开授权页: ${authorizationUrl.toString()}`)
    if (this.options.openExternal) {
      await this.options.openExternal(authorizationUrl.toString())
      return
    }
    const { shell } = await import('electron')
    await shell.openExternal(authorizationUrl.toString())
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier
  }

  async codeVerifier(): Promise<string> {
    return this.codeVerifierValue
  }

  state(): string | Promise<string> {
    return this.stateValue
  }

  prepareTokenRequest(scope?: string): URLSearchParams | undefined | Promise<URLSearchParams | undefined> | undefined {
    if (this.options.auth.type === 'oauthClientCredentials') {
      const params = new URLSearchParams()
      params.set('grant_type', 'client_credentials')
      const scopeValue = scope || this.options.auth.scope
      if (scopeValue) params.set('scope', scopeValue)
      return params
    }
    // authorization_code 走 SDK 默认逻辑（code + code_verifier + redirect_uri）
    return undefined
  }

  private grantTypes(): string[] {
    switch (this.options.auth.type) {
      case 'oauthClientCredentials':
        return ['client_credentials']
      case 'oauthAuthorizationCode':
        return ['authorization_code']
      default:
        return []
    }
  }
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}
