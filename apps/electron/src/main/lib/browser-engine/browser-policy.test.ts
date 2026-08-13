import { describe, expect, test } from 'bun:test'
import { assertSafeBrowserDestination, assertSafeBrowserUrl, normalizeBrowserUrl } from './browser-policy'

describe('normalizeBrowserUrl', () => {
  test('given a bare https domain then HTTPS is defaulted', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com')
  })

  test('given a bare localhost domain then HTTP is used (local dev without TLS)', () => {
    expect(normalizeBrowserUrl('localhost')).toBe('http://localhost')
    expect(normalizeBrowserUrl('app.localhost')).toBe('http://app.localhost')
  })

  test('given localhost with port then HTTP is used', () => {
    expect(normalizeBrowserUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeBrowserUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(normalizeBrowserUrl('[::1]:8080')).toBe('http://[::1]:8080')
  })

  test('given a non-loopback domain with port then HTTPS is defaulted', () => {
    expect(normalizeBrowserUrl('example.com:8080')).toBe('https://example.com:8080')
  })

  test('given an explicit protocol then it is preserved', () => {
    expect(normalizeBrowserUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeBrowserUrl('http://example.com')).toBe('http://example.com')
  })

  test('given a protocol-relative URL then HTTPS is added', () => {
    expect(normalizeBrowserUrl('//example.com')).toBe('https://example.com')
  })

  test('given an empty string then an error is thrown', () => {
    expect(() => normalizeBrowserUrl('   ')).toThrow('浏览器地址不能为空')
  })
})

describe('assertSafeBrowserUrl', () => {
  test('given a valid URL then the normalized URL string is returned', () => {
    expect(assertSafeBrowserUrl('example.com')).toBe('https://example.com/')
  })

  test('given an unparseable value then an error is thrown', () => {
    expect(() => assertSafeBrowserUrl('://not-a-url')).toThrow('浏览器地址无效')
  })
})

describe('assertSafeBrowserDestination', () => {
  test('given a valid destination then it resolves', async () => {
    await expect(assertSafeBrowserDestination('example.com/path')).resolves.toBe('https://example.com/path')
  })

  test('given an invalid destination then it rejects', async () => {
    await expect(assertSafeBrowserDestination('://bad')).rejects.toThrow()
  })
})
