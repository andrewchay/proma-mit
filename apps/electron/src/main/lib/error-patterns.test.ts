import { describe, expect, test } from 'bun:test'
import { isTransientNetworkError } from './error-patterns'

describe('isTransientNetworkError', () => {
  test('已知断连错误模式返回 true', () => {
    expect(isTransientNetworkError('socket hang up')).toBe(true)
    expect(isTransientNetworkError('ECONNRESET')).toBe(true)
    expect(isTransientNetworkError('ECONNABORTED')).toBe(true)
    expect(isTransientNetworkError('fetch failed')).toBe(true)
    expect(isTransientNetworkError('connection closed')).toBe(true)
    expect(isTransientNetworkError('connection lost')).toBe(true)
    expect(isTransientNetworkError('connection refused')).toBe(true)
    expect(isTransientNetworkError('other side closed')).toBe(true)
    expect(isTransientNetworkError('AbortError')).toBe(true)
    expect(isTransientNetworkError('The operation was aborted')).toBe(true)
    expect(isTransientNetworkError('request timed out')).toBe(true)
    expect(isTransientNetworkError('stream ended prematurely')).toBe(true)
  })

  test('非断连错误返回 false', () => {
    expect(isTransientNetworkError('invalid_api_key')).toBe(false)
    expect(isTransientNetworkError('prompt too long')).toBe(false)
    expect(isTransientNetworkError('400 Bad Request')).toBe(false)
    expect(isTransientNetworkError('')).toBe(false)
    expect(isTransientNetworkError(undefined)).toBe(false)
  })
})
