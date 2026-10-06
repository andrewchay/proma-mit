import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export interface AccessTokenPayload {
  sub: string
  sid: string
  exp: number
  iat: number
}

export interface IssuedTokenPair {
  accessToken: string
  refreshToken: string
  refreshTokenHash: string
  expiresAt: number
}

export class TokenService {
  constructor(
    private readonly accessTokenSecret: string,
    private readonly accessTokenTtlMs: number,
    private readonly refreshTokenTtlMs: number,
  ) {}

  issueTokenPair(accountId: string, sessionId: string): IssuedTokenPair {
    const now = Date.now()
    const payload: AccessTokenPayload = {
      sub: accountId,
      sid: sessionId,
      iat: now,
      exp: now + this.accessTokenTtlMs,
    }
    const accessToken = this.signAccessToken(payload)
    const refreshToken = randomBytes(48).toString('base64url')
    return {
      accessToken,
      refreshToken,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: now + this.refreshTokenTtlMs,
    }
  }

  verifyAccessToken(token: string): AccessTokenPayload | undefined {
    const [payloadBase64url, signature] = token.split('.')
    if (!payloadBase64url || !signature) return undefined
    const expected = createHmac('sha256', this.accessTokenSecret).update(payloadBase64url).digest('base64url')
    const left = Buffer.from(signature)
    const right = Buffer.from(expected)
    if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined
    try {
      const payload = JSON.parse(Buffer.from(payloadBase64url, 'base64url').toString('utf8')) as AccessTokenPayload
      if (payload.exp < Date.now()) return undefined
      return payload
    } catch {
      return undefined
    }
  }

  rotateRefreshToken(): { refreshToken: string; refreshTokenHash: string } {
    const refreshToken = randomBytes(48).toString('base64url')
    return { refreshToken, refreshTokenHash: hashRefreshToken(refreshToken) }
  }

  createSessionId(): string {
    return randomUUID()
  }

  private signAccessToken(payload: AccessTokenPayload): string {
    const payloadBase64url = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = createHmac('sha256', this.accessTokenSecret).update(payloadBase64url).digest('base64url')
    return `${payloadBase64url}.${signature}`
  }
}

export function hashRefreshToken(refreshToken: string): string {
  return createHmac('sha256', 'gravitas-refresh-token').update(refreshToken).digest('hex')
}
