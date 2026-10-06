import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { getSubscriptionTokensPath } from '../config-paths'

export interface StoredSubscriptionTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/**
 * 订阅令牌的本地安全存储。
 *
 * 使用 Electron safeStorage 加密后落盘。
 * 已知边界：
 * - safeStorage 的密钥属于当前机器与系统账户，换机或重装后无法解密，
 *   此时视为未登录（用户需重新登录），这是预期行为而非缺陷。
 * - 系统不支持加密（Linux 无可用后端等）时拒绝明文落盘，
 *   令牌仅保存在内存中，进程退出即失效。
 */
export class SubscriptionAuthService {
  private tokens: StoredSubscriptionTokens | undefined
  private encryptionUnavailableWarned = false

  load(): StoredSubscriptionTokens | undefined {
    if (this.tokens) return this.tokens
    const path = getSubscriptionTokensPath()
    if (!existsSync(path)) return undefined

    if (!safeStorage.isEncryptionAvailable()) {
      // 无法解密已存文件：可能是换机、系统重装或加密后端不可用
      return undefined
    }

    try {
      const encrypted = readFileSync(path)
      const decrypted = safeStorage.decryptString(encrypted)
      this.tokens = JSON.parse(decrypted) as StoredSubscriptionTokens
      return this.tokens
    } catch {
      // 解密或解析失败（换机、密钥轮换、文件损坏）统一视为未登录
      return undefined
    }
  }

  save(tokens: StoredSubscriptionTokens): void {
    this.tokens = tokens

    if (!safeStorage.isEncryptionAvailable()) {
      // 加密不可用时只保留内存副本，绝不写入明文
      if (!this.encryptionUnavailableWarned) {
        console.warn('[subscription] 系统安全存储不可用，订阅令牌仅保存在内存中，重启后需重新登录')
        this.encryptionUnavailableWarned = true
      }
      return
    }

    const path = getSubscriptionTokensPath()
    mkdirSync(dirname(path), { recursive: true })
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens))
    writeFileSync(path, encrypted, { mode: 0o600 })
  }

  clear(): void {
    this.tokens = undefined
    const path = getSubscriptionTokensPath()
    if (existsSync(path)) rmSync(path)
  }
}
