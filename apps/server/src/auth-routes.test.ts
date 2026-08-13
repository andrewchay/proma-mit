import { describe, expect, it } from 'bun:test'
import { createAuthHandler, readLoginCredentials, type AuthRoutesDeps } from './auth-routes'
import type { AgentRuntimeRole } from '@gravitas/shared/utils'

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
    const res = await h.oidcCallback({ code: 'code123', state })
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

  it('oidcStateStore verify 一次性（重放被拒）', async () => {
    const h = makeHandler({
      oidc: { authorizationEndpoint: 'https://idp/a', tokenEndpoint: 'https://idp/token', clientId: 'c', redirectUri: 'http://x/auth/oidc/callback' },
      oidcTokenFromCode: async () => ({ tenantId: 'tenant-oidc', userId: 'oidc-user', roles: ['operator'] as AgentRuntimeRole[] }),
    })
    const startRes = await h.oidcStart()
    const state = new URL(startRes.headers.get('location') ?? '').searchParams.get('state') ?? ''
    expect((await h.oidcCallback({ code: 'c1', state })).status).toBe(302) // 首次成功
    expect((await h.oidcCallback({ code: 'c2', state })).status).toBe(400) // 重放被拒（state 已消耗）
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
