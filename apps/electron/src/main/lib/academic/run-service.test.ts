import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunExecutionRequest, RunExecutionResult, RunExecutor } from './run-executor'

/**
 * 运行服务测试（M4）：
 * - 输入清单冻结（digest）与状态流转
 * - 超时/失败/取消语义；失败原因不泄露原始错误正文
 * - 手工观察仅用于非计算运行
 * - 产物：本地文件算 sha256=verified，外部引用=unverified，越界拒绝
 * - 真实执行器：跑一个极小 fixture 脚本（无 shell、输出上限）
 */

let tempDir: string
const originalEnv = { ...process.env }

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'run-service-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

async function loadAll() {
  return {
    run: await import(`./run-service?t=${Math.random()}`),
    project: await import(`./research-service?t=${Math.random()}`),
    executor: await import(`./run-executor?t=${Math.random()}`),
  }
}

/** 假执行器：记录收到的请求，返回预设结果 */
function fakeExecutor(result: Partial<RunExecutionResult>): { executor: RunExecutor; calls: RunExecutionRequest[] } {
  const calls: RunExecutionRequest[] = []
  return {
    calls,
    executor: {
      async execute(request) {
        calls.push(request)
        return { status: 'completed', outputTruncated: false, logBytes: 0, ...result }
      },
    },
  }
}

async function setupProject() {
  const { run, project } = await loadAll()
  const p = await project.createResearchProject({
    title: '运行测试项目', domain: 'statistics', methodPath: 'quantitative',
  })
  const workdir = join(tempDir, 'academic', 'research', p.id, 'workdir')
  mkdirSync(workdir, { recursive: true })
  return { run, projectId: p.id, workdir }
}

describe('运行创建与状态流转', () => {
  test('计算运行：冻结输入摘要 + 状态完成', async () => {
    const { run: svc, projectId, workdir } = await setupProject()
    const fake = fakeExecutor({ status: 'completed', exitCode: 0, logBytes: 12 })

    const created = await svc.createAndExecuteRun(
      projectId,
      { kind: 'compute', title: '模拟实验', input: { interpreter: 'python3', scriptPath: 'sim.py', args: ['--n', '10'] }, budget: { timeoutMs: 1000 } },
      { executor: fake.executor, resolveProjectRoot: () => workdir },
    )

    expect(created.status).toBe('completed')
    expect(created.input.digest).toMatch(/^m4-/)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.input.scriptPath).toBe('sim.py')
  })

  test('失败运行保留归一化原因（不含原始错误正文）', async () => {
    const { run: svc, projectId, workdir } = await setupProject()
    const fake = fakeExecutor({
      status: 'failed',
      exitCode: 2,
      statusReason: '进程以退出码 2 结束，详见运行日志',
    })
    const created = await svc.createAndExecuteRun(
      projectId,
      { kind: 'compute', title: '失败实验', input: { interpreter: 'node', scriptPath: 'a.js' } },
      { executor: fake.executor, resolveProjectRoot: () => workdir },
    )
    expect(created.status).toBe('failed')
    expect(created.exitCode).toBe(2)
    expect(created.statusReason).not.toContain('Traceback')
  })

  test('超时运行状态为 timed-out', async () => {
    const { run: svc, projectId, workdir } = await setupProject()
    const fake = fakeExecutor({ status: 'timed-out', statusReason: '超过预算超时 1000 ms，进程已被终止' })
    const created = await svc.createAndExecuteRun(
      projectId,
      { kind: 'compute', title: '超时实验', input: { interpreter: 'python3', scriptPath: 'slow.py' }, budget: { timeoutMs: 1000 } },
      { executor: fake.executor, resolveProjectRoot: () => workdir },
    )
    expect(created.status).toBe('timed-out')
    expect(created.finishedAt).toBeTruthy()
  })

  test('执行器抛错 → 运行标记 failed 而非崩溃', async () => {
    const { run: svc, projectId, workdir } = await setupProject()
    const failing: RunExecutor = { async execute() { throw new Error('spawn EACCES') } }
    const created = await svc.createAndExecuteRun(
      projectId,
      { kind: 'compute', title: '异常实验', input: { interpreter: 'bun', scriptPath: 'x.ts' } },
      { executor: failing, resolveProjectRoot: () => workdir },
    )
    expect(created.status).toBe('failed')
    expect(created.statusReason).toContain('执行器错误')
  })
})

