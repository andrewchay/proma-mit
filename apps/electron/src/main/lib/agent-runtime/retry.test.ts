/**
 * Runtime 重试工具单元测试
 */

import { describe, test, expect } from 'bun:test'
import { withRetry } from './retry'

describe('withRetry', () => {
  test('首次成功直接返回', async () => {
    const result = await withRetry(
      async () => 'ok',
      { maxRetries: 2, baseDelayMs: 10, shouldRetry: () => true },
    )
    expect(result).toBe('ok')
  })

  test('可重试错误在达到最大次数前成功', async () => {
    let attempt = 0
    const result = await withRetry(
      async () => {
        attempt++
        if (attempt < 3) throw new Error('transient')
        return 'ok'
      },
      { maxRetries: 3, baseDelayMs: 10, shouldRetry: () => true },
    )
    expect(result).toBe('ok')
    expect(attempt).toBe(3)
  })

  test('不可重试错误立即抛出', async () => {
    let attempt = 0
    await expect(
      withRetry(
        async () => {
          attempt++
          throw new Error('permanent')
        },
        { maxRetries: 3, baseDelayMs: 10, shouldRetry: () => false },
      ),
    ).rejects.toThrow('permanent')
    expect(attempt).toBe(1)
  })

  test('达到最大重试次数后抛出最后错误', async () => {
    let attempt = 0
    await expect(
      withRetry(
        async () => {
          attempt++
          throw new Error(`attempt ${attempt}`)
        },
        { maxRetries: 2, baseDelayMs: 10, shouldRetry: () => true },
      ),
    ).rejects.toThrow('attempt 3')
    expect(attempt).toBe(3)
  })

  test('中止信号会中断等待', async () => {
    const controller = new AbortController()
    const promise = withRetry(
      async () => {
        throw new Error('transient')
      },
      { maxRetries: 3, baseDelayMs: 1000, shouldRetry: () => true, signal: controller.signal },
    )
    controller.abort()
    await expect(promise).rejects.toThrow('中止')
  })
})
