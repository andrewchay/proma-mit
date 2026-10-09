import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GoalCompletionGate, PinnedVerifierConfig, PinnedVerifierReceipt } from '@gravitas/shared'
import { GoalCoordinator, type CompletionDecision, type CompletionVerifier } from './goal-coordinator'
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
const BASE = 'a'.repeat(40)
const verifier: PinnedVerifierConfig = {
  version: 1, verifierId: 'fixture-bun', argv: [process.execPath, 'test', '--reporter=junit', '--reporter-outfile={{JUNIT_REPORT}}'],
  expectedExitCodes: [0], timeoutMs: 60_000, minimumTests: 1,
}
const gate: GoalCompletionGate = { version: 1, repoRoot: '/fixture/repo', baselineCommitSha: BASE, protectedPaths: ['**/*.test.ts'], verifier }
const complete = { outcome: 'complete' as const, summary: '完成', completed: [], evidence: [{ kind: 'test' as const, value: 'bun test' }] }

function receipt(verdict: 'passed' | 'failed', reasons: PinnedVerifierReceipt['reasons'] = []): PinnedVerifierReceipt {
  return {
    version: 1, verifierId: 'fixture-bun', commitSha: 'b'.repeat(40), argvSha256: 'c'.repeat(64), cleanCheckout: true, isolation: 'seatbelt-macos',
    exitCode: verdict === 'passed' ? 0 : 1, timedOut: false, tests: 1, failures: verdict === 'passed' ? 0 : 1, errors: 0, skipped: 0,
    verdict, reasons, cleanedUp: true, startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
  }
}
function decision(passed: boolean, reasons: PinnedVerifierReceipt['reasons'] = []): CompletionDecision {
  return { passed, reasons, receipt: receipt(passed ? 'passed' : 'failed', reasons) }
}

function fixture(options: { verify?: CompletionVerifier; withGate?: boolean; gate?: GoalCompletionGate; store?: ProtectedVerifierStore } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-gate-'))
  dirs.push(dir); process.env.PROMA_TEST_CONFIG_DIR = dir
  const store = new ElectronGoalStore()
  const calls: Array<{ repoRoot: string }> = []
  const verify: CompletionVerifier = options.verify ?? (async () => decision(true))
  const c = new GoalCoordinator(store, {
    verifyCompletion: async (g) => { calls.push({ repoRoot: g.repoRoot }); return verify(g) },
    verifierStore: options.store ?? new ProtectedVerifierStore({ dir: join(dir, 'verifiers'), protector: testProtector }),
  })
  const g = c.create({
    sessionId: 's', runtime: 'ai-sdk', objective: '目标', workspaceId: 'w', channelId: 'ch', modelId: 'm',
    acceptanceCriteria: ['测试通过'], ...(options.withGate === false ? {} : { completionGate: options.gate ?? gate }),
  })
  const run = c.captureRun('s')!
  return { c, store, g, run, calls, verifierStore: options.store }
}
async function prepare(run: { onPrepared(r: unknown): Promise<void> }): Promise<void> {
  await run.onPrepared({ runtime: 'ai-sdk', workspaceId: 'w', channelId: 'ch', requestedModelId: 'm', provider: 'openai', cwd: '/fixture' })
}

