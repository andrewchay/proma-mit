import { describe, expect, test } from 'bun:test'
import { RedisTaskRateLimiter } from './app.ts'

describe('P3 Redis task rate limiter', () => {
  test('rejects requests after the configured atomic window limit', async () => {
    let count = 0
    const limiter = new RedisTaskRateLimiter({ incrementInWindow: async () => ++count })
    const scope = { tenantId: 'tenant', userId: 'user' }
    await limiter.assertAllowed(scope, 'model', { maxTasks: 2, windowMs: 60_000 })
    await limiter.assertAllowed(scope, 'model', { maxTasks: 2, windowMs: 60_000 })
    await expect(limiter.assertAllowed(scope, 'model', { maxTasks: 2, windowMs: 60_000 }))
      .rejects.toThrow('请求过于频繁')
  })
})
