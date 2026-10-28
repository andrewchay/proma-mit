import { describe, expect, test } from 'bun:test'
import { assertTrustedHeaderAuthStartupPolicy, assertAuthModeStartupPolicy, assertNoneAuthStartupPolicy, resolveDefaultAuthMode, resolveSecureSessionCookie } from './auth-startup-policy.ts'

describe('会话 Cookie 传输策略', () => {
  test('Given HTTPS 公网地址 When 使用浏览器登录 Then 启用 Secure', () => {
    expect(resolveSecureSessionCookie({ publicBaseUrl: 'https://example.com', hostname: '0.0.0.0', nodeEnv: 'production' })).toBe(true)
  })
  test('Given 本机 HTTP 开发 When 使用浏览器登录 Then 允许非 Secure Cookie', () => {
    expect(resolveSecureSessionCookie({ hostname: '127.0.0.1', nodeEnv: 'development' })).toBe(false)
    expect(resolveSecureSessionCookie({ publicBaseUrl: 'http://localhost:3000', hostname: 'localhost', nodeEnv: 'development' })).toBe(false)
  })
  test('Given 生产环境或非本机 HTTP When 使用浏览器登录 Then 拒绝启动', () => {
    expect(() => resolveSecureSessionCookie({ hostname: '127.0.0.1', nodeEnv: 'production' })).toThrow()
    expect(() => resolveSecureSessionCookie({ publicBaseUrl: 'http://example.com', hostname: '127.0.0.1', nodeEnv: 'development' })).toThrow()
    expect(() => resolveSecureSessionCookie({ publicBaseUrl: 'http://localhost', hostname: '0.0.0.0', nodeEnv: 'development' })).toThrow()
    expect(() => resolveSecureSessionCookie({ publicBaseUrl: 'ftp://example.com', hostname: '127.0.0.1', nodeEnv: 'development' })).toThrow()
  })
})

describe('无鉴权启动策略', () => {
  test('Given 生产环境或非本机监听 When 启用无鉴权 Then 拒绝启动', () => {
    expect(() => assertNoneAuthStartupPolicy({ authMode: 'none', trustedHeaderAuth: false, nodeEnv: 'production', hostname: '127.0.0.1' })).toThrow()
    expect(() => assertNoneAuthStartupPolicy({ authMode: 'none', trustedHeaderAuth: false, nodeEnv: 'development', hostname: '0.0.0.0' })).toThrow()
    expect(() => assertNoneAuthStartupPolicy({ authMode: 'none', trustedHeaderAuth: false, hostname: '127.0.0.1' })).toThrow()
  })
  test('Given 本机开发环境 When 启用无鉴权 Then 可以启动', () => {
    expect(() => assertNoneAuthStartupPolicy({ authMode: 'none', trustedHeaderAuth: false, nodeEnv: 'development', hostname: '127.0.0.1' })).not.toThrow()
  })
})

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
  test('Given 只配置企业 OIDC When 推导默认模式 Then 不要求不存在的本地管理员', () => {
    expect(resolveDefaultAuthMode(true, false)).toBe('oidc')
    expect(resolveDefaultAuthMode(true, true)).toBe('both')
    expect(resolveDefaultAuthMode(false, true)).toBe('local')
    expect(resolveDefaultAuthMode(false, false)).toBe('none')
  })
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

  test('given no authMode then browser mode validation leaves environment policy to the caller', () => {
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