describe('手工观察与产物', () => {
  test('手工观察用于非计算运行；计算运行拒绝', async () => {
    const { run: svc, projectId, workdir } = await setupProject()

    const manual = await svc.createAndExecuteRun(
      projectId,
      { kind: 'manual-observation', title: '访谈记录', input: {} },
      { resolveProjectRoot: () => workdir },
    )
    const obs = await svc.recordObservation(projectId, { runId: manual.id, text: '受访者提到设备噪声' })
    expect(obs.recordedBy.id).toBe('local-user')
    expect(await svc.listObservations(projectId)).toHaveLength(1)

    const fake = fakeExecutor({})
    const compute = await svc.createAndExecuteRun(
      projectId,
      { kind: 'compute', title: '计算', input: { interpreter: 'python3', scriptPath: 'a.py' } },
      { executor: fake.executor, resolveProjectRoot: () => workdir },
    )
    await expect(
      svc.recordObservation(projectId, { runId: compute.id, text: 'x' }),
    ).rejects.toThrow('计算运行的输出在日志中')
  })

  test('本地产物算 sha256=verified；外部引用=unverified', async () => {
    const { run: svc, projectId, workdir } = await setupProject()
    writeFileSync(join(workdir, 'results.csv'), 'a,b\n1,2\n', 'utf8')

    const manual = await svc.createAndExecuteRun(
      projectId,
      { kind: 'tool-validation', title: '本体验证', input: {} },
      { resolveProjectRoot: () => workdir },
    )

    const local = await svc.recordArtifact(
      projectId,
      { runId: manual.id, ref: 'results.csv' },
      { resolveProjectRoot: () => workdir },
    )
    expect(local.integrity).toBe('verified')
    expect(local.digest).toHaveLength(64)

    const external = await svc.recordArtifact(
      projectId,
      { runId: manual.id, ref: 'doi:10.1234/xyz' },
      { resolveProjectRoot: () => workdir },
    )
    expect(external.integrity).toBe('unverified')
    expect(external.digest).toBeUndefined()
  })

  test('产物越界或不存在时拒绝', async () => {
    const { run: svc, projectId, workdir } = await setupProject()
    const manual = await svc.createAndExecuteRun(
      projectId,
      { kind: 'tool-validation', title: 'T', input: {} },
      { resolveProjectRoot: () => workdir },
    )

    await expect(
      svc.recordArtifact(projectId, { runId: manual.id, ref: '../../etc/passwd' }, { resolveProjectRoot: () => workdir }),
    ).rejects.toThrow('超出项目目录')

    await expect(
      svc.recordArtifact(projectId, { runId: manual.id, ref: 'missing.csv' }, { resolveProjectRoot: () => workdir }),
    ).rejects.toThrow('不存在')
  })

  test('取消已结束运行被拒绝', async () => {
    const { run: svc, projectId, workdir } = await setupProject()
    const fake = fakeExecutor({ status: 'completed', exitCode: 0 })
    const done = await svc.createAndExecuteRun(
      projectId,
      { kind: 'compute', title: '已完成', input: { interpreter: 'node', scriptPath: 'a.js' } },
      { executor: fake.executor, resolveProjectRoot: () => workdir },
    )
    await expect(svc.cancelRun(projectId, done.id)).rejects.toThrow('无法取消')
  })
})

