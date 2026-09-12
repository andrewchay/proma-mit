import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { getSubscriptionTokensPath } from '../config-paths'

export interface StoredSubscriptionTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export class SubscriptionAuthService {
  private tokens: StoredSubscriptionTokens | undefined

  load(): StoredSubscriptionTokens | undefined {
    if (this.tokens) return this.tokens
    const path = getSubscriptionTokensPath()
    if (!existsSync(path)) return undefined
    try {
      const encrypted = readFileSync(path)
      const decrypted = safeStorage.decryptString(encrypted)
      this.tokens = JSON.parse(decrypted) as StoredSubscriptionTokens
      return this.tokens
    } catch {
      return undefined
    }
  }

  save(tokens: StoredSubscriptionTokens): void {
    const path = getSubscriptionTokensPath()
    mkdirSync(dirname(path), { recursive: true })
    const encrypted = safeStorage.encryptString(JSON.stringify(tokens))
    writeFileSync(path, encrypted)
    this.tokens = tokens
  }

  clear(): void {
    this.tokens = undefined
    const path = getSubscriptionTokensPath()
    if (existsSync(path)) rmSync(path)
  }
}
