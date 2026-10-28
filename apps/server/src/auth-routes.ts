import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AgentRuntimeRole } from '@gravitas/shared/utils'
import { verifyPassword } from './local-admin-auth'
import { verifyJwtWithJwks } from './jwt-auth'
import { parseSessionCookie } from './auth-resolvers'

export interface OidcAuthConfig {
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  scope?: string
  /** 以下用于校验 id_token 签名/声明（当前仅有 JWKS 验签，缺省走不校验是有风险的，应总是提供） */
  issuer?: string
  audience?: string
  jwksUrl?: string
}

export interface AuthRoutesDeps {
  sessionStore: { create(session: { sessionId: string; tenantId: string; userId: string; roles: AgentRuntimeRole[]; expiresAt: number }): Promise<void>; destroy(sessionId: string): Promise<void> }
  /** 本地管理员校验：返回 scope 或 null；内部完成 scrypt 比对 */
  verifyAdmin: (username: string, password: string) => Promise<{ tenantId: string; roles: AgentRuntimeRole[] } | null>
  sessionCookieName?: string
  secureSessionCookie?: boolean
  sessionTtlMs?: number
  /** 未配置则禁用 OIDC（本地 fallback 模式） */
  oidc?: OidcAuthConfig
  /** OIDC code→token→scope 交换；default 用 fetch 走 token endpoint */
  oidcTokenFromCode?: (code: string, oidc: OidcAuthConfig, codeVerifier: string, nonce: string) => Promise<{ tenantId: string; userId: string; roles: AgentRuntimeRole[] }>
  /** 成功 OIDC 登录后的额外 userId 解析（从 claims），default 用 token 的 sub */
  dashboardPath?: string
  /** OIDC login state 校验用；缺省用带 TTL 的内存 Map（单节点私有部署足够，多 worker 需共享存储） */
  oidcStateStore?: { set(state: string, context: OidcLoginContext, ttlMs: number): Promise<void>; consume(state: string): Promise<OidcLoginContext | undefined> }
}

export interface OidcLoginContext { codeVerifier: string; nonce: string }
class OidcStateCapacityError extends Error {}

export interface AuthHandler {
  loginPage(): Promise<Response>
  loginForm(body: { username: string; password: string }): Promise<Response>
  logout(cookieHeader?: string | null): Promise<Response>
  oidcStart(): Promise<Response>
  oidcCallback(query: { code?: string; state?: string }, cookieHeader?: string | null): Promise<Response>
}