describe('真实本地执行器（无 shell）', () => {
  test('脚本运行并落日志；参数数组不经过 shell', async () => {
    const { run: svc, projectId, workdir } = await setupProject()
    const { LocalRunExecutor } = await loadAll().then((m) => m.executor)

    writeFileSync(
      join(workdir, 'echo.js'),
      'console.log("ARGS:" + process.argv.slice(2).join(",")); process.exit(0)\n',
      'utf8',
    )

    const run = await svc.createAndExecuteRun(
      projectId,
      {
        kind: 'compute',
        title: '真实执行',
        // 含 shell 元字符的参数：不经过 shell，因此应原样传入而不是被解释
        input: { interpreter: 'node', scriptPath: 'echo.js', args: ['; echo pwned', '&& rm -rf /'] },
        budget: { timeoutMs: 15000 },
      },
      { executor: new LocalRunExecutor(), resolveProjectRoot: () => workdir },
    )

    expect(run.status).toBe('completed')
    expect(run.exitCode).toBe(0)

    const { readFileSync } = await import('node:fs')
    const log = readFileSync(join(tempDir, 'academic', 'research', projectId, 'run-logs', `${run.id}.log`), 'utf8')
    expect(log).toContain('ARGS:; echo pwned,&& rm -rf /')
    expect(log).not.toContain('pwned\n')
  })
})

describe('中断恢复与日志读取（M4.2）', () => {
  test('重启后残留的 queued/running 被显式标记为中断，且幂等', async () => {
    const { run: svc, projectId } = await setupProject()
    const { appendEvent } = await import(`./research-store?t=${Math.random()}`)

    // 直接构造一条「卡在 running」的运行（模拟应用重启前的中断）
    const staleId = 'stale-run-1'
    await appendEvent(projectId, {
      commandId: 'stale-1',
      payload: {
        type: 'run_recorded',
        run: {
          id: staleId, projectId, kind: 'compute', status: 'runtime-placeholder' as never,
          title: '中断的运行', input: { interpreter: 'python3', scriptPath: 'x.py' },
          budget: { timeoutMs: 1000, maxOutputBytes: 1024 }, createdAt: new Date().toISOString(),
        },
      },
    })
    await appendEvent(projectId, {
      commandId: 'stale-2',
      payload: { type: 'run_status_changed', runId: staleId, status: 'running' },
    })

    const first = await svc.reconcileInterruptedRuns(projectId)
    expect(first.reconciled).toContain(staleId)

    const runs = (await svc.listRuns(projectId)) as Array<{ id: string; status: string; statusReason?: string }>
    const stale = runs.find((r) => r.id === staleId)!
    expect(stale.status).toBe('failed')
    expect(stale.statusReason).toContain('运行中断')

    // 幂等：再次调和不再改写
    const second = await svc.reconcileInterruptedRuns(projectId)
    expect(second.reconciled).not.toContain(staleId)
  })

  test('终止态运行不被调和改写', async () => {
    const { run: svc, projectId, workdir } = await setupProject()
    const fake = fakeExecutor({ status: 'completed', exitCode: 0 })
    const done = await svc.createAndExecuteRun(
      projectId,
      { kind: 'compute', title: '完成', input: { interpreter: 'node', scriptPath: 'a.js' } },
      { executor: fake.executor, resolveProjectRoot: () => workdir },
    )
    const result = await svc.reconcileInterruptedRuns(projectId)
    expect(result.reconciled).not.toContain(done.id)
    const allRuns = (await svc.listRuns(projectId)) as Array<{ id: string; status: string }>
    expect(allRuns.find((r) => r.id === done.id)?.status).toBe('completed')
  })

  test('日志读取：不存在时明确返回；超上限只给尾部并标记截断', async () => {
    const { run: svc, projectId, workdir } = await setupProject()
    const manual = await svc.createAndExecuteRun(
      projectId,
      { kind: 'tool-validation', title: 'T', input: {} },
      { resolveProjectRoot: () => workdir },
    )

    const missing = await svc.readRunLog(projectId, manual.id)
    expect(missing.exists).toBe(false)
    expect(missing.content).toBe('')

    // 写入超过上限的日志
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const logDir = join(tempDir, 'academic', 'research', projectId, 'run-logs')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(join(logDir, `${manual.id}.log`), 'x'.repeat(3000) + 'TAIL', 'utf8')

    const limited = await svc.readRunLog(projectId, manual.id, { maxBytes: 10 })
    expect(limited.truncated).toBe(true)
    expect(limited.content.endsWith('TAIL')).toBe(true)
    expect(limited.totalBytes).toBe(3004)
  })
})

