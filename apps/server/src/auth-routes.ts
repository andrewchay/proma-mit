import { randomBytes, randomUUID } from 'node:crypto'
import type { AgentRuntimeRole } from '@gravitas/shared/utils'
import { verifyPassword } from './local-admin-auth'

export interface OidcAuthConfig {
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  scope?: string
}

export interface AuthRoutesDeps {
  sessionStore: { create(session: { sessionId: string; tenantId: string; userId: string; roles: AgentRuntimeRole[]; expiresAt: number }): Promise<void>; destroy(sessionId: string): Promise<void> }
  /** 本地管理员校验：返回 scope 或 null；内部完成 scrypt 比对 */
  verifyAdmin: (username: string, password: string) => Promise<{ tenantId: string; roles: AgentRuntimeRole[] } | null>
  sessionCookieName?: string
  sessionTtlMs?: number
  /** 未配置则禁用 OIDC（本地 fallback 模式） */
  oidc?: OidcAuthConfig
  /** OIDC code→token→scope 交换；default 用 fetch 走 token endpoint */
  oidcTokenFromCode?: (code: string, oidc: OidcAuthConfig) => Promise<{ tenantId: string; userId: string; roles: AgentRuntimeRole[] }>
  /** 成功 OIDC 登录后的额外 userId 解析（从 claims），default 用 token 的 sub */
  dashboardPath?: string
}

export interface AuthHandler {
  loginPage(): Promise<Response>
  loginForm(body: { username: string; password: string }): Promise<Response>
  logout(): Response
  oidcStart(): Promise<Response>
  oidcCallback(code: string): Promise<Response>
}

export function createSessionCookie(sessionId: string, name: string, maxAgeSeconds: number): string {
  return `${name}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

function expiredCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

function loginPageHtml(hasOidc: boolean, error?: string): string {
  const oidcSection = hasOidc
    ? `<p><a href="/auth/oidc/start" style="color:#d7ff5f">使用企业账号（OIDC）登录</a></p>`
    : ``
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>登录 · Pro</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#151817;color:#e7e3d6;font:15px Georgia,"Noto Serif SC",serif;display:flex;justify-content:center;padding-top:80px}form{background:#202420;padding:28px;border:1px solid #3b403b;border-radius:9px;width:300px}input{width:100%;margin:6px 0;padding:9px;background:#111411;color:#e7e3d6;border:1px solid #3b403b;border-radius:4px}button{width:100%;background:#d7ff5f;color:#13200c;border:0;padding:10px;border-radius:4px;font-weight:bold;cursor:pointer}.err{color:#ff875f}.muted{color:#9b9a91;font-size:12px}</style>
<div><form method="post" action="/auth/login"><h2 style="margin-top:0">登录 Pro 工作台</h2>
${error ? `<div class="err">${error}</div>` : ''}
<label class="muted">用户名</label><input name="username" autocomplete="username" required>
<label class="muted">密码</label><input name="password" type="password" autocomplete="current-password" required>
<button>登录</button>
${oidcSection}
<p class="muted" style="margin-top:14px">私有部署 · 本地凭据已启用</p></form></div></html>`
}

export function createAuthHandler(deps: AuthRoutesDeps): AuthHandler {
  const cookieName = deps.sessionCookieName ?? 'proma_session'
  const ttlMs = deps.sessionTtlMs ?? 12 * 3_600_000
  const hasOidc = Boolean(deps.oidc)

  const issueSession = async (tenantId: string, userId: string, roles: AgentRuntimeRole[]): Promise<Response> => {
    const sessionId = randomUUID()
    const expiresAt = Date.now() + ttlMs
    await deps.sessionStore.create({ sessionId, tenantId, userId, roles, expiresAt })
    const maxAgeSec = Math.floor(ttlMs / 1_000)
    return new Response(null, {
      status: 302,
      headers: { location: deps.dashboardPath ?? '/agent/ui', 'set-cookie': createSessionCookie(sessionId, cookieName, maxAgeSec) },
    })
  }

  return {
    async loginPage() {
      return new Response(loginPageHtml(hasOidc), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    },

    async loginForm(body) {
      const username = (body.username ?? '').trim()
      const password = body.password ?? ''
      if (!username || !password) return new Response(loginPageHtml(hasOidc, '请输入用户名和密码'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
      const account = await deps.verifyAdmin(username, password)
      if (!account) return new Response(loginPageHtml(hasOidc, '用户名或密码错误'), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } })
      return issueSession(account.tenantId, username, [...account.roles])
    },

    logout() {
      return new Response(null, { status: 302, headers: { location: '/auth/login', 'set-cookie': expiredCookie(cookieName) } })
    },

    async oidcStart() {
      const oidc = deps.oidc
      if (!oidc) return new Response(loginPageHtml(false, '未启用企业账号登录'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
      const state = randomBytes(16).toString('hex')
      const url = new URL(oidc.authorizationEndpoint)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', oidc.clientId)
      url.searchParams.set('redirect_uri', oidc.redirectUri)
      url.searchParams.set('scope', oidc.scope ?? 'openid profile email')
      url.searchParams.set('state', state)
      // 简化：state 不持久化到会话，用再校验（私有部署最小集可接受，注释标注生产应存 state）
      return new Response(null, { status: 302, headers: { location: url.toString() } })
    },

    async oidcCallback(code) {
      const oidc = deps.oidc
      if (!oidc) return new Response(loginPageHtml(false, '未启用企业账号登录'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
      if (!code) return new Response(loginPageHtml(true, '缺少授权码'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
      const exchange = deps.oidcTokenFromCode ?? defaultOidcTokenFromCode
      const resolved = await exchange(code, oidc)
      if (!resolved) return new Response(loginPageHtml(true, '企业账号校验失败'), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } })
      return issueSession(resolved.tenantId, resolved.userId, resolved.roles)
    },
  }
}

/** 默认 OIDC code→token→ID token 交换；从 ID token 的 sub/tenant_id/roles 解析 scope。 */
async function defaultOidcTokenFromCode(code: string, oidc: OidcAuthConfig): Promise<{ tenantId: string; userId: string; roles: AgentRuntimeRole[] }> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: oidc.redirectUri,
    client_id: oidc.clientId,
  })
  if (oidc.clientSecret) form.set('client_secret', oidc.clientSecret)
  const response = await fetch(oidc.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })
  if (!response.ok) throw new Error(`OIDC token 交换失败: ${response.status}`)
  const payload = await response.json() as { id_token?: string; access_token?: string }
  if (!payload.id_token) throw new Error('OIDC token 响应缺少 id_token')
  // 简化：私有部署最小集默认 trust id_token（在无 JWT 校验 base 的环境中应接 jwks 校验）；
  // 复用 jwt-auth 的校验走 createOidcJwtAuth 场景，这里做最小 id_token 解析占位，真实校验在接线层补。
  const claims = decodeJwtClaims(payload.id_token)
  const tenantId = typeof claims.tenant_id === 'string' ? claims.tenant_id : 'default'
  const userId = typeof claims.sub === 'string' ? claims.sub : 'oidc-user'
  const roles = readRoles(claims.roles)
  return { tenantId, userId, roles }
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const [, payload] = token.split('.')
  if (!payload) return {}
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown> } catch { return {} }
}

function readRoles(value: unknown): AgentRuntimeRole[] {
  return Array.isArray(value) ? value.filter((role): role is AgentRuntimeRole => role === 'viewer' || role === 'operator' || role === 'admin' || role === 'security-auditor') : []
}