describe('Goal完成门禁：判定结果与回执', () => {
  test('验证未通过时拒绝complete，原因返回给模型，Goal不完成', async () => {
    const w = fixture({ verify: async () => decision(false, ['exit_code_unexpected', 'test_failures']) })
    await prepare(w.run)
    await expect(w.run.onCheckpoint(complete)).rejects.toThrow('固定基线验证未通过：exit_code_unexpected、test_failures')
    const after = w.c.get(w.g.id)!
    expect(after.status).toBe('active')
    expect(after.completionVerification).toBeUndefined()
    expect(after.checkpoint).toBeUndefined()
  })
  test('受保护路径改动被拒绝时原因可见', async () => {
    const w = fixture({ verify: async () => ({ passed: false, reasons: ['protected_paths_changed', 'protected:tests/a.test.ts'] }) })
    await prepare(w.run)
    await expect(w.run.onCheckpoint(complete)).rejects.toThrow('protected:tests/a.test.ts')
    expect(w.c.get(w.g.id)?.status).toBe('active')
  })
  test('验证通过才完成，并持久化回执', async () => {
    const w = fixture()
    await prepare(w.run)
    await w.run.onCheckpoint(complete)
    const after = w.c.get(w.g.id)!
    expect(after.status).toBe('completed')
    expect(after.completionVerification).toMatchObject({ verdict: 'passed', commitSha: 'b'.repeat(40), isolation: 'seatbelt-macos', tests: 1 })
    expect(w.calls).toEqual([{ repoRoot: '/fixture/repo' }])
  })
  test('无门禁的旧Goal完成行为不变，不调用验证器', async () => {
    const w = fixture({ withGate: false })
    await prepare(w.run)
    await w.run.onCheckpoint(complete)
    expect(w.c.get(w.g.id)?.status).toBe('completed')
    expect(w.calls).toEqual([])
  })
  test('continue与blocked不触发验证', async () => {
    const w = fixture({ verify: async () => { throw new Error('不应调用') } })
    await prepare(w.run)
    await w.run.onCheckpoint({ outcome: 'blocked', summary: '卡住', completed: [], evidence: [], blocker: '缺依赖' })
    expect(w.c.get(w.g.id)?.status).toBe('blocked')
  })
  test('验证期间目标被修改，完成被拒绝', async () => {
    const w = fixture({ verify: async () => {
      w.store.save({ ...w.c.get(w.g.id)!, objective: '被改写的目标' })
      return decision(true)
    } })
    await prepare(w.run)
    await expect(w.run.onCheckpoint(complete)).rejects.toThrow('已变化')
    expect(w.c.get(w.g.id)?.status).toBe('active')
    expect(w.c.get(w.g.id)?.completionVerification).toBeUndefined()
  })
})

describe('Goal完成门禁：创建时校验', () => {
  test('拒绝相对路径、非法基线、空或非法受保护模式、非法验证配置', () => {
    const w = fixture({ withGate: false })
    const create = (g: Partial<GoalCompletionGate>) => w.c.create({ sessionId: `x${Math.random()}`, runtime: 'ai-sdk', objective: 'x', completionGate: { ...gate, ...g } as GoalCompletionGate })
    expect(() => create({ repoRoot: 'relative' })).toThrow('repoRoot')
    expect(() => create({ baselineCommitSha: 'HEAD' })).toThrow('baselineCommitSha')
    expect(() => create({ protectedPaths: [] })).toThrow('protectedPaths')
    expect(() => create({ protectedPaths: ['../escape'] })).toThrow('protectedPaths')
    expect(() => create({ verifier: { ...verifier, argv: [] } })).toThrow('argv')
  })
  test('绑定引用与存储不一致时创建失败；与存储一致时可创建', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-bind-'))
    dirs.push(dir)
    const store = new ProtectedVerifierStore({ dir: join(dir, 'verifiers'), protector: testProtector })
    const saved = store.save('fixture-bun', verifier)
    const w = fixture({ withGate: false, store })
    const ref = { verifierId: 'fixture-bun', revision: saved.record.revision, recordSha256: saved.recordSha256 }
    expect(() => w.c.create({ sessionId: 'b1', runtime: 'ai-sdk', objective: 'x', completionGate: { ...gate, verifierRef: { ...ref, recordSha256: 'f'.repeat(64) } } })).toThrow('不一致')
    expect(() => w.c.create({ sessionId: 'b2', runtime: 'ai-sdk', objective: 'x', completionGate: { ...gate, verifier: { ...verifier, minimumTests: 9 }, verifierRef: ref } })).toThrow('不一致')
    expect(w.c.create({ sessionId: 'b3', runtime: 'ai-sdk', objective: 'x', completionGate: { ...gate, verifierRef: ref } }).completionGate?.verifierRef).toEqual(ref)
  })
})

