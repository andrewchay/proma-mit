import type { AccessTokenPayload } from '../services/token-service'

export interface AuthenticatedRequestContext {
  accountId: string
  sessionId: string
}

export function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return undefined
  return header.slice('Bearer '.length).trim() || undefined
}

export function authenticateRequest(
  request: Request,
  verifyAccessToken: (token: string) => AccessTokenPayload | undefined,
): AuthenticatedRequestContext | undefined {
  const token = extractBearerToken(request)
  if (!token) return undefined
  const payload = verifyAccessToken(token)
  if (!payload) return undefined
  return { accountId: payload.sub, sessionId: payload.sid }
}
