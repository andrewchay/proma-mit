import type { AgentRuntimeRole, AgentRuntimeScope, AgentRuntimeWebAuthResolver } from '@gravitas/shared/utils'
import type { AuthSessionRecord } from './auth-session-store'

export const DEFAULT_SESSION_COOKIE = 'proma_session'

/** 从 Cookie 头中读取指定名字的 session id */
export function parseSessionCookie(cookieHeader: string | null, name = DEFAULT_SESSION_COOKIE): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.trim().indexOf('=')
    if (eq <= 0) continue
    const key = part.trim().slice(0, eq).trim()
    const value = part.trim().slice(eq + 1).trim()
    if (key === name && value) return value
  }
  return undefined
}

export interface CookieSessionAuthOptions {
  store: { get(sessionId: string, now: number): Promise<AuthSessionRecord | null> }
  cookieName?: string
}

/** 从 HTTP-only 会话 cookie 解析 scope；无 cookie 或过期/不存在则 undefined。 */
export function createCookieSessionAuthResolver(options: CookieSessionAuthOptions): AgentRuntimeWebAuthResolver {
  const name = options.cookieName ?? DEFAULT_SESSION_COOKIE
  return async ({ request }) => {
    const sessionId = parseSessionCookie(request.headers.get('cookie'), name)
    if (!sessionId) return undefined
    const session = await options.store.get(sessionId, Date.now())
    if (!session) return undefined
    return { tenantId: session.tenantId, userId: session.userId, roles: session.roles }
  }
}

/** 按序尝试多个 auth resolver，第一个返回 scope 的胜出；全部 undefined 则 undefined。 */
export function createCompositeAuthResolver(...resolvers: Array<AgentRuntimeWebAuthResolver | undefined>): AgentRuntimeWebAuthResolver {
  return async (input) => {
    for (const resolver of resolvers) {
      if (!resolver) continue
      const scope = await resolver(input)
      if (scope) return scope
    }
    return undefined
  }
}

export type { AgentRuntimeScope, AgentRuntimeRole }
