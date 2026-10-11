import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SaveVerifierInput } from '@gravitas/shared'
import { ProtectedVerifierStore, type KeyProtector } from './protected-verifier-store'
import { VerifierSettingsService } from './verifier-settings-service'

const testProtector: KeyProtector = {
  encrypt: (plain) => Buffer.from(plain.map((b) => b ^ 0x5a)),
  decrypt: (cipher) => Buffer.from(cipher.map((b) => b ^ 0x5a)),
}
const root = mkdtempSync(join(tmpdir(), 'gravitas-verifier-service-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let counter = 0
function service(): VerifierSettingsService {
  const store = new ProtectedVerifierStore({ dir: join(root, `s${counter++}`), protector: testProtector })
  return new VerifierSettingsService(store)
}
const input: SaveVerifierInput = {
  verifierId: 'bun-unit',
  config: { version: 1, verifierId: 'bun-unit', argv: ['bun', 'test'], expectedExitCodes: [0], timeoutMs: 60_000, minimumTests: 1 },
  protectedPaths: ['**/*.test.ts'],
}

describe('验证器设置服务', () => {
  test('保存返回摘要，列表按 id 排序并包含修订与哈希', () => {
    const svc = service()
    const saved = svc.save(input)
    expect(saved).toMatchObject({ verifierId: 'bun-unit', revision: 1, protectedPaths: ['**/*.test.ts'] })
    svc.save({ ...input, verifierId: 'alpha' })
    const second = svc.save(input)
    expect(second.revision).toBe(2)
    expect(svc.list().map((v) => v.verifierId)).toEqual(['alpha', 'bun-unit'])
    expect(svc.list().find((v) => v.verifierId === 'bun-unit')?.recordSha256).toBe(second.recordSha256)
  })
  test('非法输入拒绝：坏 id、空 argv、非法退出码、超时越界、最少测试数、非法路径', () => {
    const svc = service()
    expect(() => svc.save({ ...input, verifierId: 'Bad Id' })).toThrow()
    expect(() => svc.save({ ...input, config: { ...input.config, argv: [] } })).toThrow('argv')
    expect(() => svc.save({ ...input, config: { ...input.config, expectedExitCodes: [1.5] } })).toThrow()
    expect(() => svc.save({ ...input, config: { ...input.config, timeoutMs: 0 } })).toThrow('timeoutMs')
    expect(() => svc.save({ ...input, config: { ...input.config, minimumTests: 0 } })).toThrow('minimumTests')
    expect(() => svc.save({ ...input, protectedPaths: ['../x'] })).toThrow('protectedPaths')
  })
  test('损坏的记录在列表中标记 error，不抛出', () => {
    const svc = service()
    svc.save(input)
    const storeDir = (svc as unknown as { store: ProtectedVerifierStore }).store
    const dir = (storeDir as unknown as { dir: string }).dir
    writeFileSync(join(dir, 'bun-unit.json'), '{"broken":true}')
    const listed = svc.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.error).toBeTruthy()
    expect(listed[0]?.revision).toBe(0)
  })
})
