import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PinnedVerifierConfig } from '@gravitas/shared'
import { GoalCoordinator } from './goal-coordinator'
import { ElectronGoalStore } from './goal-store'
import { ProtectedVerifierStore, type KeyProtector } from '../protected-verifier-store'

const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
const dirs: string[] = []
afterEach(() => {
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const testProtector: KeyProtector = {
  encrypt: (plain) => Buffer.from(plain.map((b) => b ^ 0x5a)),
  decrypt: (cipher) => Buffer.from(cipher.map((b) => b ^ 0x5a)),
}
const verifier: PinnedVerifierConfig = {
  version: 1, verifierId: 'fixture-bun', argv: ['bun', 'test'], expectedExitCodes: [0], timeoutMs: 60_000, minimumTests: 1,
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-bind-'))
  dirs.push(dir); process.env.PROMA_TEST_CONFIG_DIR = dir
  const store = new ProtectedVerifierStore({ dir: join(dir, 'verifiers'), protector: testProtector })
  const saved = store.save('fixture-bun', verifier, ['**/*.test.ts'])
  const c = new GoalCoordinator(new ElectronGoalStore(), { verifierStore: store })
  const g = c.create({ sessionId: 's', runtime: 'ai-sdk', objective: '目标' })
  const gate = {
    version: 1 as const, repoRoot: '/fixture/repo', baselineCommitSha: 'a'.repeat(40),
    verifierRef: { verifierId: 'fixture-bun', revision: saved.record.revision, recordSha256: saved.recordSha256 },
  }
  return { c, g, gate }
}

describe('Goal 完成门禁绑定', () => {
  test('未运行的 Goal 可绑定，门禁持久化且经校验', () => {
    const w = fixture()
    const updated = w.c.bindCompletionGate(w.g.id, w.gate)
    expect(updated.completionGate).toEqual(w.gate)
    expect(w.c.get(w.g.id)?.completionGate?.verifierRef.revision).toBe(w.gate.verifierRef.revision)
  })
  test('运行中的 Goal 拒绝绑定', () => {
    const w = fixture()
    w.c.captureRun('s')
    expect(() => w.c.bindCompletionGate(w.g.id, w.gate)).toThrow('暂停后再绑定')
  })
  test('已结束的 Goal 拒绝绑定', () => {
    const w = fixture()
    w.c.setStatus(w.g.id, 'cancelled')
    expect(() => w.c.bindCompletionGate(w.g.id, w.gate)).toThrow('已结束')
  })
  test('非法门禁（未知引用、相对路径）拒绝且不写入', () => {
    const w = fixture()
    expect(() => w.c.bindCompletionGate(w.g.id, { ...w.gate, repoRoot: 'relative' })).toThrow('repoRoot')
    expect(() => w.c.bindCompletionGate(w.g.id, { ...w.gate, verifierRef: { ...w.gate.verifierRef, verifierId: 'missing' } })).toThrow('不存在')
    expect(w.c.get(w.g.id)?.completionGate).toBeUndefined()
  })
  test('绑定后提交 complete 仍走门禁验证（默认验证器）', async () => {
    const w = fixture()
    w.c.bindCompletionGate(w.g.id, { ...w.gate, repoRoot: '/nonexistent' })
    const run = w.c.captureRun('s')!
    await run.onPrepared({ runtime: 'ai-sdk', workspaceId: undefined, channelId: 'ch', requestedModelId: undefined, provider: 'openai', cwd: '/fixture' })
    await expect(run.onCheckpoint({ outcome: 'complete', summary: '完成', completed: [], evidence: [] })).rejects.toThrow('无法解析仓库 HEAD 提交')
    expect(w.c.get(w.g.id)?.status).toBe('active')
  })
})
