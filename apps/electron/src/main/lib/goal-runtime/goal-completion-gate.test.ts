import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PinnedVerifierConfig, PinnedVerifierReceipt } from '@gravitas/shared'
import { GoalCoordinator, type CompletionVerifier } from './goal-coordinator'
import { ElectronGoalStore } from './goal-store'
import { runPinnedBaselineVerifier } from '../pinned-baseline-verifier'

const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
const dirs: string[] = []
afterEach(() => {
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const verifier: PinnedVerifierConfig = {
  version: 1, verifierId: 'fixture-bun', argv: [process.execPath, 'test', '--reporter=junit', '--reporter-outfile={{JUNIT_REPORT}}'],
  expectedExitCodes: [0], timeoutMs: 60_000, minimumTests: 1,
}
const gate = { version: 1 as const, repoRoot: '/fixture/repo', verifier }
const complete = { outcome: 'complete' as const, summary: '完成', completed: [], evidence: [{ kind: 'test' as const, value: 'bun test' }] }

function receipt(verdict: 'passed' | 'failed', reasons: PinnedVerifierReceipt['reasons'] = []): PinnedVerifierReceipt {
  return {
    version: 1, verifierId: 'fixture-bun', commitSha: 'a'.repeat(40), argvSha256: 'b'.repeat(64), cleanCheckout: true,
    exitCode: verdict === 'passed' ? 0 : 1, timedOut: false, tests: 1, failures: verdict === 'passed' ? 0 : 1, errors: 0, skipped: 0,
    verdict, reasons, cleanedUp: true, startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
  }
}

function fixture(options: { verify?: CompletionVerifier; withGate?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-gate-'))
  dirs.push(dir); process.env.PROMA_TEST_CONFIG_DIR = dir
  const store = new ElectronGoalStore()
  const calls: Array<{ repoRoot: string }> = []
  const verify: CompletionVerifier = options.verify ?? (async () => receipt('passed'))
  const c = new GoalCoordinator(store, { verifyCompletion: async (g) => { calls.push({ repoRoot: g.repoRoot }); return verify(g) } })
  const g = c.create({
    sessionId: 's', runtime: 'ai-sdk', objective: '目标', workspaceId: 'w', channelId: 'ch', modelId: 'm',
    acceptanceCriteria: ['测试通过'], ...(options.withGate === false ? {} : { completionGate: gate }),
  })
  const run = c.captureRun('s')!
  return { c, store, g, run, calls }
}
async function prepare(run: { onPrepared(r: unknown): Promise<void> }): Promise<void> {
  await run.onPrepared({ runtime: 'ai-sdk', workspaceId: 'w', channelId: 'ch', requestedModelId: 'm', provider: 'openai', cwd: '/fixture' })
}

describe('Goal完成门禁：固定基线验证', () => {
  test('验证未通过时拒绝complete，Goal不完成，原因返回给模型', async () => {
    const w = fixture({ verify: async () => receipt('failed', ['exit_code_unexpected', 'test_failures']) })
    await prepare(w.run)
    await expect(w.run.onCheckpoint(complete)).rejects.toThrow('固定基线验证未通过')
    const after = w.c.get(w.g.id)!
    expect(after.status).toBe('active')
    expect(after.completionVerification).toBeUndefined()
    expect(after.checkpoint).toBeUndefined()
  })
  test('验证通过才完成，并持久化回执（commit、计数、来源）', async () => {
    const w = fixture()
    await prepare(w.run)
    await w.run.onCheckpoint(complete)
    const after = w.c.get(w.g.id)!
    expect(after.status).toBe('completed')
    expect(after.completionVerification).toMatchObject({ verdict: 'passed', commitSha: 'a'.repeat(40), cleanCheckout: true, tests: 1 })
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
  test('验证期间目标或门禁被修改，完成被拒绝', async () => {
    const w = fixture({ verify: async () => {
      w.store.save({ ...w.c.get(w.g.id)!, objective: '被改写的目标' })
      return receipt('passed')
    } })
    await prepare(w.run)
    await expect(w.run.onCheckpoint(complete)).rejects.toThrow('已变化')
    expect(w.c.get(w.g.id)?.status).toBe('active')
    expect(w.c.get(w.g.id)?.completionVerification).toBeUndefined()
  })
  test('创建时拒绝非法门禁（相对路径仓库、非法验证配置）', () => {
    const w = fixture({ withGate: false })
    expect(() => w.c.create({ sessionId: 's2', runtime: 'ai-sdk', objective: 'x', completionGate: { ...gate, repoRoot: 'relative' } })).toThrow('repoRoot')
    expect(() => w.c.create({ sessionId: 's3', runtime: 'ai-sdk', objective: 'x', completionGate: { ...gate, verifier: { ...verifier, argv: [] } } })).toThrow('argv')
  })
})

describe('Goal完成门禁：真实固定基线（临时git仓库）', () => {
  test('默认验证器使用HEAD已提交内容；未提交的破坏不影响通过', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gravitas-goal-repo-'))
    dirs.push(repo)
    const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
    git(['init', '-q'])
    writeFileSync(join(repo, 'ok.test.ts'), 'import { test, expect } from "bun:test"\ntest("ok", () => expect(1).toBe(1))\n')
    git(['add', '.'])
    execFileSync('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@x', 'commit', '-q', '-m', 'base'])
    writeFileSync(join(repo, 'ok.test.ts'), 'import { test, expect } from "bun:test"\ntest("bad", () => expect(1).toBe(2))\n')
    mkdirSync(join(repo, 'sub'))
    const dir = mkdtempSync(join(tmpdir(), 'gravitas-goal-default-'))
    dirs.push(dir); process.env.PROMA_TEST_CONFIG_DIR = dir
    const c = new GoalCoordinator(new ElectronGoalStore())
    const g = c.create({ sessionId: 'r', runtime: 'ai-sdk', objective: '真实', workspaceId: 'w', channelId: 'ch', modelId: 'm', completionGate: { ...gate, repoRoot: repo } })
    const run = c.captureRun('r')!
    await run.onPrepared({ runtime: 'ai-sdk', workspaceId: 'w', channelId: 'ch', requestedModelId: 'm', provider: 'openai', cwd: repo })
    await run.onCheckpoint(complete)
    const after = c.get(g.id)!
    expect(after.status).toBe('completed')
    expect(after.completionVerification?.commitSha).toBe(git(['rev-parse', 'HEAD']))
    expect(after.completionVerification?.verdict).toBe('passed')
    // 直接调用固定验证器，确认与门禁使用同一规则。
    const direct = await runPinnedBaselineVerifier({ repoRoot: repo, commitSha: git(['rev-parse', 'HEAD']), config: verifier })
    expect(direct.verdict).toBe('passed')
  })
})
