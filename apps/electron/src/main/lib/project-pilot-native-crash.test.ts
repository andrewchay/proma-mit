import { afterAll, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'

const stageRoot = mkdtempSync(join(tmpdir(), 'pilot-native-wal-stage-'))
const childFile = join(stageRoot, 'native-crash-child.cjs')
const dataRoots: string[] = []
// 每个用例独立数据根：SIGKILL 残留锁/存活树不得跨用例互相污染。
let env: Record<string, string | undefined>
function useFreshDataRoot(): string {
  const dataRoot = mkdtempSync(join(tmpdir(), 'pilot-native-wal-data-'))
  dataRoots.push(dataRoot)
  env = { ...process.env, PROMA_TEST_CONFIG_DIR: dataRoot,
    NODE_PATH: join(import.meta.dir, '../../../../../node_modules') }
  return dataRoot
}
useFreshDataRoot()
afterAll(() => { for (const dir of [stageRoot, ...dataRoots]) rmSync(dir, { recursive: true, force: true }) })

const timeoutMs = 20_000
const nodeBinary = process.env.PROMA_NATIVE_NODE_BINARY ?? (process.platform === 'win32'
  ? 'node' : execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim())
const electronBinary = join(import.meta.dir, '../../../../../node_modules/.bin/electron')
const nativeModuleDir = join(import.meta.dir, '../../../../../node_modules/better-sqlite3')
// 同步探测：Electron 固定二进制（run-as-node）能否加载生产 better-sqlite3 原生模块（Electron ABI）。
const electronProbe = existsSync(electronBinary)
  ? spawnSync(electronBinary, ['-e',
    `const D=require(${JSON.stringify(nativeModuleDir)});const d=new D(':memory:');d.exec('CREATE TABLE t(a)');`
    + `console.log('ELECTRON_NATIVE_OK',process.versions.modules,process.versions.electron)`],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000 })
  : null
const electronUsable = electronProbe?.status === 0 && (electronProbe.stdout ?? '').includes('ELECTRON_NATIVE_OK')
if (existsSync(electronBinary) && !electronUsable) {
  console.warn(`[pilot-native-crash] Electron 二进制无法加载生产 better-sqlite3，固定构建矩阵跳过：`
    + `${electronProbe?.stderr?.slice(0, 400)}`)
}

interface Runner { bin: string; env: Record<string, string> }
const nodeRunner: Runner = { bin: nodeBinary, env: {} }
const electronRunner: Runner | null = electronUsable
  ? { bin: electronBinary, env: { ELECTRON_RUN_AS_NODE: '1' } }
  : null
const matrixRunners = (): Runner[] => (electronRunner ? [nodeRunner, electronRunner] : [nodeRunner])

const source = join(import.meta.dir, 'project-pilot-native-crash-child.ts')
buildSync({ entryPoints: [source], outfile: childFile, bundle: true, platform: 'node', format: 'cjs',
  target: 'node24', absWorkingDir: process.cwd(),
  // 生产依赖在运行时由 NODE_PATH 解析；playwright/fsevents 等重依赖不参与打包。
  external: ['better-sqlite3', 'electron', 'playwright-core', 'playwright', 'fsevents', 'chromium-bidi'] })

interface Identity {
  projectId: string
  grantId: string
  executionId: string
  commandId: string
  taskId: string
  sourceVersion: number
  sourceHash: string
  idempotencyKey: string
  prompt: string
  employeeId: string
  summary?: string
  version?: number
  workspaceId?: string
  channelId?: string
  executorEmployeeId?: string
  repoPath?: string
}

interface Snapshot {
  driver: string
  journalMode: { journal_mode: string }
  grantState: string | null
  decisions: number
  executionStatus: string | null
  commandState: string | null
  openEscalations: number
  taskStatus: string | null
  taskVersion: number | null
  resolutionCount: number
  approvalActivityCount: number
  commandCount: number
  executionCount: number
  runReservations: number
  requests: Array<{ executionId: string; state: string }>
}

interface RetryResult { ok: boolean; message?: string; commandState?: string; executionStatus?: string }

function run(mode: string, identity?: Identity, runner: Runner = nodeRunner):
  Identity | Snapshot | RetryResult {
  const result = spawnSync(runner.bin, [childFile, mode, ...(identity
    ? [JSON.stringify(identity)] : [])],
    { env: { ...env, ...runner.env }, encoding: 'utf8', timeout: timeoutMs })
  if (result.status !== 0) throw new Error(`原生夹具退出 ${result.status}: ${result.stdout}\n${result.stderr}`)
  const match = result.stdout.match(/^DATA (.+)$/m)
  if (!match) throw new Error(`原生夹具无结果：${result.stdout}\n${result.stderr}`)
  return JSON.parse(match[1]!)
}

