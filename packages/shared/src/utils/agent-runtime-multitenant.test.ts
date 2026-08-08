import { describe, expect, test } from 'bun:test'
import { resolveTenantFromHostname } from './agent-runtime-web-server'

/**
 * PH2-F 多租户精细化（URL 即边界）测试。
 */

describe('resolveTenantFromHostname（PH2-F）', () => {
  test('子域前缀即租户', () => {
    expect(resolveTenantFromHostname('team-a.example.com')).toBe('team-a')
    expect(resolveTenantFromHostname('acme.proma.cool:8080')).toBe('acme')
    expect(resolveTenantFromHostname('team-b.example.com')).toBe('team-b')
  })

  test('www 与单段 host 不作为租户', () => {
    expect(resolveTenantFromHostname('www.example.com')).toBe('')
    expect(resolveTenantFromHostname('localhost')).toBe('')
    expect(resolveTenantFromHostname(null)).toBe('')
  })

  test('显式 host→tenant 映射优先', () => {
    expect(resolveTenantFromHostname('internal.example.com', { 'internal.example.com': 'tenant-9' })).toBe('tenant-9')
  })
})