describe('Goal完成门禁：真实默认验证（临时git仓库，seatbelt）', () => {
  function repo(name: string): string {
    const r = mkdtempSync(join(tmpdir(), `gravitas-goal-${name}-`))
    dirs.push(r)
    mkdirSync(join(r, 'src'))
    const git = (args: string[]) => execFileSync('git', ['-C', r, '-c', 'user.name=f', '-c', 'user.email=f@x', ...args], { encoding: 'utf8' }).trim()
    git(['init', '-q'])
    writeFileSync(join(r, 'ok.test.ts'), 'import { test, expect } from "bun:test"\ntest("ok", () => expect(1).toBe(1))\n')
    writeFileSync(join(r, 'src/value.ts'), 'export const v = 1\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'base'])
    return r
  }
  function git(r: string, args: string[]): string {
    return execFileSync('git', ['-C', r, '-c', 'user.name=f', '-c', 'user.email=f@x', ...args], { encoding: 'utf8' }).trim()
  }
  function coordinatorFor(store?: ProtectedVerifierStore) {
    const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-default-'))
    dirs.push(dir); process.env.PROMA_TEST_CONFIG_DIR = dir
    return new GoalCoordinator(new ElectronGoalStore(), { verifierStore: store ?? new ProtectedVerifierStore({ dir: join(dir, 'verifiers'), protector: testProtector }) })
  }
  async function finishWithComplete(c: GoalCoordinator, sessionId: string, goalId: string, r: string) {
    const run = c.captureRun(sessionId)!
    await run.onPrepared({ runtime: 'ai-sdk', workspaceId: 'w', channelId: 'ch', requestedModelId: 'm', provider: 'openai', cwd: r })
    await run.onCheckpoint(complete)
    return c.get(goalId)!
  }

  test('未提交的破坏不影响通过；HEAD 已提交内容通过并记录回执', async () => {
    const r = repo('clean')
    const base = git(r, ['rev-parse', 'HEAD'])
    writeFileSync(join(r, 'ok.test.ts'), 'import { test, expect } from "bun:test"\ntest("bad", () => expect(1).toBe(2))\n')
    const c = coordinatorFor()
    const g = c.create({ sessionId: 'r1', runtime: 'ai-sdk', objective: '真实', workspaceId: 'w', channelId: 'ch', modelId: 'm', completionGate: { ...gate, repoRoot: r, baselineCommitSha: base } })
    const after = await finishWithComplete(c, 'r1', g.id, r)
    expect(after.status).toBe('completed')
    expect(after.completionVerification).toMatchObject({ verdict: 'passed', commitSha: base, isolation: 'seatbelt-macos' })
  })
  test('基线之后修改测试文件并提交：拒绝，并指出违规路径', async () => {
    const r = repo('weaken')
    const base = git(r, ['rev-parse', 'HEAD'])
    writeFileSync(join(r, 'ok.test.ts'), 'import { test, expect } from "bun:test"\ntest("weak", () => expect(1).toBe(1))\n')
    git(r, ['commit', '-q', '-am', 'weaken'])
    const c = coordinatorFor()
    const g = c.create({ sessionId: 'r2', runtime: 'ai-sdk', objective: '真实', workspaceId: 'w', channelId: 'ch', modelId: 'm', completionGate: { ...gate, repoRoot: r, baselineCommitSha: base } })
    const run = c.captureRun('r2')!
    await run.onPrepared({ runtime: 'ai-sdk', workspaceId: 'w', channelId: 'ch', requestedModelId: 'm', provider: 'openai', cwd: r })
    await expect(run.onCheckpoint(complete)).rejects.toThrow('protected:ok.test.ts')
    expect(c.get(g.id)?.status).toBe('active')
  })
  test('基线之后只改源码并提交：允许完成', async () => {
    const r = repo('src-only')
    const base = git(r, ['rev-parse', 'HEAD'])
    writeFileSync(join(r, 'src/value.ts'), 'export const v = 2\n')
    git(r, ['commit', '-q', '-am', 'src'])
    const c = coordinatorFor()
    const g = c.create({ sessionId: 'r3', runtime: 'ai-sdk', objective: '真实', workspaceId: 'w', channelId: 'ch', modelId: 'm', completionGate: { ...gate, repoRoot: r, baselineCommitSha: base } })
    const after = await finishWithComplete(c, 'r3', g.id, r)
    expect(after.status).toBe('completed')
  })
  test('签名配置被更新后，旧 Goal 拒绝完成（需重新创建 Goal）', async () => {
    const r = repo('rebind')
    const base = git(r, ['rev-parse', 'HEAD'])
    const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-rebind-'))
    dirs.push(dir)
    const store = new ProtectedVerifierStore({ dir: join(dir, 'verifiers'), protector: testProtector })
    const saved = store.save('fixture-bun', verifier)
    const c = coordinatorFor(store)
    const ref = { verifierId: 'fixture-bun', revision: saved.record.revision, recordSha256: saved.recordSha256 }
    const g = c.create({ sessionId: 'r4', runtime: 'ai-sdk', objective: '真实', workspaceId: 'w', channelId: 'ch', modelId: 'm', completionGate: { ...gate, repoRoot: r, baselineCommitSha: base, verifierRef: ref } })
    store.save('fixture-bun', { ...verifier, minimumTests: 5 })
    const run = c.captureRun('r4')!
    await run.onPrepared({ runtime: 'ai-sdk', workspaceId: 'w', channelId: 'ch', requestedModelId: 'm', provider: 'openai', cwd: r })
    await expect(run.onCheckpoint(complete)).rejects.toThrow('已更新，请重新创建 Goal')
    expect(c.get(g.id)?.status).toBe('active')
  })
})
