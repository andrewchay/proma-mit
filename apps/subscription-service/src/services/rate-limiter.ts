/**
 * 内存滑动窗口限流器。
 *
 * 用途：保护登录、发码、下单等易被滥用的端点。
 *
 * 已知边界：
 * - 状态存于进程内存。单实例部署下有效；多实例部署需要换成 Redis 等共享存储，
 *   否则每个实例各自限流，实际放行量会翻倍。
 * - 仅按 key 限流，不区分用户是否合法。生产环境应同时在反向代理层做 IP 限流。
 */

export interface RateLimitConfig {
  /** 窗口内允许的次数 */
  limit: number
  /** 窗口长度（毫秒） */
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  /** 被拒绝时建议的重试等待时间 */
  retryAfterMs?: number
  /** 剩余可用次数 */
  remaining: number
}

interface BucketEntry {
  timestamps: number[]
}

export class RateLimiter {
  private readonly buckets = new Map<string, BucketEntry>()

  check(key: string, config: RateLimitConfig, now: number = Date.now()): RateLimitResult {
    const windowStart = now - config.windowMs
    const entry = this.buckets.get(key) ?? { timestamps: [] }

    // 滑动窗口：剔除已滑出的记录
    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > windowStart)

    if (entry.timestamps.length >= config.limit) {
      this.buckets.set(key, entry)
      const oldest = entry.timestamps[0] ?? now
      return {
        allowed: false,
        retryAfterMs: Math.max(1, oldest + config.windowMs - now),
        remaining: 0,
      }
    }

    entry.timestamps.push(now)
    this.buckets.set(key, entry)
    return { allowed: true, remaining: config.limit - entry.timestamps.length }
  }

  reset(key: string): void {
    this.buckets.delete(key)
  }

  /**
   * 清理全部已空的 bucket，避免长期运行时 Map 无限增长。
   * 由调用方定期触发。
   */
  prune(now: number = Date.now(), maxWindowMs: number = 60 * 60 * 1000): void {
    const cutoff = now - maxWindowMs
    for (const [key, entry] of this.buckets.entries()) {
      const kept = entry.timestamps.filter((timestamp) => timestamp > cutoff)
      if (kept.length === 0) {
        this.buckets.delete(key)
      } else {
        entry.timestamps = kept
      }
    }
  }
}

/**
 * 从请求头提取客户端 IP。
 *
 * 安全考量：只有当请求确实经过可信反向代理时（trustedProxyCidrs 非空），
 * 才信任 X-Forwarded-For。否则该头可被任意伪造，用作限流 key 会导致
 * 攻击者通过变换该头绕过限流。
 */
export function extractClientIp(request: Request, trustedProxyCidrs: readonly string[]): string {
  if (trustedProxyCidrs.length === 0) return 'unknown'

  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    // 从左到右找第一个非可信代理地址，即真实客户端
    const candidates = forwarded.split(',').map((item) => item.trim()).filter(Boolean)
    for (const candidate of candidates) {
      if (!trustedProxyCidrs.some((cidr) => isInCidr(candidate, cidr))) {
        return candidate
      }
    }
  }

  const realIp = request.headers.get('x-real-ip')
  if (realIp && !trustedProxyCidrs.some((cidr) => isInCidr(realIp, cidr))) {
    return realIp.trim()
  }

  return 'unknown'
}

/**
 * 极简 CIDR 判断，仅支持 IPv4 与 /8 /16 /24 /32 等常见前缀长度。
 * 目的只是识别可信代理网段，不追求完整实现。
 */
function isInCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/')
  if (!range || !bitsRaw) return false
  const bits = Number(bitsRaw)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false

  const toInt = (value: string): number | undefined => {
    const parts = value.split('.')
    if (parts.length !== 4) return undefined
    let result = 0
    for (const part of parts) {
      const num = Number(part)
      if (!Number.isInteger(num) || num < 0 || num > 255) return undefined
      result = result * 256 + num
    }
    return result
  }

  const ipInt = toInt(ip)
  const rangeInt = toInt(range)
  if (ipInt === undefined || rangeInt === undefined) return false

  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
  return (ipInt & mask) === (rangeInt & mask)
}