export function createSessionCookie(sessionId: string, name: string, maxAgeSeconds: number, secure = false): string {
  return `${name}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
}

/** 内存 OIDC login state 存储（单节点私有部署）；多 worker 需换成共享存储。 */
export function createInMemoryOidcStateStore(options: { maxEntries?: number; now?: () => number } = {}): NonNullable<AuthRoutesDeps['oidcStateStore']> {
  const maxEntries = options.maxEntries ?? 1000
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('登录状态容量必须为正整数')
  const now = options.now ?? Date.now
  const states = new Map<string, { expiresAt: number; context: OidcLoginContext }>()
  return {
    async set(state, context, ttlMs) {
      const current = now()
      for (const [key, entry] of states) if (entry.expiresAt <= current) states.delete(key)
      if (states.has(state)) throw new Error('登录状态重复')
      if (states.size >= maxEntries) throw new OidcStateCapacityError('登录状态已满，请稍后重试')
      states.set(state, { expiresAt: current + ttlMs, context })
    },
    async consume(state) {
      const entry = states.get(state)
      states.delete(state) // 一次性：验证后即失效（防重放）
      return entry && entry.expiresAt > now() ? entry.context : undefined
    },
  }
}

export interface LoginCredentials { username: string; password: string }

/**
 * 从登录请求体解析 username/password，兼容：
 * - application/json（API 调用 / curl 冒烟）
 * - application/x-www-form-urlencoded（浏览器 HTML form 提交）
 */
export async function readLoginCredentials(request: Request): Promise<{ credentials?: LoginCredentials; error?: string }> {
  const contentType = request.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) {
      const body = await request.json() as { username?: unknown; password?: unknown }
      return { credentials: { username: String(body.username ?? ''), password: String(body.password ?? '') } }
    }
    // 默认按 urlencoded（含 HTML form 提交、无 content-type 的 curl -d）
    const text = await request.text()
    const params = new URLSearchParams(text)
    return { credentials: { username: params.get('username') ?? '', password: params.get('password') ?? '' } }
  } catch {
    return { error: '请求体必须是 JSON 或表单编码内容' }
  }
}

function expiredCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
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
  const stateCookieName = 'proma_oidc_state'
  const stateCookie = (value: string, maxAge: number) => `${stateCookieName}=${value}; Path=/auth/oidc/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${deps.secureSessionCookie ? '; Secure' : ''}`
  const ttlMs = deps.sessionTtlMs ?? 12 * 3_600_000
  const hasOidc = Boolean(deps.oidc)
  const stateStore = deps.oidcStateStore ?? createInMemoryOidcStateStore()

  const issueSession = async (tenantId: string, userId: string, roles: AgentRuntimeRole[]): Promise<Response> => {
    const sessionId = randomUUID()
    const expiresAt = Date.now() + ttlMs
    await deps.sessionStore.create({ sessionId, tenantId, userId, roles, expiresAt })
    const maxAgeSec = Math.floor(ttlMs / 1_000)
    return new Response(null, {
      status: 302,
      headers: { location: deps.dashboardPath ?? '/agent/ui', 'set-cookie': createSessionCookie(sessionId, cookieName, maxAgeSec, deps.secureSessionCookie) },
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

    async logout(cookieHeader) {
      const sessionId = parseSessionCookie(cookieHeader ?? null, cookieName)
      if (sessionId) await deps.sessionStore.destroy(sessionId)
      return new Response(null, { status: 302, headers: { location: '/auth/login', 'set-cookie': expiredCookie(cookieName, deps.secureSessionCookie ?? false) } })
    },

    async oidcStart() {
      const oidc = deps.oidc
      if (!oidc) return new Response(loginPageHtml(false, '未启用企业账号登录'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
      const state = randomBytes(16).toString('hex')
      const codeVerifier = randomBytes(32).toString('base64url')
      const nonce = randomBytes(32).toString('base64url')
      try { await stateStore.set(state, { codeVerifier, nonce }, 10 * 60_000) } catch (error) {
        if (error instanceof OidcStateCapacityError) return new Response(loginPageHtml(true, '登录繁忙，请稍后重试'), { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } })
        throw error
      }
      const url = new URL(oidc.authorizationEndpoint)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', oidc.clientId)
      url.searchParams.set('redirect_uri', oidc.redirectUri)
      url.searchParams.set('scope', oidc.scope ?? 'openid profile email')
      url.searchParams.set('state', state)
      url.searchParams.set('nonce', nonce)
      url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'))
      url.searchParams.set('code_challenge_method', 'S256')
      return new Response(null, { status: 302, headers: { location: url.toString(), 'set-cookie': stateCookie(state, 600) } })
    },

    async oidcCallback(query, cookieHeader) {
      const oidc = deps.oidc
      if (!oidc) return new Response(loginPageHtml(false, '未启用企业账号登录'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
      // 校验 state 防 login CSRF：缺失或不存在/已过期直接拒绝
      const state = query.state ?? ''
      if (!state || state !== parseSessionCookie(cookieHeader ?? null, stateCookieName)) {
        return new Response(loginPageHtml(true, '登录状态校验失败，请重新发起登录'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      const context = await stateStore.consume(state)
      if (!context) return new Response(loginPageHtml(true, '登录状态校验失败，请重新发起登录'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
      const code = query.code ?? ''
      if (!code) return new Response(loginPageHtml(true, '缺少授权码'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
      const exchange = deps.oidcTokenFromCode ?? defaultOidcTokenFromCode
      const resolved = await exchange(code, oidc, context.codeVerifier, context.nonce)
      if (!resolved) return new Response(loginPageHtml(true, '企业账号校验失败'), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } })
      const response = await issueSession(resolved.tenantId, resolved.userId, resolved.roles)
      response.headers.append('set-cookie', stateCookie('', 0))
      return response
    },
  }
}

/** 默认 OIDC code→token→ID token 交换；用 JWKS 校验 id_token 签名与 iss/aud/exp 后解析 scope。 */
async function defaultOidcTokenFromCode(code: string, oidc: OidcAuthConfig, codeVerifier: string, nonce: string): Promise<{ tenantId: string; userId: string; roles: AgentRuntimeRole[] }> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: oidc.redirectUri,
    client_id: oidc.clientId,
    code_verifier: codeVerifier,
  })
  if (oidc.clientSecret) form.set('client_secret', oidc.clientSecret)
  const response = await fetch(oidc.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })
  if (!response.ok) throw new Error(`OIDC token 交换失败: ${response.status}`)
  const payload = await response.json() as { id_token?: string; access_token?: string }
  if (!payload.id_token) throw new Error('OIDC token 响应缺少 id_token')

  // 校验 id_token 签名与声明（防伪造/提权）。未配 jwksUrl 时拒绝（不能信任未验签的 token）。
  if (!oidc.jwksUrl || !oidc.issuer || !oidc.clientId) {
    throw new Error('OIDC 登录需要配置 jwksUrl/issuer/clientId 以校验 id_token 签名')
  }
  const scope = await verifyJwtWithJwks(payload.id_token, {
    issuer: oidc.issuer,
    audience: oidc.clientId,
    jwksUrl: oidc.jwksUrl,
    expectedNonce: nonce,
  })
  if (!scope) throw new Error('OIDC id_token 校验失败（签名或声明无效）')
  return scope
}
// （id_token 校验已委托给 verifyJwtWithJwks，此处不再保留本地 claims 解析）
