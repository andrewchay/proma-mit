import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'

/**
 * 邮箱验证码（OTP）核心逻辑。
 *
 * 安全设计：
 * - 邮箱以 HMAC-SHA256(pepper, normalizedEmail) 存储，不落明文
 * - 验证码只存哈希，数据库泄露也无法直接使用
 * - 校验使用恒定时间比较，避免时序侧信道
 * - 有效期与尝试次数都有上限，防止暴力破解
 */

/** 验证码有效期：10 分钟 */
export const OTP_TTL_MS = 10 * 60 * 1000

/** 单个验证码最多允许的校验尝试次数 */
export const OTP_MAX_ATTEMPTS = 5

/** 同一邮箱两次发送之间的最小间隔，防止刷邮件 */
export const OTP_RESEND_INTERVAL_MS = 60 * 1000

/** 单邮箱在滚动窗口内的发送上限 */
export const OTP_MAX_SENDS_PER_WINDOW = 5
export const OTP_SEND_WINDOW_MS = 60 * 60 * 1000

/**
 * 归一化邮箱：转小写、去空白。
 * 返回空字符串表示输入不合法，调用方应据此拒绝。
 */
export function normalizeEmail(input: string): string {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed || trimmed.length > 254) return ''
  // 必须恰好一个 @，且两侧非空
  const parts = trimmed.split('@')
  if (parts.length !== 2) return ''
  const [local, domain] = parts
  if (!local || !domain) return ''
  // 不得包含空白字符
  if (/\s/.test(trimmed)) return ''
  // 域名至少包含一个点，且不以点开头结尾
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return ''
  return trimmed
}

function hmacHex(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value, 'utf8').digest('hex')
}

/** 邮箱哈希。相同邮箱与 pepper 必得相同结果，用于账号查找。 */
export function hashEmail(email: string, pepper: string): string {
  return hmacHex(normalizeEmail(email), pepper)
}

/** 生成 6 位数字验证码，使用加密安全随机源 */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** 验证码哈希，绑定邮箱避免跨邮箱复用 */
export function hashOtpCode(code: string, pepper: string, emailHash?: string): string {
  return hmacHex(`${emailHash ?? ''}:${code}`, pepper)
}

/** 恒定时间比较验证码 */
export function verifyOtpCode(code: string, expectedHash: string, pepper: string, emailHash?: string): boolean {
  const actual = Buffer.from(hashOtpCode(code, pepper, emailHash), 'hex')
  let expected: Buffer
  try {
    expected = Buffer.from(expectedHash, 'hex')
  } catch {
    return false
  }
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/** 判断验证码是否已过期。恰好等于当前时刻视为已过期。 */
export function isOtpExpired(expiresAt: number, now: number): boolean {
  return expiresAt <= now
}

/** 判断是否允许再次发送。距上次发送不足间隔则拒绝。 */
export function canResendOtp(lastSentAt: number | undefined, now: number): boolean {
  if (lastSentAt === undefined) return true
  return now - lastSentAt >= OTP_RESEND_INTERVAL_MS
}