async function killAt(mode: string, identity: Identity, runner: Runner = nodeRunner): Promise<void> {
  const child = spawn(runner.bin, [childFile, mode, JSON.stringify(identity)],
    { env: { ...env, ...runner.env }, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32' })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const expected = mode === 'approval-after-commit-before-event' ? 'READY_AFTER_COMMIT_BEFORE_EVENT'
    : mode.endsWith('before') ? 'READY_BEFORE_COMMIT' : 'READY_AFTER_COMMIT'
  const finished = new Promise<{ signal: NodeJS.Signals | null; code: number | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待原生事务超时：${stdout}\n${stderr}`)), timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.includes(expected)) { clearTimeout(timer); resolve() }
      })
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`夹具提前退出：${stdout}\n${stderr}`)) })
    })
  } finally {
    // 进程组强杀：防止 shim→真实运行时树中任何存活进程继续持有 WAL 锁。
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch { child.kill('SIGKILL') }
  }
  expect((await finished).signal).toBe('SIGKILL')
}

test.skipIf(process.platform === 'win32')('原生 SQLite WAL：撤权事务提交前后强杀，重开验证回滚与待对账记录', async () => {
  useFreshDataRoot()
  const before = run('setup') as Identity
  await killAt('before', before)
  const beforeView = run('inspect', before) as Snapshot
  expect(beforeView).toMatchObject({ driver: 'NativeSqliteCompat', journalMode: { journal_mode: 'wal' },
    grantState: 'active', decisions: 0, executionStatus: 'running', commandState: 'running',
    commandCount: 1, executionCount: 1, runReservations: 1, openEscalations: 0, requests: [] })

  const after = run('setup') as Identity
  await killAt('after', after)
  const afterView = run('inspect', after) as Snapshot
  expect(afterView).toMatchObject({ driver: 'NativeSqliteCompat', journalMode: { journal_mode: 'wal' },
    grantState: 'paused', decisions: 1, executionStatus: 'running', commandState: 'running',
    commandCount: 1, executionCount: 1, runReservations: 1, openEscalations: 0,
    requests: [{ executionId: after.executionId, state: 'pending' }] })
}, 30_000)

test.skipIf(!electronUsable)('Electron 固定二进制（run-as-node）WAL：撤权事务提交前后强杀复验', async () => {
  useFreshDataRoot()
  const runner = electronRunner!
  const before = run('setup', undefined, runner) as Identity
  await killAt('before', before, runner)
  const beforeView = run('inspect', before, runner) as Snapshot
  expect(beforeView).toMatchObject({ driver: 'NativeSqliteCompat', journalMode: { journal_mode: 'wal' },
    grantState: 'active', decisions: 0, executionStatus: 'running', commandState: 'running',
    commandCount: 1, executionCount: 1, runReservations: 1, openEscalations: 0, requests: [] })

  const after = run('setup', undefined, runner) as Identity
  await killAt('after', after, runner)
  const afterView = run('inspect', after, runner) as Snapshot
  expect(afterView).toMatchObject({ driver: 'NativeSqliteCompat', journalMode: { journal_mode: 'wal' },
    grantState: 'paused', decisions: 1, executionStatus: 'running', commandState: 'running',
    commandCount: 1, executionCount: 1, runReservations: 1, openEscalations: 0,
    requests: [{ executionId: after.executionId, state: 'pending' }] })
}, 45_000)

test('派发事务提交前后强杀：无半成品、遗留锁 fail-closed、核查后重试幂等（Node/Electron 运行器）', async () => {
  for (const runner of matrixRunners()) {
    const dataRoot = useFreshDataRoot()
    const identity = run('setup-dispatch', undefined, runner) as Identity
    await killAt('dispatch-before', identity, runner)
    expect(run('inspect', identity, runner) as Snapshot).toMatchObject({
      grantState: 'active', commandCount: 0, executionCount: 0, runReservations: 0 })
    // 生产 fail-closed：强杀中断派发会在配置目录遗留策略锁，写入被拒绝直到人工核查。
    const lockedRetry = run('dispatch-retry', identity, runner) as RetryResult
    expect(lockedRetry.ok).toBe(false)
    expect(lockedRetry.message).toContain('遗留锁未核查')
    // 模拟人工核查后移除遗留锁目录，重试必须幂等成功且只生成一个命令与执行。
    rmSync(join(dataRoot, 'project-pilot-policies.json.lock'), { recursive: true, force: true })
    expect(run('dispatch-retry', identity, runner)).toMatchObject({ ok: true, commandState: 'queued' })
    expect(run('inspect', identity, runner) as Snapshot).toMatchObject({
      grantState: 'active', commandCount: 1, executionCount: 1, runReservations: 1, commandState: 'queued' })

    const after = run('setup-dispatch', undefined, runner) as Identity
    await killAt('dispatch-after', after, runner)
    expect(run('inspect', after, runner) as Snapshot).toMatchObject({
      grantState: 'active', commandCount: 1, executionCount: 1, runReservations: 1,
      commandState: 'queued', executionStatus: 'queued' })
    // 幂等重派：同 idempotencyKey 不产生第二个命令或执行，预算预留不变。
    expect(run('dispatch-retry', after, runner)).toMatchObject({ ok: true, commandState: 'queued' })
    expect(run('inspect', after, runner) as Snapshot).toMatchObject({
      commandCount: 1, executionCount: 1, runReservations: 1 })
  }
}, 120_000)

test('审批已提交但事件及活动记录未执行时强杀：重开只认持久凭据，不重放旧版（Node/Electron）', async () => {
  for (const runner of matrixRunners()) {
    useFreshDataRoot()
    const identity = run('setup-approval', undefined, runner) as Identity
    await killAt('approval-after-commit-before-event', identity, runner)
    expect(run('inspect', identity, runner) as Snapshot).toMatchObject({
      driver: 'NativeSqliteCompat', journalMode: { journal_mode: 'wal' },
      taskStatus: 'pending', resolutionCount: 1, approvalActivityCount: 0,
      commandState: 'settled', runReservations: 1 })
    const dup = run('approval-dup', identity, runner) as RetryResult
    expect(dup.ok).toBe(false)
    expect(dup.message).toContain('没有待答复')
    expect(run('inspect', identity, runner) as Snapshot).toMatchObject({
      taskStatus: 'pending', resolutionCount: 1, approvalActivityCount: 0 })
    expect(run('reconcile-approved', identity, runner)).toMatchObject({ ready: 1, commandCount: 1 })
  }
}, 120_000)

test('同一原生 WAL 强杀库：正式绑定预检后重启受控续派一次（Node/Electron）', async () => {
  for (const runner of matrixRunners()) {
    useFreshDataRoot()
    const identity = run('setup-approval-bound', undefined, runner) as Identity
    await killAt('approval-after-commit-before-event', identity, runner)
    expect(run('inspect', identity, runner) as Snapshot).toMatchObject({
      taskStatus: 'pending', resolutionCount: 1, approvalActivityCount: 0,
      commandState: 'settled', commandCount: 1, executionCount: 1 })
    const resumed = run('resume-approved-bound', identity, runner) as unknown as {
      readiness: boolean; grantStatus: string; boundWorkspace: boolean; commandCount: number; queuedCount: number;
      starts: number; queuedExecutionId: string; queuedExecution: Record<string, unknown>;
      approvalActivityCount: number
    }
    expect(resumed).toMatchObject({ readiness: true, grantStatus: 'active', boundWorkspace: true, commandCount: 2,
      queuedCount: 1, starts: 1, approvalActivityCount: 0 })
    expect(resumed.queuedExecutionId).not.toBe(identity.executionId)
    expect(resumed.queuedExecution).toMatchObject({ projectId: identity.projectId, entityId: identity.taskId,
      agentId: identity.executorEmployeeId, status: 'queued' })
    // 另一份同样强杀后的独立库：验证真正的后台启动入口而非仅手动调用扫描函数。
    useFreshDataRoot()
    const background = run('setup-approval-bound', undefined, runner) as Identity
    await killAt('approval-after-commit-before-event', background, runner)
    expect(run('start-approved-bound-background', background, runner))
      .toMatchObject({ queuedCount: 1, starts: 1, commandCount: 2 })
    useFreshDataRoot()
    const blocked = run('setup-approval-bound', undefined, runner) as Identity
    await killAt('approval-after-commit-before-event', blocked, runner)
    expect(run('invalidate-bound-channel', blocked, runner)).toMatchObject({ disabled: true })
    // 生产预检拒绝停用渠道；resume 进程以非零退出，账本不产生第二条命令。
    expect(() => run('resume-approved-bound', blocked, runner)).toThrow('重启绑定或授权未就绪')
    expect(run('inspect', blocked, runner) as Snapshot).toMatchObject({ commandCount: 1,
      taskStatus: 'pending', resolutionCount: 1 })
  }
}, 120_000)

test('审批事务提交前后强杀：无假批准、凭据恰一、旧版本重复批准拒绝（Node/Electron 运行器）', async () => {
  for (const runner of matrixRunners()) {
    useFreshDataRoot()
    const identity = run('setup-approval', undefined, runner) as Identity
    await killAt('approval-before', identity, runner)
    expect(run('inspect', identity, runner) as Snapshot).toMatchObject({
      taskStatus: 'paused', taskVersion: identity.version, resolutionCount: 0, commandState: 'settled' })
    expect(run('approval-retry', identity, runner)).toMatchObject({ ok: true })
    expect(run('inspect', identity, runner) as Snapshot).toMatchObject({
      taskStatus: 'pending', resolutionCount: 1 })

    const after = run('setup-approval', undefined, runner) as Identity
    await killAt('approval-after', after, runner)
    expect(run('inspect', after, runner) as Snapshot).toMatchObject({
      taskStatus: 'pending', resolutionCount: 1, commandState: 'settled' })
    // 旧版本重复批准必须拒绝，且不产生第二条凭据。
    const dup = run('approval-dup', after, runner) as RetryResult
    expect(dup.ok).toBe(false)
    expect(dup.message).toContain('没有待答复')
    expect(run('inspect', after, runner) as Snapshot).toMatchObject({
      taskStatus: 'pending', resolutionCount: 1 })
  }
}, 120_000)
