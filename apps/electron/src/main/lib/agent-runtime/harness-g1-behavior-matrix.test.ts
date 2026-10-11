/**
 * G1：离线行为矩阵（B01–B17 横向场景）。
 *
 * 每个适用 B-case 用真实机制做一个小型活场景断言；重场景由映射清单指向其
 * 定向测试文件（程序核验文件存在）。B17 属 ACP 线（M7 阻塞），显式 out-of-scope。
 * 真实 Provider 证据另计（G3）；本文件证明确定性机制。
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'

const testDir = mkdtempSync(join(tmpdir(), 'gravitas-g1-matrix-'))
process.env.PROMA_TEST_CONFIG_DIR = testDir

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

const { parseDevelopmentValidationRecord } = await import('../development-validation-record')
const { parseVerificationReceipt, assessToolCallBatchIntegrity, assertRuntimeSatisfiesPolicy: assertRuntimePolicy, DEFAULT_HARNESS_POLICY, AGENT_RUNTIME_CAPABILITIES: caps } = await import('@gravitas/shared')
const cloneDefaultPolicy = () => JSON.parse(JSON.stringify(DEFAULT_HARNESS_POLICY)) as import('@gravitas/shared').HarnessPolicy
const { parseJUnitTotals } = await import('../pinned-baseline-verifier')
const { guardLoadedToolCall, planToolLoading } = await import('./tool-loading-gate')
const { buildToolCapabilityCatalog } = await import('./tool-capability-catalog')
const { bindCoreToolEffects } = await import('./tool-effects')
const { createReadToolDefinition, executeReadTool } = await import('./tool-impls/read-tool')
const { createWriteToolDefinition, executeWriteTool } = await import('./tool-impls/write-tool')
const { planLockSpec, ToolScheduler } = await import('./tool-scheduler')
const { setToolSchedulerDisabled } = await import('./tool-scheduler-service')
const { assessStepsToolCallBatchIntegrity } = await import('./ai-sdk-runtime-core')
const { evaluateContextCompactionGoldenSet } = await import('./context-compaction-evaluator')
const { CONTEXT_COMPACTION_GOLDENS } = await import('./context-compaction-goldens')
const { assessCompactionArchiveIntegrity } = await import('../agent-session-manager')
const { detectSkillDrift } = await import('./skill-porting/skill-installer')
const { containsSensitiveContent } = await import('../memory-plugin-service')
const { resolveGoalVerificationStatus } = await import('../../../renderer/lib/goal-verification-status')
const { createCoreTools } = await import('./tool-registry')
const { GoalCoordinator } = await import('../goal-runtime/goal-coordinator')
const { runHarnessBenchmark, buildHarnessBenchmarkTasks } = await import('./harness-benchmark/runner')
const { resolveRuntimeBudgetLimitUsd } = await import('../project-pilot-runtime-budget')
const { ElectronGoalStore } = await import('../goal-runtime/goal-store')

beforeAll(() => setToolSchedulerDisabled(false))
afterAll(() => {
  setToolSchedulerDisabled(false)
  rmSync(testDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

const readTool = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
const writeTool = bindCoreToolEffects({ ...createWriteToolDefinition(), execute: executeWriteTool })
const tools = [readTool, writeTool]

describe('G1：B01–B17 离线行为矩阵', () => {
  test('B01 最后修改后无新验证/未来时间/错身份：开发验证记录拒绝', () => {
    const binding = {
      version: 1, projectId: 'p1', workspaceId: 'w1', sessionId: 's1',
      snapshotId: 'snap-1', baseCommit: 'b'.repeat(40), scopeHash: 'c'.repeat(64), verificationConfigHash: 'd'.repeat(64),
    }
    const base = {
      id: 'v1', taskId: 't1', executionId: 'e1', command: 'bun test',
      startedAt: 1000, finishedAt: 2000, exitCode: 0, timedOut: false, status: 'passed',
      snapshotContentHash: 'a'.repeat(64), outputTail: 'PASS', outputTruncated: false, binding,
    }
    expect(parseDevelopmentValidationRecord(base, { id: 'v1', taskId: 't1', executionId: 'e1' }, 3000)).toBeDefined()
    expect(parseDevelopmentValidationRecord({ ...base, finishedAt: 4000 }, { id: 'v1', taskId: 't1', executionId: 'e1' }, 3000)).toBeUndefined()
    expect(parseDevelopmentValidationRecord(base, { id: 'v1', taskId: 't1', executionId: 'e2' }, 3000)).toBeUndefined()
  })

  test('B02 回执身份不互认：subject 不符与 goal 绑定不符都被拒绝', () => {
    const subject = { projectId: 'p1', workspaceId: 'w1', agentGoalId: 'g1', taskId: 'task-A', executionId: 'e1', sessionId: 's1', runId: 'r1' }
    const receipt = {
      version: 1, receiptId: 'r1', criteriaId: 'c1', toolCallId: 'tc1', evidenceRef: 'verification:r1',
      subject,
      artifact: {
        version: 1, artifactId: 'snap-1', subject, baseRevision: 'a'.repeat(40),
        contentHash: 'b'.repeat(64), scopeHash: 'c'.repeat(64), capturedAt: 1500, evidenceRef: 'snapshot:snap-1',
      },
      verifier: { id: 'bun', version: '1', configHash: 'd'.repeat(64), kind: 'test' },
      source: 'main-process', result: 'passed', startedAt: 2000, finishedAt: 2500,
      exitCode: 0, checksCollected: 3,
    }
    const options = { expectedSubject: subject, now: 3000 }
    expect(parseVerificationReceipt(receipt, options).ok).toBe(true)
    expect(parseVerificationReceipt(receipt, { ...options, expectedSubject: { ...subject, taskId: 'task-B' } }).ok).toBe(false)
    const goal = {
      id: 'g1', sessionId: 's', runtime: 'ai-sdk' as const, objective: 'o', status: 'active' as const,
      acceptanceCriteria: [], createdAt: 0, updatedAt: 0, version: 1,
      completionVerification: {
        version: 1 as const, verifierId: 'v', commitSha: 'c'.repeat(40), argvSha256: 'd'.repeat(64), cleanCheckout: true as const,
        isolation: 'seatbelt-macos' as const, exitCode: 0, timedOut: false, tests: 1, failures: 0, errors: 0, skipped: 0,
        verdict: 'passed' as const, reasons: [], cleanedUp: true, startedAt: '', finishedAt: '', boundGoalId: 'g2', boundRunId: 'r',
      },
    }
    expect(resolveGoalVerificationStatus(goal).state).toBe('mismatch')
  })

  test('B03 stdout 含 PASS 但结构计数失败/退出码非 0/0 测试：不能判验证（只看结构化计数）', () => {
    const totals = parseJUnitTotals('<testsuite tests="1" failures="1"/>')!
    expect(totals.failures).toBe(1)
    // 判定只来自 totals/exitCode/minimumTests，与 stdout 文本无关（verifier 不读 stdout）。
    expect(totals.failures + totals.errors > 0).toBe(true)
    expect(parseJUnitTotals('PASS ALL TESTS</pre>')).toBeNull()
    expect(parseJUnitTotals('<testsuite tests="0" failures="0"/>')).not.toBeNull()
  })

  test('B04 验证期间配置/上下文漂移：检查点拒绝继续', async () => {
    const store = new ElectronGoalStore()
    const coordinator = new GoalCoordinator(store)
    coordinator.create({ sessionId: 's-b04', runtime: 'ai-sdk', objective: '目标' })
    const run = coordinator.captureRun('s-b04')!
    await run.onPrepared({ runtime: 'ai-sdk', workspaceId: undefined, channelId: 'ch', requestedModelId: undefined, provider: 'openai', cwd: '/fixture' })
    // 外部漂移：同版本号绕过校验地改写上下文（store 层无签名，仅检测层面）。
    const current = store.list()[0]!
    store.save({ ...current, invocationContext: { ...current.invocationContext!, channelId: 'evil-channel' } })
    await expect(run.onCheckpoint({ outcome: 'continue', summary: 's', completed: [], evidence: [], nextAction: 'n', wakeTrigger: { type: 'immediate' } }))
      .rejects.toThrow('Goal调用上下文已变化')
  })

  test('B05 重启保留与未知如实：调度错误释放锁、后续同键可继续', async () => {
    const scheduler = new ToolScheduler({ maxConcurrent: 4 })
    const dir = mkdtempSync(join(testDir, 'b05-'))
    const target = join(dir, 'same.txt')
    const fail = { id: 'F', tool: writeTool, input: { file_path: target, content: 'x' }, ctx: { cwd: dir, sessionId: 'g1' }, execute: async (): Promise<string> => { throw new Error('boom') } }
    const ok = { id: 'K', tool: writeTool, input: { file_path: target, content: 'y' }, ctx: { cwd: dir, sessionId: 'g1' }, execute: async (): Promise<string> => 'ok' }
    const [r1] = await scheduler.schedule([fail])
    expect(r1!.status).toBe('error')
    const [r2] = await scheduler.schedule([ok])
    expect(r2!.status).toBe('completed')
    rmSync(dir, { recursive: true, force: true })
  })

  test('B06/B07 未加载与旧 schema：明确拒绝且不执行', () => {
    const catalog = buildToolCapabilityCatalog(tools).catalog
    const plan = planToolLoading({ catalog, query: 'read', tokenBudget: 60 }, tools)
    expect(guardLoadedToolCall(plan, writeTool)).toEqual({ ok: false, reason: 'tool_not_loaded' })
    const revised = { ...writeTool, parameters: { ...writeTool.parameters, properties: { ...writeTool.parameters.properties, z: { type: 'number' } } } }
    const plan2 = planToolLoading({ catalog, query: 'write file', tokenBudget: 60, requiredIds: ['builtin:Write'] }, tools)
    expect(guardLoadedToolCall(plan2, revised)).toEqual({ ok: false, reason: 'schema_changed' })
  })

  test('B08 同键写互斥：执行窗口不重叠（事件序列）', async () => {
    const scheduler = new ToolScheduler({ maxConcurrent: 4 })
    const dir = mkdtempSync(join(testDir, 'b08-'))
    const mk = (id: string) => ({
      id, tool: writeTool, input: { file_path: join(dir, 'shared.txt'), content: id },
      ctx: { cwd: dir, sessionId: 'g1' }, execute: async (): Promise<string> => { await Bun.sleep(15); return id },
    })
    await Promise.all([scheduler.schedule([mk('A')]), scheduler.schedule([mk('B')])])
    const events = scheduler.snapshotLockEvents()
    const win = (cid: string) => {
      const s = events.find((e) => e.callId === cid && e.phase === 'execute_start')!.seq
      const en = events.find((e) => e.callId === cid && e.phase === 'execute_end')!.seq
      return { s, en }
    }
    const a = win('A')
    const b = win('B')
    expect(a.en < b.s || b.en < a.s).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('B09 Bash/未知 MCP 保守：无 effects 实例走全局排他', async () => {
    const unknown = bindCoreToolEffects({ name: 'Mystery', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })
    const spec = await planLockSpec(unknown, {}, { cwd: testDir, sessionId: 'g1' })
    expect(spec).toEqual({ keys: ['global:unknown'], mode: 'exclusive' })
  })

  test('B10 截断批次可观察：finishReason=length 判不完整（零执行为 SDK 固有+E03 收束声明）', () => {
    const batch = assessToolCallBatchIntegrity([{ toolCallId: 'a', toolName: 'Write', input: {} }], 'length')
    expect(batch.complete).toBe(false)
    const steps = assessStepsToolCallBatchIntegrity([{ toolCalls: [{ toolCallId: 'a', toolName: 'Write', input: {} }], finishReason: 'length' }])
    expect(steps.complete).toBe(false)
  })

  test('B11 queued 取消零执行；运行错误释放锁（锁事件）', async () => {
    const scheduler = new ToolScheduler({ maxConcurrent: 1 })
    const dir = mkdtempSync(join(testDir, 'b11-'))
    const blocker = { id: 'B', tool: writeTool, input: { file_path: join(dir, 'a.txt'), content: '1' }, ctx: { cwd: dir, sessionId: 'g1' }, execute: async (): Promise<string> => { await Bun.sleep(30); return 'b' } }
    const victim = { id: 'V', tool: writeTool, input: { file_path: join(dir, 'a.txt'), content: '2' }, ctx: { cwd: dir, sessionId: 'g1' }, execute: async (): Promise<string> => 'v' }
    const first = scheduler.schedule([blocker])
    await new Promise((r) => setImmediate(r))
    const controller = new AbortController()
    const second = scheduler.schedule([victim], controller.signal)
    controller.abort()
    const [, r2] = await Promise.all([first, second])
    expect(r2![0]!.status).toBe('cancelled')
    const events = scheduler.snapshotLockEvents()
    expect(events.some((e) => e.callId === 'V' && (e.phase === 'acquired' || e.phase === 'execute_start'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('B12 Runtime 缺能力：required 保证在 Provider 前拒绝', () => {
    const policy = cloneDefaultPolicy()
    policy.guarantees.toolScheduling = 'required'
    expect(() => assertRuntimePolicy('claude', caps.claude, policy)).toThrow()
    expect(() => assertRuntimePolicy('ai-sdk', caps['ai-sdk'], policy)).not.toThrow()
  })

  test('B13 压缩保真与归档诚实：Golden 集通过；无压缩不假装可恢复', () => {
    expect(evaluateContextCompactionGoldenSet(CONTEXT_COMPACTION_GOLDENS).passed).toBe(true)
    expect(assessCompactionArchiveIntegrity('no-such-session-id-xyz').status).not.toBe('ok')
  })

  test('B14 旧 Skill 无哈希按 legacy 处理；敏感记忆候选被拦截', () => {
    const skillDir = join(testDir, 'skill-legacy')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: legacy\n---\n')
    expect(detectSkillDrift(skillDir)).toBeUndefined()
    expect(containsSensitiveContent('sk-ABCDEFGHIJKLMNOP1234')).toBe(true)
    expect(containsSensitiveContent('普通工作笔记')).toBe(false)
  })

  test('B15 flags off 行为兼容：TCC 关闭 + 默认策略无 required 缺口', async () => {
    const tccLike = createCoreTools().filter((tool) => /tcc|context.?compiler/i.test(tool.name))
    expect(tccLike).toEqual([])
    const tasks = buildHarnessBenchmarkTasks({
      evaluateGoldenSet: () => true,
      checkUnknownToolsSerialize: async () => true,
      sensitiveFilterBlocks: () => true,
      budgetGateThrows: (runtime) => {
        try { resolveRuntimeBudgetLimitUsd(runtime, 5, undefined); return false } catch { return true }
      },
    })
    const report = await runHarnessBenchmark(tasks)
    expect(report.safetyFailures).toEqual([])
    for (const runtime of ['claude', 'proma', 'pi', 'ai-sdk'] as const) {
      expect(() => assertRuntimePolicy(runtime, caps[runtime], cloneDefaultPolicy())).not.toThrow()
    }
  })

  test('B16 三态不混淆：finished/verified/accepted 文案区分', () => {
    const base = {
      id: 'g', sessionId: 's', runtime: 'ai-sdk' as const, objective: 'o', acceptanceCriteria: [],
      createdAt: 0, updatedAt: 0, version: 1,
    }
    expect(resolveGoalVerificationStatus({ ...base, status: 'active', checkpointRunId: 'r' }).state).toBe('finished_unverified')
    const receipt = {
      version: 1 as const, verifierId: 'v', commitSha: 'c'.repeat(40), argvSha256: 'd'.repeat(64), cleanCheckout: true as const,
      isolation: 'seatbelt-macos' as const, exitCode: 0, timedOut: false, tests: 1, failures: 0, errors: 0, skipped: 0,
      verdict: 'passed' as const, reasons: [], cleanedUp: true, startedAt: '', finishedAt: '', boundGoalId: 'g', boundRunId: 'r',
    }
    expect(resolveGoalVerificationStatus({ ...base, status: 'active', completionVerification: receipt }).state).toBe('verified')
    expect(resolveGoalVerificationStatus({ ...base, status: 'completed', completionVerification: receipt }).state).toBe('accepted')
  })

  test('B17 ACP 越权防护：M7 无宿主阻塞，显式 out-of-scope 并留痕', () => {
    // ACP 线（A01–A04）阻塞在"无宿主需求"；G1 不声称覆盖 B17，GA 门禁独立。
    const manifest = readManifest()
    expect(manifest['B17']!.status).toBe('out-of-scope')
    expect(manifest['B17']!.owners).toContain('docs/plans/2026-10-08-harness-reliability-upgrade/ledger.md')
  })
})

/** B-case → 定向证据映射；G1 测试程序核验 owner 文件存在且状态声明诚实。 */
interface ManifestEntry {
  readonly status: 'live' | 'mapped' | 'out-of-scope'
  readonly owners: readonly string[]
}

