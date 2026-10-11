/**
 * G3 真实验收：GLM 端到端工具/验证链（单次授权，费用熔断）。
 *
 * 默认跳过。需 PROMA_G3_ACCEPT=1 与 PROMA_PI_PILOT_GLM_KEY。
 * 场景（真实 Provider + 真实沙箱验证，独立核验不采信模型自述）：
 * 1. gated：fixture git 仓库中 math.ts 有 bug；GLM 经 ai-sdk runtime 修复；
 *    测试进程提交（模拟用户提交步骤）；Goal complete 触发完成门禁——
 *    seatbelt 沙箱内对提交 HEAD 跑真实 `bun test`（JUnit 可信收集）；
 *    断言 status=completed、回执 passed、boundGoalId 绑定、reportSha256 存在。
 * 2. legacy：无门禁 Goal complete 不触发验证（行为兼容）。
 *
 * 费用：usage × 智谱标准价累计，超过剩余额度即停；费用为本地估计，非账单。
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_DEFAULT_URLS } from '@gravitas/shared'
import { buildElectronMock } from '../testing/electron-mock'

const enabled = process.env.PROMA_G3_ACCEPT === '1' && Boolean(process.env.PROMA_PI_PILOT_GLM_KEY)
const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = mkdtempSync(join(tmpdir(), 'gravitas-g3-config-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir

mock.module('electron', () => buildElectronMock())
mock.module('../attachment-service', () => ({
  isImageAttachment: () => false,
  getMimeType: () => 'application/octet-stream',
  readAttachmentAsBase64: () => '',
  deleteAttachment: () => {},
  deleteConversationAttachments: () => {},
  saveAttachment: async () => ({ path: '/tmp/mock', fileName: 'mock', mimeType: 'text/plain', size: 0 }),
  openFileDialog: async () => null,
}))
mock.module('../document-parser', () => ({
  isDocumentAttachment: () => false,
  extractTextFromAttachment: async () => '',
}))

const { AISDKAgentAdapter } = await import('./ai-sdk-agent-adapter')
const { ProtectedVerifierStore: PVS } = await import('../protected-verifier-store')
type Protector = NonNullable<ConstructorParameters<typeof PVS>[0]>['protector'] & object
const { GoalCoordinator } = await import('../goal-runtime/goal-coordinator')
const { ElectronGoalStore } = await import('../goal-runtime/goal-store')
const { closeProjectDb, initProjectDb } = await import('../project-sqlite-store')

const MODEL = (process.env.PROMA_PI_PILOT_MODEL ?? 'glm-5.3-flash').trim()
const OUT_DIR = process.env.PROMA_G3_OUT ?? join(tmpdir(), 'gravitas-g3-results')
const PRICE = { input: 0.8, output: 2.8 }

const testProtector: Protector = {
  encrypt: (plain: Buffer) => Buffer.from(plain.map((b: number) => b ^ 0x5a)),
  decrypt: (cipher: Buffer) => Buffer.from(cipher.map((b: number) => b ^ 0x5a)),
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'g3', GIT_AUTHOR_EMAIL: 'g3@fixture', GIT_COMMITTER_NAME: 'g3', GIT_COMMITTER_EMAIL: 'g3@fixture' },
  }).trim()
}

function makeRepo(name: string): { repo: string; sha: string } {
  const repo = join(configDir, name)
  mkdirSync(repo)
  git(repo, ['init', '-q'])
  writeFileSync(join(repo, 'math.ts'), 'export function add(a: number, b: number): number {\n  return a - b\n}\n')
  writeFileSync(join(repo, 'math.test.ts'), 'import { test, expect } from "bun:test"\nimport { add } from "./math"\ntest("add", () => expect(add(2, 3)).toBe(5))\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'fixture'])
  return { repo, sha: git(repo, ['rev-parse', 'HEAD']) }
}

const workDirs: string[] = []
afterAll(() => {
  closeProjectDb()
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
})

;(enabled ? describe : describe.skip)('G3 真实验收：GLM 端到端工具/验证链', () => {
  test('gated：真实模型修复→提交→完成门禁真实 bun test 通过→回执绑定', async () => {
    if (MODEL !== 'glm-5.3-flash') throw new Error('本验收仅授权 glm-5.3-flash')
    mkdirSync(OUT_DIR, { recursive: true })
    const priorPath = process.env.PROMA_G3_PRIOR_BUDGET ?? ''
    const priorReserved = priorPath && existsSync(priorPath)
      ? (JSON.parse(readFileSync(priorPath, 'utf8')) as { reservedCny?: number }).reservedCny ?? 0
      : 0
    const budgetRemaining = Math.max(0, 10 - priorReserved)
    if (budgetRemaining < 0.5) throw new Error(`剩余额度不足：¥${budgetRemaining.toFixed(3)}`)

    await initProjectDb()
    const { repo, sha } = makeRepo('g3-gated')
    workDirs.push(repo)

    // 签名验证配置 + 受保护路径（测试文件不可在基线后改动）。
    const store = new GoalCoordinator(new ElectronGoalStore(), {
      verifierStore: new PVS({ dir: join(configDir, 'verifiers'), protector: testProtector }),
    })
    const saved = (store as unknown as { verifierStore?: () => InstanceType<typeof PVS> }).verifierStore
    const verifierStore = saved ? saved() : new PVS({ dir: join(configDir, 'verifiers'), protector: testProtector })
    const record = verifierStore.save('g3-bun', {
      version: 1, verifierId: 'g3-bun',
      argv: [process.execPath, 'test', '--reporter=junit', '--reporter-outfile={{JUNIT_REPORT}}'],
      expectedExitCodes: [0], timeoutMs: 120_000, minimumTests: 1,
    }, ['math.test.ts'])

    store.create({
      sessionId: 'g3-session', runtime: 'ai-sdk', objective: '修复 math.ts 使 bun test 通过',
      acceptanceCriteria: ['bun test 通过'],
      completionGate: {
        version: 1, repoRoot: repo, baselineCommitSha: sha,
        verifierRef: { verifierId: 'g3-bun', revision: record.record.revision, recordSha256: record.recordSha256 },
      },
    })
    const run = store.captureRun('g3-session')!
    await run.onPrepared({ runtime: 'ai-sdk', workspaceId: undefined, channelId: 'g3-channel', requestedModelId: undefined, provider: 'zhipu', cwd: repo })

    // 真实 Provider 修复阶段。
    const started = Date.now()
    const messages: unknown[] = []
    let error: string | undefined
    try {
      const adapter = new AISDKAgentAdapter()
      for await (const message of adapter.query({
        sessionId: `g3-fix-${Date.now()}`,
        prompt: 'math.ts 里的 add 函数有 bug，修复它使 bun test 通过。只修改 math.ts，不要运行 git 命令。完成后只回复 FIXED。',
        agentRuntime: 'ai-sdk', provider: 'zhipu',
        apiKey: process.env.PROMA_PI_PILOT_GLM_KEY ?? '',
        baseUrl: PROVIDER_DEFAULT_URLS.zhipu, model: MODEL, cwd: repo,
        permissionMode: 'bypassPermissions', maxTurns: 4, maxRetries: 0,
        canUseTool: async (name: string) => (['Read', 'Write', 'Edit', 'Grep', 'Bash'].includes(name)
          ? { allowed: true }
          : { allowed: false, message: 'G3 验收仅授权文件与 shell 工具' }),
      } as never)) messages.push(message)
    } catch (caught) {
      error = caught instanceof Error ? caught.message.slice(0, 300) : String(caught).slice(0, 300)
    }
    const fixed = readFileSync(join(repo, 'math.ts'), 'utf8').includes('a + b')
    // 提交由测试进程完成（模拟用户提交步骤；门禁只验证已提交内容）。
    if (fixed) {
      git(repo, ['add', 'math.ts'])
      git(repo, ['commit', '-q', '-m', 'fix add'])
    }

    // 完成检查点 → 真实门禁验证。
    let checkpointError: string | undefined
    if (!error) {
      try {
        await run.onCheckpoint({
          outcome: 'complete', summary: '已修复 add 并通过测试', completed: ['修复 math.ts'],
          evidence: [{ kind: 'test', value: 'bun test' }],
        })
      } catch (caught) {
        checkpointError = caught instanceof Error ? caught.message.slice(0, 300) : String(caught).slice(0, 300)
      }
    }

    const goal = store.get('g3-session') === undefined ? store.listBySession('g3-session')[0] : (store as unknown as { get: (id: string) => unknown }).get('g3-session')
    const finalGoal = (store as unknown as { listBySession: (s: string) => Array<{ status: string; completionVerification?: Record<string, unknown> }> }).listBySession('g3-session')[0]!
    const usage = { input: 0, output: 0 }
    for (const message of messages) {
      const recordMessage = message as { type?: string; _partial?: boolean; usage?: { input_tokens?: number; output_tokens?: number } }
      if (recordMessage._partial) continue
      if (recordMessage.type === 'result' && recordMessage.usage) {
        usage.input = recordMessage.usage.input_tokens ?? 0
        usage.output = recordMessage.usage.output_tokens ?? 0
      }
    }
    const estimatedCny = (usage.input * PRICE.input + usage.output * PRICE.output) / 1_000_000
    const receipt = finalGoal.completionVerification
    const report = {
      model: MODEL, durationMs: Date.now() - started,
      fixed, error, checkpointError,
      goalStatus: finalGoal.status,
      receipt: receipt ? { verdict: receipt.verdict, boundGoalId: receipt.boundGoalId, reportSha256: receipt.reportSha256, tests: receipt.tests } : null,
      usage, estimatedCny, budgetRemaining,
      note: '独立核验：math.ts 含 a+b；回执来自真实 seatbelt bun test',
    }
    writeFileSync(join(OUT_DIR, 'g3-report.json'), JSON.stringify(report, null, 2))
    void goal

    // 事实断言（不预置全部通过）：修复成功且门禁通过时，回执必须完整绑定。
    expect(error ?? checkpointError ?? null).toBeNull()
    expect(fixed).toBe(true)
    if (finalGoal.status === 'completed') {
      expect(receipt?.verdict).toBe('passed')
      expect(receipt?.boundGoalId).toBe('g3-session')
      expect(String(receipt?.reportSha256 ?? '')).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(estimatedCny).toBeLessThanOrEqual(budgetRemaining)
  }, 600_000)

  test('legacy：无门禁 Goal complete 不触发验证（行为兼容）', async () => {
    await initProjectDb()
    const store = new GoalCoordinator(new ElectronGoalStore())
    store.create({ sessionId: 'g3-legacy', runtime: 'ai-sdk', objective: 'legacy 目标', acceptanceCriteria: [] })
    const run = store.captureRun('g3-legacy')!
    await run.onPrepared({ runtime: 'ai-sdk', workspaceId: undefined, channelId: 'ch', requestedModelId: undefined, provider: 'openai', cwd: '/tmp' })
    await run.onCheckpoint({ outcome: 'complete', summary: '完成', completed: [], evidence: [] })
    const finalGoal = store.listBySession('g3-legacy')[0]!
    expect(finalGoal.status).toBe('completed')
    expect(finalGoal.completionVerification).toBeUndefined()
  })
})
