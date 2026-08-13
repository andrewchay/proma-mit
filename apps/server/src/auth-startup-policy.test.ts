import { describe, expect, test } from 'bun:test'
import { assertTrustedHeaderAuthStartupPolicy, assertAuthModeStartupPolicy } from './auth-startup-policy.ts'

describe('可信 Header 启动策略', () => {
  test('given production environment when trusted Header auth is enabled then startup is refused', () => {
    expect(() => assertTrustedHeaderAuthStartupPolicy({
      trustedHeaderAuth: true,
      hostname: '127.0.0.1',
      nodeEnv: 'production',
    })).toThrow('仅可在 NODE_ENV=development 时启用')
  })

  test('given a non-loopback host when trusted Header auth is enabled then startup is refused', () => {
    expect(() => assertTrustedHeaderAuthStartupPolicy({
      trustedHeaderAuth: true,
      hostname: '0.0.0.0',
      nodeEnv: 'development',
    })).toThrow('仅可监听 loopback 地址')
  })

  test('given local development when trusted Header auth is enabled then startup is allowed', () => {
    expect(() => assertTrustedHeaderAuthStartupPolicy({
      trustedHeaderAuth: true,
      hostname: 'localhost',
      nodeEnv: 'development',
    })).not.toThrow()
  })

  test('given production environment when OIDC auth is used then startup remains allowed', () => {
    expect(() => assertTrustedHeaderAuthStartupPolicy({
      trustedHeaderAuth: false,
      hostname: '0.0.0.0',
      nodeEnv: 'production',
    })).not.toThrow()
  })
})

describe('authMode 启动策略', () => {
  test('given local mode without admin then startup is refused', () => {
    expect(() => assertAuthModeStartupPolicy({
      trustedHeaderAuth: false,
      authMode: 'local',
      hasLocalAdmin: false,
      hasOidcClient: false,
    })).toThrow('PROMA_WEB_ADMIN')
  })

  test('given local mode with admin then startup is allowed', () => {
    expect(() => assertAuthModeStartupPolicy({
      trustedHeaderAuth: false,
      authMode: 'local',
      hasLocalAdmin: true,
      hasOidcClient: false,
    })).not.toThrow()
  })

  test('given oidc mode without client then startup is refused', () => {
    expect(() => assertAuthModeStartupPolicy({
      trustedHeaderAuth: false,
      authMode: 'oidc',
      hasLocalAdmin: false,
      hasOidcClient: false,
    })).toThrow('OIDC')
  })

  test('given invalid authMode value then startup is refused', () => {
    expect(() => assertAuthModeStartupPolicy({
      trustedHeaderAuth: false,
      authMode: 'saml',
      hasLocalAdmin: false,
      hasOidcClient: false,
    })).toThrow('local|oidc|both|none')
  })

  test('given both mode with admin and oidc then startup is allowed', () => {
    expect(() => assertAuthModeStartupPolicy({
      trustedHeaderAuth: false,
      authMode: 'both',
      hasLocalAdmin: true,
      hasOidcClient: true,
    })).not.toThrow()
  })

  test('given no authMode then startup is allowed (Bearer only)', () => {
    expect(() => assertAuthModeStartupPolicy({
      trustedHeaderAuth: false,
      authMode: undefined,
      hasLocalAdmin: false,
      hasOidcClient: false,
    })).not.toThrow()
  })

  test('given trustedHeaderAuth enabled then authMode policy is skipped', () => {
    expect(() => assertAuthModeStartupPolicy({
      trustedHeaderAuth: true,
      authMode: 'saml', // 即使非法也不校验，因为 trusted-header 模式不涉及
      hasLocalAdmin: false,
      hasOidcClient: false,
    })).not.toThrow()
  })
})