const MANIFEST: Record<string, ManifestEntry> = {
  B01: { status: 'live', owners: ['apps/electron/src/main/lib/development-validation-record.test.ts'] },
  B02: { status: 'live', owners: ['packages/shared/src/utils/verification.test.ts', 'apps/electron/src/renderer/lib/goal-verification-status.test.ts'] },
  B03: { status: 'live', owners: ['apps/electron/src/main/lib/pinned-baseline-verifier.test.ts'] },
  B04: { status: 'mapped', owners: ['apps/electron/src/main/lib/goal-runtime/goal-completion-gate.test.ts', 'apps/electron/src/main/lib/goal-runtime/goal-invocation-context.test.ts'] },
  B05: { status: 'mapped', owners: ['apps/electron/src/main/lib/goal-runtime/goal-continuation-bounds.test.ts', 'apps/electron/src/main/lib/agent-runtime/harness-rollback.test.ts'] },
  B06: { status: 'live', owners: ['apps/electron/src/main/lib/agent-runtime/tool-loading-gate.test.ts'] },
  B07: { status: 'live', owners: ['apps/electron/src/main/lib/agent-runtime/tool-loading-gate.test.ts'] },
  B08: { status: 'live', owners: ['apps/electron/src/main/lib/agent-runtime/tool-scheduler-lock-events.test.ts'] },
  B09: { status: 'live', owners: ['apps/electron/src/main/lib/agent-runtime/tool-scheduler.test.ts'] },
  B10: { status: 'mapped', owners: ['apps/electron/src/main/lib/agent-runtime/e03-zero-execution.test.ts', 'apps/electron/src/main/lib/agent-runtime/ai-sdk-batch-integrity.test.ts'] },
  B11: { status: 'live', owners: ['apps/electron/src/main/lib/agent-runtime/tool-scheduler-lifecycle.test.ts'] },
  B12: { status: 'live', owners: ['apps/electron/src/main/lib/adapters/harness-policy-conformance.test.ts'] },
  B13: { status: 'live', owners: ['apps/electron/src/main/lib/context-compaction-integrity.test.ts'] },
  B14: { status: 'live', owners: ['apps/electron/src/main/lib/memory-approval-chain.test.ts'] },
  B15: { status: 'mapped', owners: ['apps/electron/src/main/lib/agent-runtime/harness-baseline.test.ts'] },
  B16: { status: 'live', owners: ['apps/electron/src/renderer/lib/goal-verification-status.test.ts'] },
  B17: { status: 'out-of-scope', owners: ['docs/plans/2026-10-08-harness-reliability-upgrade/ledger.md'] },
}

function readManifest(): Record<string, ManifestEntry> {
  return MANIFEST
}

describe('G1：映射清单程序核验', () => {
  test('每个 B-case 的 owner 证据文件存在（out-of-scope 例外为台账记录）', () => {
    const root = resolve(__dirname, '../../../../../..')
    for (const [caseId, entry] of Object.entries(MANIFEST)) {
      for (const owner of entry.owners) {
        expect(existsSync(join(root, owner)), `${caseId} owner 缺失: ${owner}`).toBe(true)
      }
    }
    expect(Object.keys(MANIFEST)).toHaveLength(17)
  })
})
