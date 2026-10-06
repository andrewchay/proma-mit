import { describe, expect, test } from 'bun:test'
import {
  hashEmail,
  normalizeEmail,
  generateOtpCode,
  hashOtpCode,
  verifyOtpCode,
  isOtpExpired,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
} from './email-otp'

const PEPPER = 'test-pepper-value'

describe('邮箱归一化', () => {
  test('转小写并去除首尾空白', () => {
    expect(normalizeEmail('  Alice@Example.COM  ')).toBe('alice@example.com')
  })

  test('拒绝无 @ 的输入', () => {
    expect(normalizeEmail('not-an-email')).toBe('')
  })

  test('拒绝含空格的输入', () => {
    expect(normalizeEmail('a b@example.com')).toBe('')
  })

  test('拒绝过长输入', () => {
    const long = `${'a'.repeat(300)}@example.com`
    expect(normalizeEmail(long)).toBe('')
  })

  test('接受带加号的正常邮箱', () => {
    expect(normalizeEmail('user+tag@example.com')).toBe('user+tag@example.com')
  })
})

describe('邮箱哈希', () => {
  test('相同邮箱与 pepper 得到相同哈希', () => {
    const a = hashEmail('a@example.com', PEPPER)
    const b = hashEmail('a@example.com', PEPPER)
    expect(a).toBe(b)
  })

  test('不同 pepper 得到不同哈希', () => {
    const a = hashEmail('a@example.com', PEPPER)
    const b = hashEmail('a@example.com', 'other-pepper')
    expect(a).not.toBe(b)
  })

  test('哈希不包含明文邮箱', () => {
    const hash = hashEmail('alice@example.com', PEPPER)
    expect(hash).not.toContain('alice')
    expect(hash).not.toContain('example.com')
    expect(hash).not.toContain('@')
  })

  test('哈希长度稳定（sha256 hex = 64）', () => {
    expect(hashEmail('a@example.com', PEPPER)).toHaveLength(64)
  })

  test('大小写不同的同一邮箱得到相同哈希', () => {
    expect(hashEmail('A@Example.com', PEPPER)).toBe(hashEmail('a@example.com', PEPPER))
  })
})

describe('验证码生成', () => {
  test('生成 6 位数字', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateOtpCode()
      expect(code).toMatch(/^\d{6}$/)
    }
  })

  test('生成结果具备随机性，不总是相同', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 50; i += 1) codes.add(generateOtpCode())
    // 50 次生成至少应出现多个不同值
    expect(codes.size).toBeGreaterThan(10)
  })
})

describe('验证码哈希与校验', () => {
  test('验证码以哈希存储，不含明文', () => {
    const hash = hashOtpCode('123456', PEPPER)
    expect(hash).not.toContain('123456')
    expect(hash).toHaveLength(64)
  })

  test('正确验证码校验通过', () => {
    const hash = hashOtpCode('123456', PEPPER)
    expect(verifyOtpCode('123456', hash, PEPPER)).toBe(true)
  })

  test('错误验证码校验失败', () => {
    const hash = hashOtpCode('123456', PEPPER)
    expect(verifyOtpCode('654321', hash, PEPPER)).toBe(false)
  })

  test('长度不同的验证码不会抛异常', () => {
    const hash = hashOtpCode('123456', PEPPER)
    expect(verifyOtpCode('1', hash, PEPPER)).toBe(false)
    expect(verifyOtpCode('', hash, PEPPER)).toBe(false)
  })
})

describe('验证码有效期与尝试次数', () => {
  test('新建验证码未过期', () => {
    const now = 1_800_000_000_000
    expect(isOtpExpired(now + OTP_TTL_MS, now)).toBe(false)
  })

  test('超过有效期视为过期', () => {
    const now = 1_800_000_000_000
    expect(isOtpExpired(now - 1, now)).toBe(true)
  })

  test('恰好等于当前时刻视为过期', () => {
    const now = 1_800_000_000_000
    expect(isOtpExpired(now, now)).toBe(true)
  })

  test('验证码有效期不超过 10 分钟', () => {
    expect(OTP_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000)
  })

  test('尝试次数上限不超过 5 次', () => {
    expect(OTP_MAX_ATTEMPTS).toBeLessThanOrEqual(5)
  })
})
