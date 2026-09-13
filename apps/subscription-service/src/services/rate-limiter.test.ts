import { describe, expect, test } from 'bun:test'
import { RateLimiter, extractClientIp } from './rate-limiter'

describe('限流器', () => {
  test('窗口内未超限时放行', () => {
    const limiter = new RateLimiter()
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.check('key-1', { limit: 5, windowMs: 60_000 }, 1000 + i).allowed).toBe(true)
    }
  })

  test('超过上限时拒绝并给出重试时间', () => {
    const limiter = new RateLimiter()
    const config = { limit: 3, windowMs: 60_000 }
    for (let i = 0; i < 3; i += 1) limiter.check('key-1', config, 1000)

    const result = limiter.check('key-1', config, 1000)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  test('窗口过期后计数重置', () => {
    const limiter = new RateLimiter()
    const config = { limit: 2, windowMs: 60_000 }
    limiter.check('key-1', config, 1000)
    limiter.check('key-1', config, 1000)
    expect(limiter.check('key-1', config, 1000).allowed).toBe(false)

    // 窗口结束后恢复
    expect(limiter.check('key-1', config, 1000 + 60_001).allowed).toBe(true)
  })

  test('不同 key 互不影响', () => {
    const limiter = new RateLimiter()
    const config = { limit: 1, windowMs: 60_000 }
    expect(limiter.check('a', config, 1000).allowed).toBe(true)
    expect(limiter.check('a', config, 1000).allowed).toBe(false)
    // 不同 key 仍可放行
    expect(limiter.check('b', config, 1000).allowed).toBe(true)
  })

  test('reset 清除指定 key 的计数', () => {
    const limiter = new RateLimiter()
    const config = { limit: 1, windowMs: 60_000 }
    limiter.check('a', config, 1000)
    expect(limiter.check('a', config, 1000).allowed).toBe(false)
    limiter.reset('a')
    expect(limiter.check('a', config, 1000).allowed).toBe(true)
  })

  test('滑动窗口：旧记录不会永久占用配额', () => {
    const limiter = new RateLimiter()
    const config = { limit: 2, windowMs: 10_000 }
    limiter.check('a', config, 0)
    limiter.check('a', config, 5_000)
    expect(limiter.check('a', config, 9_000).allowed).toBe(false)
    // 第一条记录（t=0）已滑出窗口
    expect(limiter.check('a', config, 10_001).allowed).toBe(true)
  })
})

describe('客户端 IP 提取', () => {
  function makeRequest(headers: Record<string, string>): Request {
    return new Request('https://example.com/', { headers })
  }

  test('优先使用 X-Forwarded-For 的第一个地址', () => {
    const ip = extractClientIp(
      makeRequest({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }),
      ['10.0.0.0/8'],
    )
    expect(ip).toBe('203.0.113.5')
  })

  test('X-Forwarded-For 全为可信代理时回退到 X-Real-IP', () => {
    const ip = extractClientIp(
      makeRequest({ 'x-forwarded-for': '10.0.0.2', 'x-real-ip': '198.51.100.7' }),
      ['10.0.0.0/8'],
    )
    expect(ip).toBe('198.51.100.7')
  })

  test('无可信头时返回 unknown', () => {
    expect(extractClientIp(makeRequest({}), ['10.0.0.0/8'])).toBe('unknown')
  })

  test('未配置可信代理时不信任 X-Forwarded-For', () => {
    // 直接暴露时，X-Forwarded-For 可被伪造，不能作为限流依据
    const ip = extractClientIp(makeRequest({ 'x-forwarded-for': '203.0.113.5' }), [])
    expect(ip).toBe('unknown')
  })
})
