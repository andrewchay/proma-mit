import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PinnedVerifierConfig } from '@gravitas/shared'
import { ProtectedVerifierStore, type KeyProtector } from './protected-verifier-store'

const root = mkdtempSync(join(tmpdir(), 'gravitas-protected-store-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let counter = 0
// 仅测试用可逆变换；生产使用 safeStorage。
const testProtector: KeyProtector = {
  encrypt: (plain) => Buffer.from(plain.map((b) => b ^ 0x5a)),
  decrypt: (cipher) => Buffer.from(cipher.map((b) => b ^ 0x5a)),
}
function newStore(protector: KeyProtector = testProtector): { store: ProtectedVerifierStore; dir: string } {
  const dir = join(root, `store-${counter++}`)
  return { store: new ProtectedVerifierStore({ dir, protector }), dir }
}
const config: PinnedVerifierConfig = { version: 1, verifierId: 'bun-unit', argv: ['bun', 'test'], expectedExitCodes: [0], timeoutMs: 60_000, minimumTests: 1 }
const PATHS = ['**/*.test.ts']

describe('受保护验证配置：签名记录与修订', () => {
  test('保存递增修订，读取返回最新记录与稳定哈希', () => {
    const { store } = newStore()
    const first = store.save('bun-unit', config, PATHS)
    const second = store.save('bun-unit', { ...config, minimumTests: 2 }, PATHS)
    expect(first.record.revision).toBe(1)
    expect(second.record.revision).toBe(2)
    expect(store.load('bun-unit').record.config.minimumTests).toBe(2)
    expect(store.save('other-id', config, PATHS).record.revision).toBe(1)
    expect(store.load('bun-unit').recordSha256).toBe(second.recordSha256)
  })
  test('目录0700、记录与密钥文件0600', () => {
    const { store, dir } = newStore()
    store.save('bun-unit', config, PATHS)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'bun-unit.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'signing-key.enc')).mode & 0o777).toBe(0o600)
  })
  test('篡改记录内容（argv）后读取拒绝，签名不匹配', () => {
    const { store, dir } = newStore()
    store.save('bun-unit', config, PATHS)
    const file = join(dir, 'bun-unit.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('"test"', '"--help"'))
    expect(() => store.load('bun-unit')).toThrow('签名')
  })
  test('重新生成密钥后旧记录不可验证', () => {
    const { store, dir } = newStore()
    store.save('bun-unit', config, PATHS)
    rmSync(join(dir, 'signing-key.enc'))
    const next = new ProtectedVerifierStore({ dir, protector: testProtector })
    expect(() => next.load('bun-unit')).toThrow('签名')
  })
  test('密钥无法解密时失败关闭，不回退到明文', () => {
    const { store, dir } = newStore()
    store.save('bun-unit', config, PATHS)
    const broken: KeyProtector = { encrypt: testProtector.encrypt, decrypt: () => { throw new Error('keychain denied') } }
    expect(() => new ProtectedVerifierStore({ dir, protector: broken }).load('bun-unit')).toThrow('keychain denied')
  })
  test('审计哈希链保存每次写入，篡改审计行被检测', () => {
    const { store, dir } = newStore()
    store.save('bun-unit', config, PATHS)
    store.save('bun-unit', { ...config, minimumTests: 3 }, PATHS)
    expect(store.auditValid()).toBe(true)
    const audit = join(dir, 'audit.jsonl')
    const lines = readFileSync(audit, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    writeFileSync(audit, lines.map((line) => line.replace('"revision":1', '"revision":9')).join('\n') + '\n')
    expect(store.auditValid()).toBe(false)
    expect(existsSync(audit)).toBe(true)
  })
  test('绑定引用：修订或哈希不一致即拒绝（配置更新需重新创建Goal）', () => {
    const { store } = newStore()
    const v1 = store.save('bun-unit', config, PATHS)
    const ref = { verifierId: 'bun-unit', revision: v1.record.revision, recordSha256: v1.recordSha256 }
    expect(store.verifyRef(ref).recordSha256).toBe(v1.recordSha256)
    store.save('bun-unit', { ...config, minimumTests: 5 }, PATHS)
    expect(() => store.verifyRef(ref)).toThrow('已更新')
    const current = store.load('bun-unit')
    expect(() => store.verifyRef({ verifierId: 'bun-unit', revision: current.record.revision, recordSha256: 'f'.repeat(64) })).toThrow('不一致')
  })
  test('受保护路径属于签名记录：篡改路径被检测，非法模式拒绝保存', () => {
    const { store, dir } = newStore()
    store.save('bun-unit', config, PATHS)
    const file = join(dir, 'bun-unit.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('"**/*.test.ts"', '"src/**"'))
    expect(() => store.load('bun-unit')).toThrow('签名')
    expect(() => newStore().store.save('bad-paths', config, ['../escape'])).toThrow('protectedPaths')
    expect(() => newStore().store.save('empty-paths', config, [])).toThrow('protectedPaths')
  })
  test('非法 verifierId 拒绝，防止路径穿越', () => {
    const { store } = newStore()
    expect(() => store.save('../escape', config, PATHS)).toThrow('verifierId')
    expect(() => store.load('UPPER')).toThrow('verifierId')
  })
})
