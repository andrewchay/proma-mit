import { describe, expect, test } from 'bun:test'
import {
  MODEL_FIRST_RESPONSE_MAX_TIMEOUT_MS,
  MODEL_STREAM_IDLE_TIMEOUT_MS,
  OWNER_MODEL_SILENCE_TIMEOUT_MS,
  nextWithIdleTimeout,
  resolveModelFirstResponseTimeoutMs,
  resolveModelStreamIdleTimeoutMs,
} from './stream-timeouts'

describe('模型流超时策略', () => {
  test('首响应宽限随上下文增大并限制在 120–480 秒', () => {
    expect(resolveModelFirstResponseTimeoutMs(1_000)).toBe(MODEL_STREAM_IDLE_TIMEOUT_MS)
    expect(resolveModelFirstResponseTimeoutMs(100_000)).toBe(200_000)
    expect(resolveModelFirstResponseTimeoutMs(1_000_000)).toBe(MODEL_FIRST_RESPONSE_MAX_TIMEOUT_MS)
  })

  test('模型开始输出后恢复 120 秒流中阈值', () => {
    expect(resolveModelStreamIdleTimeoutMs(false, 360_000)).toBe(360_000)
    expect(resolveModelStreamIdleTimeoutMs(true, 360_000)).toBe(MODEL_STREAM_IDLE_TIMEOUT_MS)
  })

  test('异步迭代器静默时中断并抛出可重试错误', async () => {
    let timedOut = false
    const iterator: AsyncIterator<string> = {
      next: () => new Promise<IteratorResult<string>>(() => {}),
    }

    await expect(nextWithIdleTimeout({
      iterator,
      timeoutMs: 20,
      runtime: 'AI SDK',
      onTimeout: () => { timedOut = true },
    })).rejects.toThrow(/空闲超时|ended without data/i)
    expect(timedOut).toBe(true)
  })
})


test('Given Owner管理请求 When 使用慢模型静默宽限 Then 首响应与流中均有界且普通Agent仍自适应', () => {
  const ownerFirst = resolveModelFirstResponseTimeoutMs(1_000, OWNER_MODEL_SILENCE_TIMEOUT_MS)
  expect(ownerFirst).toBe(480_000)
  expect(resolveModelStreamIdleTimeoutMs(true, ownerFirst, OWNER_MODEL_SILENCE_TIMEOUT_MS)).toBe(480_000)
  expect(resolveModelFirstResponseTimeoutMs(100_000)).toBe(200_000)
  expect(resolveModelStreamIdleTimeoutMs(true, 200_000)).toBe(120_000)
})
