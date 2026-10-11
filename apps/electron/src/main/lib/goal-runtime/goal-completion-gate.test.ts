import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GoalCompletionGate, PinnedVerifierConfig, PinnedVerifierReceipt, ProtectedVerifierRef } from '@gravitas/shared'
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

// 仅测试用可逆变换；生产使用 safeStorage（另见运行时验证证据）。
const testProtector: KeyProtector = {
  encrypt: (plain) => Buffer.from(plain.map((b) => b ^ 0x5a)),
  decrypt: (cipher) => Buffer.from(cipher.map((b) => b ^ 0x5a)),
}
const BASE = 'a'.repeat(40)
const PATHS = ['**/*.test.ts']
const verifier: PinnedVerifierConfig = {
  version: 1, verifierId: 'fixture-bun', argv: [process.execPath, 'test', '--reporter=junit', '--reporter-outfile={{JUNIT_REPORT}}'],
  expectedExitCodes: [0], timeoutMs: 60_000, minimumTests: 1,
}
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
function savedStore(dir: string): { store: ProtectedVerifierStore; ref: ProtectedVerifierRef } {
  const store = new ProtectedVerifierStore({ dir: join(dir, 'verifiers'), protector: testProtector })
  const saved = store.save('fixture-bun', verifier, PATHS)
  return { store, ref: { verifierId: 'fixture-bun', revision: saved.record.revision, recordSha256: saved.recordSha256 } }
}
function gateFor(ref: ProtectedVerifierRef, extra: Partial<GoalCompletionGate> = {}): GoalCompletionGate {
  return { version: 1, repoRoot: '/fixture/repo', baselineCommitSha: BASE, verifierRef: ref, ...extra }
}

function fixture(options: { verify?: CompletionVerifier; withGate?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-gate-'))
  dirs.push(dir); process.env.PROMA_TEST_CONFIG_DIR = dir
  const { store: verifierStore, ref } = savedStore(dir)
  const store = new ElectronGoalStore()
  const calls: Array<{ repoRoot: string }> = []
  const verify: CompletionVerifier = options.verify ?? (async () => decision(true))
  const c = new GoalCoordinator(store, {
    verifyCompletion: async (g) => { calls.push({ repoRoot: g.repoRoot }); return verify(g) },
    verifierStore,
  })
  const g = c.create({
    sessionId: 's', runtime: 'ai-sdk', objective: '目标', workspaceId: 'w', channelId: 'ch', modelId: 'm',
    acceptanceCriteria: ['测试通过'], ...(options.withGate === false ? {} : { completionGate: gateFor(ref) }),
  })
  const run = c.captureRun('s')!
  return { c, store, g, run, calls, verifierStore }
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

describe('Goal完成门禁：统一维护与创建时校验', () => {
  test('门禁只能引用统一存储：相对路径、非法基线、未知或不一致引用均拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-validate-'))
    dirs.push(dir); process.env.PROMA_TEST_CONFIG_DIR = dir
    const { ref } = savedStore(dir)
    const c = new GoalCoordinator(new ElectronGoalStore(), { verifierStore: new ProtectedVerifierStore({ dir: join(dir, 'verifiers'), protector: testProtector }) })
    const create = (gate: GoalCompletionGate) => c.create({ sessionId: `x${Math.random()}`, runtime: 'ai-sdk', objective: 'x', completionGate: gate })
    expect(() => create(gateFor(ref, { repoRoot: 'relative' }))).toThrow('repoRoot')
    expect(() => create(gateFor(ref, { baselineCommitSha: 'HEAD' }))).toThrow('baselineCommitSha')
    expect(() => create(gateFor({ ...ref, verifierId: 'missing-verifier' }))).toThrow('不存在')
    expect(() => create(gateFor({ ...ref, recordSha256: 'f'.repeat(64) }))).toThrow('不一致')
  })
  test('门禁不内嵌配置或路径：创建结果只保留引用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-ref-'))
    dirs.push(dir); process.env.PROMA_TEST_CONFIG_DIR = dir
    const { ref, store } = savedStore(dir)
    const c = new GoalCoordinator(new ElectronGoalStore(), { verifierStore: store })
    const g = c.create({ sessionId: 'ref', runtime: 'ai-sdk', objective: 'x', completionGate: gateFor(ref) })
    expect(Object.keys(g.completionGate!).sort()).toEqual(['baselineCommitSha', 'repoRoot', 'verifierRef', 'version'])
  })
  test('统一存储更新受保护路径后，旧 Goal 拒绝完成（需重新创建 Goal）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-rebind-'))
    dirs.push(dir); process.env.PROMA_TEST_CONFIG_DIR = dir
    const { ref, store } = savedStore(dir)
    // 使用默认验证器：绑定校验发生在 HEAD 解析之前，失败原因即为修订变化。
    const c = new GoalCoordinator(new ElectronGoalStore(), { verifierStore: store })
    const g = c.create({ sessionId: 'upd', runtime: 'ai-sdk', objective: 'x', workspaceId: 'w', channelId: 'ch', modelId: 'm', completionGate: gateFor(ref) })
    store.save('fixture-bun', verifier, ['src/**'])
    const run = c.captureRun('upd')!
    await run.onPrepared({ runtime: 'ai-sdk', workspaceId: 'w', channelId: 'ch', requestedModelId: 'm', provider: 'openai', cwd: dir })
    await expect(run.onCheckpoint(complete)).rejects.toThrow('已更新，请重新创建 Goal')
    expect(c.get(g.id)?.status).toBe('active')
  })
})

