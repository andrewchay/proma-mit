import { describe, expect, it } from 'bun:test'
import { createCookieSessionAuthResolver, createCompositeAuthResolver, parseSessionCookie } from './auth-resolvers'
import type { AuthSessionRecord } from './auth-session-store'

const ADMIN_SCOPE = { tenantId: 'tenant-a', userId: 'admin-1', roles: ['admin'] as const }

function makeStore() {
  const sessions = new Map<string, AuthSessionRecord>()
  return {
    store: {
      get: async (sessionId: string, now: number) => sessions.get(sessionId) ?? null,
    },
    sessions,
  }
}

describe('auth-resolvers', () => {
  it('parseSessionCookie 解析 HTTP-only cookie 中的 session id', () => {
    expect(parseSessionCookie('proma_session=abc123; Path=/; HttpOnly')).toBe('abc123')
    expect(parseSessionCookie('other=1; proma_session=xyz')).toBe('xyz')
    expect(parseSessionCookie('no-session-here')).toBeUndefined()
    expect(parseSessionCookie(null)).toBeUndefined()
  })

  it('createCookieSessionAuthResolver 用 cookie 命中 session 返回 scope', async () => {
    const now = Date.now()
    const sessions = new Map<string, AuthSessionRecord>([
      ['sid1', { sessionId: 'sid1', tenantId: 'tenant-a', userId: 'admin-1', roles: ['admin'], expiresAt: now + 60_000 }],
    ])
    const resolver = createCookieSessionAuthResolver({
      store: { get: async (sid: string) => sessions.get(sid) ?? null },
      cookieName: 'proma_session',
    })
    const scope = await resolver({ request: new Request('http://x/agent/ui', { headers: { cookie: 'proma_session=sid1' } }), url: new URL('http://x/agent/ui') })
    expect(scope).toEqual({ tenantId: 'tenant-a', userId: 'admin-1', roles: ['admin'] })
  })

  it('cookie 未命中时返回 undefined（交给 Bearer 链路）', async () => {
    const { store } = makeStore()
    const resolver = createCookieSessionAuthResolver({ store, cookieName: 'proma_session' })
    const scope = await resolver({ request: new Request('http://x/'), url: new URL('http://x/') })
    expect(scope).toBeUndefined()
  })

  it('createCompositeAuthResolver 按 cookie→bearer 顺序尝试', async () => {
    const cookieFn = async (): Promise<{ tenantId: string; userId: string; roles: ['operator'] }> => ({ tenantId: 't', userId: 'cookie-user', roles: ['operator'] })
    const bearerFn = async () => undefined
    const inner = createCompositeAuthResolver(cookieFn, bearerFn)
    const scope = await inner({ request: new Request('http://x/'), url: new URL('http://x/') })
    expect(scope?.userId).toBe('cookie-user')
  })

  it('createCompositeAuthResolver 第一个 undefined 时尝试下一个', async () => {
    const first = async () => undefined
    const second = async (): Promise<{ tenantId: string; userId: string; roles: ['security-auditor'] }> => ({ tenantId: 't2', userId: 'bearer-user', roles: ['security-auditor'] })
    const inner = createCompositeAuthResolver(first, second)
    const scope = await inner({ request: new Request('http://x/'), url: new URL('http://x/') })
    expect(scope?.userId).toBe('bearer-user')
  })
})
