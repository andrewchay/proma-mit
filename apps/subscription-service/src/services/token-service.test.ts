import { describe, expect, test } from 'bun:test'
import { TokenService } from './token-service'

describe('TokenService', () => {
  test('签发并验证 access token', () => {
    const service = new TokenService('secret', 60_000, 30 * 24 * 60 * 60 * 1000)
    const tokens = service.issueTokenPair('acct-1', 'session-1')
    const payload = service.verifyAccessToken(tokens.accessToken)
    expect(payload?.sub).toBe('acct-1')
    expect(payload?.sid).toBe('session-1')
  })

  test('篡改 access token 后验证失败', () => {
    const service = new TokenService('secret', 60_000, 30 * 24 * 60 * 60 * 1000)
    const tokens = service.issueTokenPair('acct-1', 'session-1')
    const [payload, signature] = tokens.accessToken.split('.')
    const tampered = `${payload}x.${signature}`
    expect(service.verifyAccessToken(tampered)).toBeUndefined()
  })

  test('过期 access token 验证失败', () => {
    const service = new TokenService('secret', -1, 30 * 24 * 60 * 60 * 1000)
    const tokens = service.issueTokenPair('acct-1', 'session-1')
    expect(service.verifyAccessToken(tokens.accessToken)).toBeUndefined()
  })

  test('rotateRefreshToken 生成新 refresh token 与哈希', () => {
    const service = new TokenService('secret', 60_000, 30 * 24 * 60 * 60 * 1000)
    const rotated = service.rotateRefreshToken()
    expect(rotated.refreshToken).toBeTruthy()
    expect(rotated.refreshTokenHash).toBeTruthy()
    expect(rotated.refreshTokenHash).not.toBe(rotated.refreshToken)
  })
})
