/**
 * Runtime 凭证加解密抽象。
 *
 * Electron 默认使用 safeStorage；服务端 Web 可以注入 KMS、数据库字段加密等实现。
 */

import { createRequire } from 'node:module'

export interface RuntimeSecretCodec {
  encode(plain: string, scope: string): string
  decode(encoded: string, scope: string): string
}

class ElectronSafeStorageSecretCodec implements RuntimeSecretCodec {
  private safeStorageCache: typeof import('electron').safeStorage | null | undefined

  encode(plain: string, scope: string): string {
    const safeStorage = this.getSafeStorage()
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      console.warn(`[${scope}] safeStorage 不可用，将以 base64 明文存储`)
      return Buffer.from(plain).toString('base64')
    }
    return safeStorage.encryptString(plain).toString('base64')
  }

  decode(encoded: string): string {
    const safeStorage = this.getSafeStorage()
    const buffer = Buffer.from(encoded, 'base64')
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      return buffer.toString('utf-8')
    }
    return safeStorage.decryptString(buffer)
  }

  private getSafeStorage(): typeof import('electron').safeStorage | null {
    if (this.safeStorageCache !== undefined) return this.safeStorageCache
    try {
      const require = createRequire(import.meta.url)
      const electron = require('electron') as typeof import('electron')
      this.safeStorageCache = electron.safeStorage ?? null
    } catch {
      this.safeStorageCache = null
    }
    return this.safeStorageCache
  }
}

let runtimeSecretCodec: RuntimeSecretCodec = new ElectronSafeStorageSecretCodec()

export function getRuntimeSecretCodec(): RuntimeSecretCodec {
  return runtimeSecretCodec
}

export function setRuntimeSecretCodecForTesting(codec?: RuntimeSecretCodec): void {
  runtimeSecretCodec = codec ?? new ElectronSafeStorageSecretCodec()
}
