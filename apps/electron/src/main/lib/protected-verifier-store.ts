/**
 * 受保护验证配置存储：HMAC 签名记录 + safeStorage 加密的签名密钥 + 哈希链审计。
 *
 * 边界：
 * - 签名防的是“未持有密钥的写入者改写记录”；同用户进程若能解密 safeStorage 密钥仍可伪造。
 * - Agent 的 Bash 工具需要沙箱隔离（另行实施），否则不能宣称已防住 Agent 篡改。
 * - 审计哈希链只能发现事后的不一致，不能阻止拥有写权限的人删除整条链。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PinnedVerifierConfig, ProtectedVerifierRef } from '@gravitas/shared'
import { getConfigDir } from './config-paths'
import { assertProtectedPatterns } from './completion-protected-paths'

const VERIFIER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const KEY_BYTES = 32

export interface KeyProtector {
  encrypt(plain: Buffer): Buffer
  decrypt(cipher: Buffer): Buffer
}

/** 生产密钥保护：Electron safeStorage（macOS 钥匙串 / Windows DPAPI / Linux Secret Service）。 */
export function createSafeStorageKeyProtector(): KeyProtector {
  // 延迟加载：测试与非 Electron 环境不会触碰 electron 模块。
  const electron = require('electron') as typeof import('electron')
  const storage = electron.safeStorage
  const available = (): void => {
    if (!storage.isEncryptionAvailable()) throw new Error('safeStorage 不可用，拒绝以明文保存签名密钥')
  }
  return {
    encrypt: (plain) => { available(); return storage.encryptString(plain.toString('base64')) },
    decrypt: (cipher) => { available(); return Buffer.from(storage.decryptString(cipher), 'base64') },
  }
}

export interface ProtectedVerifierRecord {
  readonly version: 1
  readonly verifierId: string
  readonly revision: number
  readonly config: PinnedVerifierConfig
  /** 受保护路径模式：统一由存储维护，Goal 不得覆盖。 */
  readonly protectedPaths: readonly string[]
  readonly savedAt: string
}

export interface StoredVerifier {
  readonly record: ProtectedVerifierRecord
  readonly recordSha256: string
}

interface StoredFile {
  record: ProtectedVerifierRecord
  recordSha256: string
  signature: string
}

/** 规范化 JSON：对象键排序，保证同一内容产生相同的哈希与签名。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export class ProtectedVerifierStore {
  private readonly dir: string
  private readonly protector: KeyProtector
  private readonly now: () => Date

  constructor(options: { dir?: string; protector?: KeyProtector; now?: () => Date } = {}) {
    this.dir = options.dir ?? join(getConfigDir(), 'verifiers')
    this.protector = options.protector ?? createSafeStorageKeyProtector()
    this.now = options.now ?? (() => new Date())
  }

  save(verifierId: string, config: PinnedVerifierConfig, protectedPaths: readonly string[]): StoredVerifier {
    assertVerifierId(verifierId)
    assertProtectedPatterns(protectedPaths)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const key = this.ensureKey()
    const previous = existsSync(this.recordPath(verifierId)) ? this.load(verifierId) : undefined
    const record: ProtectedVerifierRecord = {
      version: 1, verifierId, revision: (previous?.record.revision ?? 0) + 1, config, protectedPaths: [...protectedPaths], savedAt: this.now().toISOString(),
    }
    const canonical = canonicalJson(record)
    const recordSha256 = sha256(canonical)
    const file: StoredFile = { record, recordSha256, signature: createHmac('sha256', key).update(canonical).digest('hex') }
    const tmp = `${this.recordPath(verifierId)}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
    renameSync(tmp, this.recordPath(verifierId))
    this.appendAudit({ action: 'save', verifierId, revision: record.revision, recordSha256 })
    return { record, recordSha256 }
  }

  load(verifierId: string): StoredVerifier {
    assertVerifierId(verifierId)
    if (!existsSync(this.recordPath(verifierId))) throw new Error(`验证配置不存在：${verifierId}`)
    const file = JSON.parse(readFileSync(this.recordPath(verifierId), 'utf8')) as StoredFile
    const canonical = canonicalJson(file.record)
    const key = this.readKey()
    const expected = createHmac('sha256', key).update(canonical).digest('hex')
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(file.signature), 'hex')) || file.record.verifierId !== verifierId) {
      throw new Error('验证配置签名校验失败，拒绝使用')
    }
    if (sha256(canonical) !== file.recordSha256) throw new Error('验证配置哈希不一致，拒绝使用')
    return { record: file.record, recordSha256: file.recordSha256 }
  }

  /** Goal 绑定校验：修订变化说明配置已更新，必须重新创建 Goal。 */
  verifyRef(ref: ProtectedVerifierRef): StoredVerifier {
    const stored = this.load(ref.verifierId)
    if (stored.record.revision !== ref.revision) throw new Error('验证配置已更新，请重新创建 Goal')
    if (stored.recordSha256 !== ref.recordSha256) throw new Error('验证配置哈希与 Goal 绑定不一致')
    return stored
  }

  /** 审计链校验：任一行被改写、删除中间行或顺序变化都会失败。 */
  auditValid(): boolean {
    if (!existsSync(this.auditPath())) return true
    let prev = 'genesis'
    for (const line of readFileSync(this.auditPath(), 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as Record<string, unknown> & { hash: string }
      const { hash, ...body } = entry
      if (body.prev !== prev || sha256(canonicalJson(body)) !== hash) return false
      prev = hash
    }
    return true
  }

  private appendAudit(fields: { action: 'save'; verifierId: string; revision: number; recordSha256: string }): void {
    let prev = 'genesis'
    let seq = 1
    if (existsSync(this.auditPath())) {
      const lines = readFileSync(this.auditPath(), 'utf8').split('\n').filter(Boolean)
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]!) as { hash: string; seq: number }
        prev = last.hash
        seq = last.seq + 1
      }
    }
    const body = { seq, at: this.now().toISOString(), ...fields, prev }
    appendFileSync(this.auditPath(), `${JSON.stringify({ ...body, hash: sha256(canonicalJson(body)) })}\n`, { mode: 0o600 })
  }

  private ensureKey(): Buffer {
    if (existsSync(this.keyPath())) return this.readKey()
    const key = randomBytes(KEY_BYTES)
    const tmp = `${this.keyPath()}.tmp`
    writeFileSync(tmp, this.protector.encrypt(key), { mode: 0o600 })
    renameSync(tmp, this.keyPath())
    return key
  }

  private readKey(): Buffer {
    if (!existsSync(this.keyPath())) throw new Error('签名密钥缺失，无法校验验证配置')
    const key = this.protector.decrypt(readFileSync(this.keyPath()))
    if (key.length !== KEY_BYTES) throw new Error('签名密钥格式无效')
    return key
  }

  private recordPath(verifierId: string): string { return join(this.dir, `${verifierId}.json`) }
  private keyPath(): string { return join(this.dir, 'signing-key.enc') }
  private auditPath(): string { return join(this.dir, 'audit.jsonl') }
}

function assertVerifierId(verifierId: string): void {
  if (!VERIFIER_ID_PATTERN.test(verifierId)) throw new Error('verifierId 只能包含小写字母、数字与连字符，长度不超过 64')
}
