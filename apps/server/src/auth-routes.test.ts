import { describe, expect, it } from 'bun:test'
import { createAuthHandler, createInMemoryOidcStateStore, readLoginCredentials, type AuthRoutesDeps } from './auth-routes'
import type { AgentRuntimeRole } from '@gravitas/shared/utils'
import { createCookieSessionAuthResolver } from './auth-resolvers'
import { createHash } from 'node:crypto'

function makeHandler(overrides: Partial<AuthRoutesDeps> = {}) {
  return createAuthHandler({
    sessionStore: {
      create: async () => {},
      destroy: async () => {},
    },
    verifyAdmin: async (username: string, password: string) =>
      username === 'admin' && password === 's3cret' ? { tenantId: 'tenant-a', roles: ['admin'] as AgentRuntimeRole[] } : null,
    sessionCookieName: 'proma_session',
    sessionTtlMs: 3_600_000,
    ...overrides,
  })
}

describe('auth-routes', () => {
  it('Given 未完成登录达到容量 When 创建新状态 Then 拒绝而不挤掉有效状态，过期后可恢复', async () => {
    let now = 1000
    const store = createInMemoryOidcStateStore({ maxEntries: 1, now: () => now })
    const context = { codeVerifier: 'verifier', nonce: 'nonce' }
    await store.set('first', context, 100)
    await expect(store.set('second', context, 100)).rejects.toThrow('登录状态已满')
    expect(await store.consume('first')).toEqual(context)
    await store.set('expired', context, 100)
    now += 101
    await store.set('next', context, 100)
    expect(await store.consume('expired')).toBeUndefined()
    expect(await store.consume('next')).toEqual(context)
  })
  it('Given 登录状态容量已满 When 发起 OIDC 登录 Then 返回可重试的服务繁忙', async () => {
    const store = createInMemoryOidcStateStore({ maxEntries: 1 })
    await store.set('occupied', { codeVerifier: 'v', nonce: 'n' }, 60000)
    const h = makeHandler({ oidcStateStore: store, oidc: { authorizationEndpoint: 'https://idp/a', tokenEndpoint: 'https://idp/token', clientId: 'c', redirectUri: 'https://app/auth/oidc/callback' } })
    expect((await h.oidcStart()).status).toBe(503)
    expect(await store.consume('occupied')).toEqual({ codeVerifier: 'v', nonce: 'n' })
  })
  it('Given OIDC 登录 When 交换授权码 Then 使用该次请求的 PKCE S256 verifier', async () => {
    let verifier = ''
    let nonce = ''
    const h = makeHandler({
      oidc: { authorizationEndpoint: 'https://idp/a', tokenEndpoint: 'https://idp/token', clientId: 'c', redirectUri: 'https://app/auth/oidc/callback' },
      oidcTokenFromCode: async (_code, _oidc, codeVerifier, expectedNonce) => { verifier = codeVerifier; nonce = expectedNonce; return { tenantId: 'tenant', userId: 'user', roles: ['operator'] } },
    })
    const start = await h.oidcStart()
    const url = new URL(start.headers.get('location')!)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect((await h.oidcCallback({ code: 'code', state: url.searchParams.get('state')! }, start.headers.get('set-cookie'))).status).toBe(302)
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(nonce.length).toBeGreaterThan(20)
    expect(url.searchParams.get('nonce')).toBe(nonce)
  })

  it('Given 默认 token 交换 When 提交授权码 Then token 请求携带对应 verifier', async () => {
    const previousFetch = globalThis.fetch
    let tokenBody = ''
    globalThis.fetch = (async (_url, init) => { tokenBody = String(init?.body ?? ''); return Response.json({}) }) as typeof fetch
    try {
      const h = makeHandler({ oidc: { authorizationEndpoint: 'https://idp/a', tokenEndpoint: 'https://idp/token', clientId: 'c', redirectUri: 'https://app/auth/oidc/callback' } })
      const start = await h.oidcStart()
      const url = new URL(start.headers.get('location')!)
      await expect(h.oidcCallback({ code: 'code', state: url.searchParams.get('state')! }, start.headers.get('set-cookie'))).rejects.toThrow('缺少 id_token')
      const verifier = new URLSearchParams(tokenBody).get('code_verifier')!
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge')!)
    } finally { globalThis.fetch = previousFetch }
  })
  it('Given HTTPS 会话 When 登录和登出 Then 两次 Cookie 均携带 Secure', async () => {
    const h = makeHandler({ secureSessionCookie: true })
    const login = await h.loginForm({ username: 'admin', password: 's3cret' })
    expect(login.headers.get('set-cookie')).toContain('; Secure')
    const logout = await h.logout(login.headers.get('set-cookie'))
    expect(logout.headers.get('set-cookie')).toContain('; Secure')
  })
  it('loginPage 返回登录页 HTML', async () => {
    const h = makeHandler()
    const res = await h.loginPage()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const text = await res.text()
    expect(text).toContain('登录')
  })

  it('loginForm 本地凭据正确时设 HttpOnly cookie 并 302 跳转 dashboard', async () => {
    const h = makeHandler()
    const res = await h.loginForm({ username: 'admin', password: 's3cret' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/agent/ui')
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('proma_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
  })

  it('loginForm 凭据错误返回 401 且不设 cookie', async () => {
    const h = makeHandler()
    const res = await h.loginForm({ username: 'admin', password: 'wrong' })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('oidcStart 无配置时返回 400', async () => {
    const h = makeHandler() // 无 oidc
    const res = await h.oidcStart()
    expect(res.status).toBe(400)
  })

  it('oidcStart 有配置时 302 重定向到 authorize URL（带 client_id）', async () => {
    const h = makeHandler({
      oidc: { authorizationEndpoint: 'https://idp.example.com/authorize', tokenEndpoint: 'https://idp.example.com/token', clientId: 'client-a', redirectUri: 'http://x/auth/oidc/callback' },
    })
    const res = await h.oidcStart()
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc).toContain('https://idp.example.com/authorize')
    expect(loc).toContain('client_id=client-a')
    expect(loc).toContain('response_type=code')
  })

  it('logout 清除 cookie', async () => {
    const h = makeHandler()
    const res = await h.logout()
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toContain('proma_session=')
    expect(setCookie).toContain('Max-Age=0')
  })

  it('Given 已登录会话 When 登出 Then 旧 cookie 无法再次认证', async () => {
    const sessions = new Map<string, { sessionId: string; tenantId: string; userId: string; roles: AgentRuntimeRole[]; expiresAt: number }>()
    const store = {
      create: async (session: { sessionId: string; tenantId: string; userId: string; roles: AgentRuntimeRole[]; expiresAt: number }) => { sessions.set(session.sessionId, session) },
      destroy: async (sessionId: string) => { sessions.delete(sessionId) },
      get: async (sessionId: string, now: number) => { const session = sessions.get(sessionId); return session && session.expiresAt > now ? session : null },
    }
    const handler = makeHandler({ sessionStore: store })
    const login = await handler.loginForm({ username: 'admin', password: 's3cret' })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const resolver = createCookieSessionAuthResolver({ store })
    const request = new Request('https://example.invalid/agent', { headers: { cookie } })
    expect(await resolver({ request, url: new URL(request.url) })).toMatchObject({ tenantId: 'tenant-a', userId: 'admin' })
    const result = await handler.logout(cookie)
    expect(result.status).toBe(302)
    expect(result.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(await resolver({ request, url: new URL(request.url) })).toBeUndefined()
  })

  it('Given 会话存储不可用 When 登出 Then 不报告成功', async () => {
    const handler = makeHandler({ sessionStore: { create: async () => {}, destroy: async () => { throw new Error('存储不可用') } } })
    await expect(handler.logout('proma_session=session-1')).rejects.toThrow('存储不可用')
  })

  it('oidcCallback 用 code 交换 token 并设会话 cookie（含 state 校验）', async () => {
    const h = makeHandler({
      oidc: { authorizationEndpoint: 'https://idp/a', tokenEndpoint: 'https://idp/token', clientId: 'c', clientSecret: 'sec', redirectUri: 'http://x/auth/oidc/callback' },
      oidcTokenFromCode: async () => ({ tenantId: 'tenant-oidc', userId: 'oidc-user', roles: ['operator'] as AgentRuntimeRole[] }),
    })
    // 先 oidcStart 取得合法 state
    const startRes = await h.oidcStart()
    const loc = startRes.headers.get('location') ?? ''
    const state = new URL(loc).searchParams.get('state') ?? ''
    expect(state).toBeTruthy()
    // 用合法 state 回调
    const res = await h.oidcCallback({ code: 'code123', state }, startRes.headers.get('set-cookie'))
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toContain('proma_session=')
  })

  it('oidcCallback 缺少/伪造 state 时拒绝（防 login CSRF）', async () => {
    const h = makeHandler({
      oidc: { authorizationEndpoint: 'https://idp/a', tokenEndpoint: 'https://idp/token', clientId: 'c', redirectUri: 'http://x/auth/oidc/callback' },
      oidcTokenFromCode: async () => ({ tenantId: 'tenant-oidc', userId: 'oidc-user', roles: ['operator'] as AgentRuntimeRole[] }),
    })
    // 无 state
    expect((await h.oidcCallback({ code: 'code' })).status).toBe(400)
    // 伪造 state
    expect((await h.oidcCallback({ code: 'code', state: 'forged' })).status).toBe(400)
  })

  it('Given 攻击者发起的有效 state When 回调没有发起浏览器的绑定 Cookie Then 拒绝登录', async () => {
    const h = makeHandler({
      secureSessionCookie: true,
      oidc: { authorizationEndpoint: 'https://idp/a', tokenEndpoint: 'https://idp/token', clientId: 'c', redirectUri: 'https://app/auth/oidc/callback' },
      oidcTokenFromCode: async () => ({ tenantId: 'tenant-oidc', userId: 'attacker', roles: ['operator'] as AgentRuntimeRole[] }),
    })
    const started = await h.oidcStart()
    expect(started.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax; Max-Age=600; Secure')
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!
    expect((await h.oidcCallback({ code: 'code', state })).status).toBe(400)
    expect((await h.oidcCallback({ code: 'code', state }, 'proma_oidc_state=another-browser')).status).toBe(400)
    const callback = await h.oidcCallback({ code: 'code', state }, started.headers.get('set-cookie'))
    expect(callback.status).toBe(302)
    expect(callback.headers.getSetCookie().some((value) => value.includes('proma_oidc_state=;') && value.includes('Max-Age=0'))).toBe(true)
  })

  it('oidcStateStore verify 一次性（重放被拒）', async () => {
    const h = makeHandler({
      oidc: { authorizationEndpoint: 'https://idp/a', tokenEndpoint: 'https://idp/token', clientId: 'c', redirectUri: 'http://x/auth/oidc/callback' },
      oidcTokenFromCode: async () => ({ tenantId: 'tenant-oidc', userId: 'oidc-user', roles: ['operator'] as AgentRuntimeRole[] }),
    })
    const startRes = await h.oidcStart()
    const state = new URL(startRes.headers.get('location') ?? '').searchParams.get('state') ?? ''
    const cookie = startRes.headers.get('set-cookie')
    expect((await h.oidcCallback({ code: 'c1', state }, cookie)).status).toBe(302) // 首次成功
    expect((await h.oidcCallback({ code: 'c2', state }, cookie)).status).toBe(400) // 重放被拒（state 已消耗）
  })

  it('oidcCallback 无配置时返回 400', async () => {
    const h = makeHandler()
    const res = await h.oidcCallback({ code: 'code' })
    expect(res.status).toBe(400)
  })
})

describe('readLoginCredentials', () => {
  it('解析 JSON 请求体', async () => {
    const req = new Request('http://x/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'pw' }) })
    const { credentials } = await readLoginCredentials(req)
    expect(credentials).toEqual({ username: 'admin', password: 'pw' })
  })

  it('解析浏览器表单 urlencoded 请求体（无 content-type 或 form 提交）', async () => {
    const req = new Request('http://x/auth/login', { method: 'POST', body: 'username=admin&password=form-pw' })
    const { credentials } = await readLoginCredentials(req)
    expect(credentials).toEqual({ username: 'admin', password: 'form-pw' })
  })

  it('解析显式 urlencoded content-type', async () => {
    const req = new Request('http://x/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=u&password=p' })
    const { credentials } = await readLoginCredentials(req)
    expect(credentials).toEqual({ username: 'u', password: 'p' })
  })
})