describe('外部运行导入与 DVC 指针（M6.2）', () => {
  test('导入外部运行：幂等、保留 externalRef、未知状态保守归一化', async () => {
    const { run: svc, projectId } = await setupProject()

    const first = (await svc.importExternalRuns(projectId, {
      tool: 'openresearch',
      toolProjectId: 'orx-p-1',
      runs: [
        { id: 'orx-r-1', status: 'done', exitCode: 0, commitSha: 'abc123', endedAt: 1789000000 },
        { id: 'orx-r-2', status: 'totally-new-status' },
      ],
    })) as { imported: Array<{ status: string; statusReason?: string; input: { interpreter?: string }; externalRef?: { toolRunId: string; commitSha?: string } }>; skipped: number }

    expect(first.imported).toHaveLength(2)
    const done = first.imported.find((r) => r.externalRef?.toolRunId === 'orx-r-1')!
    expect(done.status).toBe('completed')
    expect(done.externalRef?.commitSha).toBe('abc123')
    expect(done.statusReason).toContain('本插件未执行')
    // 外部运行的输入清单不得编造
    expect(done.input.interpreter).toBeUndefined()

    const unknown = first.imported.find((r) => r.externalRef?.toolRunId === 'orx-r-2')!
    expect(unknown.status).toBe('failed')
    expect(unknown.statusReason).toContain('未识别')

    // 幂等：重复导入被跳过
    const second = (await svc.importExternalRuns(projectId, {
      tool: 'openresearch',
      toolProjectId: 'orx-p-1',
      runs: [{ id: 'orx-r-1', status: 'done' }],
    })) as { imported: unknown[]; skipped: number }
    expect(second.imported).toHaveLength(0)
    expect(second.skipped).toBe(1)
  })

  test('导入外部运行缺参数或空列表拒绝', async () => {
    const { run: svc, projectId } = await setupProject()
    await expect(
      svc.importExternalRuns(projectId, { tool: '', toolProjectId: 'x', runs: [{ id: 'a' }] }),
    ).rejects.toThrow('需要 tool 与 toolProjectId')
    await expect(
      svc.importExternalRuns(projectId, { tool: 'openresearch', toolProjectId: 'x', runs: [] }),
    ).rejects.toThrow('没有可导入的外部运行')
  })

  test('DVC 指针登记为 unverified 引用，并从提示中说明需 pull', async () => {
    const { run: svc, projectId, workdir } = await setupProject()
    const manual = await svc.createAndExecuteRun(
      projectId,
      { kind: 'tool-validation', title: 'DVC 登记', input: {} },
      { resolveProjectRoot: () => workdir },
    )

    const artifact = await svc.registerDvcPointer(projectId, {
      runId: manual.id,
      pointerPath: 'data/results.csv.dvc',
      pointerContent: 'outs:\n- md5: deadbeef1234\n  size: 2048\n  path: results.csv\n',
    })

    expect(artifact.ref).toBe('dvc:deadbeef1234')
    // 关键：指针不等于数据实体，必须标 unverified
    expect(artifact.integrity).toBe('unverified')
    expect(artifact.digest).toBeUndefined()
    expect(artifact.note).toContain('dvc pull')
    expect(artifact.note).toContain('results.csv')
  })

  test('DVC 指针非法内容拒绝，且不落库', async () => {
    const { run: svc, projectId, workdir } = await setupProject()
    const manual = await svc.createAndExecuteRun(
      projectId,
      { kind: 'tool-validation', title: 'DVC 失败', input: {} },
      { resolveProjectRoot: () => workdir },
    )
    await expect(
      svc.registerDvcPointer(projectId, {
        runId: manual.id,
        pointerPath: 'not-a-pointer.yaml',
        pointerContent: 'outs: []',
      }),
    ).rejects.toThrow('.dvc')

    expect(await svc.listArtifacts(projectId)).toHaveLength(0)
  })
})