describe('Goal完成门禁：真实默认验证（临时git仓库，seatbelt）', () => {
  function git(r: string, args: string[]): string {
    return execFileSync('git', ['-C', r, '-c', 'user.name=f', '-c', 'user.email=f@x', ...args], { encoding: 'utf8' }).trim()
  }
  function repo(name: string): string {
    const r = mkdtempSync(join(tmpdir(), `gravitas-goal-${name}-`))
    dirs.push(r)
    mkdirSync(join(r, 'src'))
    git(r, ['init', '-q'])
    writeFileSync(join(r, 'ok.test.ts'), 'import { test, expect } from "bun:test"\ntest("ok", () => expect(1).toBe(1))\n')
    writeFileSync(join(r, 'src/value.ts'), 'export const v = 1\n')
    git(r, ['add', '.'])
    git(r, ['commit', '-q', '-m', 'base'])
    return r
  }
  function setup(name: string) {
    const r = repo(name)
    const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-default-'))
    dirs.push(dir); process.env.PROMA_TEST_CONFIG_DIR = dir
    const { store, ref } = savedStore(dir)
    const c = new GoalCoordinator(new ElectronGoalStore(), { verifierStore: store })
    return { r, c, store, ref, base: git(r, ['rev-parse', 'HEAD']) }
  }
  async function finish(c: GoalCoordinator, sessionId: string, r: string) {
    const run = c.captureRun(sessionId)!
    await run.onPrepared({ runtime: 'ai-sdk', workspaceId: 'w', channelId: 'ch', requestedModelId: 'm', provider: 'openai', cwd: r })
    return run
  }

  test('未提交的破坏不影响通过；HEAD 已提交内容通过并记录回执', async () => {
    const s = setup('clean')
    writeFileSync(join(s.r, 'ok.test.ts'), 'import { test, expect } from "bun:test"\ntest("bad", () => expect(1).toBe(2))\n')
    const g = s.c.create({ sessionId: 'r1', runtime: 'ai-sdk', objective: '真实', workspaceId: 'w', channelId: 'ch', modelId: 'm', completionGate: { version: 1, repoRoot: s.r, baselineCommitSha: s.base, verifierRef: s.ref } })
    const run = await finish(s.c, 'r1', s.r)
    await run.onCheckpoint(complete)
    expect(s.c.get(g.id)?.completionVerification).toMatchObject({ verdict: 'passed', commitSha: s.base, isolation: 'seatbelt-macos' })
  })
  test('基线之后修改测试文件并提交：拒绝，并指出违规路径', async () => {
    const s = setup('weaken')
    writeFileSync(join(s.r, 'ok.test.ts'), 'import { test, expect } from "bun:test"\ntest("weak", () => expect(1).toBe(1))\n')
    git(s.r, ['commit', '-q', '-am', 'weaken'])
    const g = s.c.create({ sessionId: 'r2', runtime: 'ai-sdk', objective: '真实', workspaceId: 'w', channelId: 'ch', modelId: 'm', completionGate: { version: 1, repoRoot: s.r, baselineCommitSha: s.base, verifierRef: s.ref } })
    const run = await finish(s.c, 'r2', s.r)
    await expect(run.onCheckpoint(complete)).rejects.toThrow('protected:ok.test.ts')
    expect(s.c.get(g.id)?.status).toBe('active')
  })
  test('基线之后只改源码并提交：允许完成', async () => {
    const s = setup('src-only')
    writeFileSync(join(s.r, 'src/value.ts'), 'export const v = 2\n')
    git(s.r, ['commit', '-q', '-am', 'src'])
    const g = s.c.create({ sessionId: 'r3', runtime: 'ai-sdk', objective: '真实', workspaceId: 'w', channelId: 'ch', modelId: 'm', completionGate: { version: 1, repoRoot: s.r, baselineCommitSha: s.base, verifierRef: s.ref } })
    const run = await finish(s.c, 'r3', s.r)
    await run.onCheckpoint(complete)
    expect(s.c.get(g.id)?.status).toBe('completed')
  })
})

describe('回执权威关联（B02：goalId/runId 绑定）', () => {
  test('持久化回执绑定 goalId 与 runId，跨 Goal 移植可检测', async () => {
    const w = fixture()
    await prepare(w.run)
    await w.run.onCheckpoint(complete)
    const receipt = w.c.get(w.g.id)!.completionVerification!
    expect(receipt.boundGoalId).toBe(w.g.id)
    // runId 不在运行句柄上外露；完成后的 checkpointRunId 即本次 run 身份。
    expect(receipt.boundRunId).toBe(w.c.get(w.g.id)!.checkpointRunId)
    expect(receipt.boundRunId).toBeTruthy()
    // 移植检测：绑定字段与任一身份不符即不可视为本 Goal 的回执。
    expect(receipt.boundGoalId).not.toBe('other-goal')
  })
})
