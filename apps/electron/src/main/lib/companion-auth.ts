/**
 * Companion 认证模块
 *
 * 手机浏览器首次访问时用一次性配对码换取长期 token；
 * 主进程只保存 token 的 SHA-256 hash（写入 settings.companionServer.tokenHash），
 * 明文仅出现在配对响应中，不落盘、不进日志。
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { updateSettings, getSettings } from './settings-service'

/** 配对码有效期（毫秒） */
const PAIRING_CODE_TTL_MS = 120_000

interface PendingPairingCode {
  code: string
  expiresAt: number
}

let pendingPairing: PendingPairingCode | null = null

/** 生成一次性配对码（6 位数字，120 秒有效） */
export function generatePairingCode(): string {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  pendingPairing = { code, expiresAt: Date.now() + PAIRING_CODE_TTL_MS }
  return code
}

/** 校验并消费配对码；过期或不匹配返回 false（无论匹配与否都消费，防暴力枚举） */
export function verifyPairingCode(code: string): boolean {
  if (!pendingPairing || Date.now() > pendingPairing.expiresAt) return false
  const ok = code === pendingPairing.code
  pendingPairing = null
  return ok
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 签发新 token：明文返回给调用方（配对响应），hash 持久化到 settings */
export async function issueToken(): Promise<{ token: string; tokenHash: string }> {
  const token = randomBytes(32).toString('hex')
  const tokenHash = sha256Hex(token)
  updateSettings({ companionServer: { tokenHash } })
  return { token, tokenHash }
}

/** 常量时间校验 Bearer token */
export function verifyToken(token: string | undefined | null): boolean {
  if (!token) return false
  const storedHash = getSettings().companionServer?.tokenHash
  if (!storedHash) return false
  const given = Buffer.from(sha256Hex(token), 'hex')
  const stored = Buffer.from(storedHash, 'hex')
  return given.length === stored.length && timingSafeEqual(given, stored)
}

/** 测试专用：清空内存态 */
export function _resetForTest(): void {
  pendingPairing = null
}
