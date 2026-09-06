import { describe, expect, test } from 'bun:test'
import { isContextOverflowError } from './error-patterns'

describe('上下文溢出恢复', () => {
  test('只识别明确的上下文长度超限错误', () => {
    expect(isContextOverflowError('maximum context length is 256000 tokens')).toBe(true)
    expect(isContextOverflowError('context_length_exceeded')).toBe(true)
    expect(isContextOverflowError('prompt is too long for this model')).toBe(true)
    expect(isContextOverflowError('400 Bad Request')).toBe(false)
    expect(isContextOverflowError('socket hang up')).toBe(false)
  })
})
