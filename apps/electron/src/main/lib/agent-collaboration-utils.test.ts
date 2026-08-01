import { describe, expect, test } from 'bun:test'
import { createToolCallIdempotencyCache } from './agent-collaboration-utils'

describe('协作委派重放保护', () => {
  test('相同父会话和 toolCallId 只执行一次副作用', () => {
    const cache = createToolCallIdempotencyCache<{ delegationId: string }>()
    let creations = 0

    const first = cache.getOrCreate('parent-a', 'call-1', () => {
      creations += 1
      return { delegationId: 'delegation-1' }
    })
    const replay = cache.getOrCreate('parent-a', 'call-1', () => {
      creations += 1
      return { delegationId: 'delegation-2' }
    })

    expect(creations).toBe(1)
    expect(replay).toBe(first)
    expect(replay.delegationId).toBe('delegation-1')
  })

  test('不同父会话或 toolCallId 仍可创建独立委派', () => {
    const cache = createToolCallIdempotencyCache<number>()
    let creations = 0
    const create = () => ++creations

    expect(cache.getOrCreate('parent-a', 'call-1', create)).toBe(1)
    expect(cache.getOrCreate('parent-a', 'call-2', create)).toBe(2)
    expect(cache.getOrCreate('parent-b', 'call-1', create)).toBe(3)
  })

  test('缺少 toolCallId 时不缓存，保持原有执行语义', () => {
    const cache = createToolCallIdempotencyCache<number>()
    let creations = 0
    const create = () => ++creations

    expect(cache.getOrCreate('parent-a', undefined, create)).toBe(1)
    expect(cache.getOrCreate('parent-a', undefined, create)).toBe(2)
  })

  test('缓存有界，超过上限后清理最老的条目', () => {
    const cache = createToolCallIdempotencyCache<number>(2)
    let creations = 0
    const create = () => ++creations

    expect(cache.getOrCreate('p', 'a', create)).toBe(1)
    expect(cache.getOrCreate('p', 'b', create)).toBe(2)
    expect(cache.getOrCreate('p', 'c', create)).toBe(3)
    // 'a' 已被清理，重新创建
    expect(cache.getOrCreate('p', 'a', create)).toBe(4)
  })
})
