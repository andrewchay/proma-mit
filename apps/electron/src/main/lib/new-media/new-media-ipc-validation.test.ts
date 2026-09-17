import { describe, expect, test } from 'bun:test'
import {
  NEW_MEDIA_LIMITS,
  NewMediaIpcValidationError,
  assertPlainObject,
  newMediaIpcError,
  optionalId,
  requireFiniteNumber,
  requireFutureTimestamp,
  requireHttpUrl,
  requireId,
  requirePlatform,
  requireRichText,
  requireStringArray,
  requireTimestamp,
  withNewMediaIpcValidation,
} from './new-media-ipc-validation'

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof NewMediaIpcValidationError) return error.code
    throw error
  }
  throw new Error('预期抛出校验错误')
}

describe('新媒体 IPC 运行时校验', () => {
  test('拒绝畸形平台与未枚举取值', () => {
    expect(requirePlatform('xiaohongshu')).toBe('xiaohongshu')
    expect(requirePlatform('wechat-official-account')).toBe('wechat-official-account')
    expect(codeOf(() => requirePlatform('weibo'))).toBe('invalid_enum')
    expect(codeOf(() => requirePlatform(undefined))).toBe('invalid_enum')
  })

  test('拒绝空、超长与含控制字符的 ID', () => {
    expect(requireId('  abc-1  ', 'id')).toBe('abc-1')
    expect(codeOf(() => requireId('', 'id'))).toBe('invalid_text')
    expect(codeOf(() => requireId('a'.repeat(NEW_MEDIA_LIMITS.id + 1), 'id'))).toBe('text_too_long')
    expect(codeOf(() => requireId('bad\u0007id', 'id'))).toBe('invalid_id')
    expect(optionalId(undefined, 'id')).toBeUndefined()
    expect(optionalId('', 'id')).toBeUndefined()
  })

  test('拒绝非对象载荷与超长正文', () => {
    expect(codeOf(() => assertPlainObject(null, 'input'))).toBe('invalid_payload')
    expect(codeOf(() => assertPlainObject([], 'input'))).toBe('invalid_payload')
    expect(codeOf(() => assertPlainObject('text', 'input'))).toBe('invalid_payload')
    expect(codeOf(() => requireRichText('a'.repeat(NEW_MEDIA_LIMITS.sourceText + 1), 'sourceText', NEW_MEDIA_LIMITS.sourceText))).toBe('text_too_long')
  })

  test('时间戳必须是毫秒整数，排程必须是未来时间', () => {
    const now = Date.now()
    expect(requireTimestamp(now, 'capturedAt')).toBe(now)
    expect(codeOf(() => requireTimestamp(now + 0.5, 'capturedAt'))).toBe('invalid_timestamp')
    expect(codeOf(() => requireTimestamp('1710000000000', 'capturedAt'))).toBe('invalid_number')
    expect(codeOf(() => requireFutureTimestamp(now - 1, 'scheduledAt', now))).toBe('invalid_timestamp')
    expect(requireFutureTimestamp(now + 1000, 'scheduledAt', now)).toBe(now + 1000)
  })

  test('数组去重、限项并拒绝越界数值', () => {
    expect(requireStringArray([' a ', 'a', '', 'b'], 'keywords')).toEqual(['a', 'b'])
    expect(codeOf(() => requireStringArray([], 'keywords'))).toBe('invalid_array')
    expect(requireStringArray([], 'relatedKeywords', { allowEmpty: true })).toEqual([])
    expect(codeOf(() => requireStringArray(Array.from({ length: NEW_MEDIA_LIMITS.arrayItems + 1 }, (_, index) => `k${index}`), 'keywords'))).toBe('invalid_array')
    expect(codeOf(() => requireStringArray([1, 2], 'keywords'))).toBe('invalid_array')
    expect(codeOf(() => requireFiniteNumber(120, 'heat', { max: 100 }))).toBe('invalid_number')
    expect(requireFiniteNumber(0, 'impressions', { min: 0 })).toBe(0)
  })

  test('只接受 http 或 https 链接', () => {
    expect(requireHttpUrl('https://example.com/a', 'sourceUrl')).toBe('https://example.com/a')
    expect(codeOf(() => requireHttpUrl('javascript:alert(1)', 'sourceUrl'))).toBe('invalid_url')
    expect(codeOf(() => requireHttpUrl('不是链接', 'sourceUrl'))).toBe('invalid_url')
  })

  test('校验错误转换为稳定格式，业务错误保持原样', async () => {
    const formatted = newMediaIpcError(new NewMediaIpcValidationError({ code: 'invalid_platform', field: '平台', message: '平台取值无效' }))
    expect(formatted.message).toBe('new_media:invalid_platform:平台: 平台取值无效')

    await expect(withNewMediaIpcValidation(() => { throw new Error('内容草稿不存在') })).rejects.toThrow('内容草稿不存在')
    await expect(withNewMediaIpcValidation(() => { requirePlatform('weibo'); return 1 })).rejects.toThrow('new_media:invalid_enum:平台')
  })
})
