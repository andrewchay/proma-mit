import { describe, expect, test } from 'bun:test'
import { assertTrustedHeaderAuthStartupPolicy } from './auth-startup-policy.ts'

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
