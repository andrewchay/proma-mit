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
function useFreshDataRoot(): void {
  const dataRoot = mkdtempSync(join(tmpdir(), 'pilot-native-wal-data-'))
  dataRoots.push(dataRoot)
  env = { ...process.env, PROMA_TEST_CONFIG_DIR: dataRoot,
    NODE_PATH: join(import.meta.dir, '../../../../../node_modules') }
}
useFreshDataRoot()
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
const source = join(import.meta.dir, 'project-pilot-native-crash-child.ts')
buildSync({ entryPoints: [source], outfile: childFile, bundle: true, platform: 'node', format: 'cjs',
  target: 'node24', external: ['better-sqlite3', 'electron'], absWorkingDir: process.cwd() })
afterAll(() => { for (const dir of dataRoots) rmSync(dir, { recursive: true, force: true }) })

interface Identity { projectId: string; grantId: string; executionId: string }
interface Snapshot {
  driver: string
  journalMode: { journal_mode: string }
  grantState: string
  decisions: number
  executionStatus: string
  commandState: string | null
  openEscalations: number
  requests: Array<{ executionId: string; state: string }>
}

function run(mode: 'setup' | 'inspect', identity?: Identity, runner: Runner = nodeRunner): Identity | Snapshot {
  const result = spawnSync(runner.bin, [childFile, mode, ...(identity
    ? [identity.projectId, identity.grantId, identity.executionId] : [])],
    { env: { ...env, ...runner.env }, encoding: 'utf8', timeout: timeoutMs })
  if (result.status !== 0) throw new Error(`原生夹具退出 ${result.status}: ${result.stdout}\n${result.stderr}`)
  const match = result.stdout.match(/^DATA (.+)$/m)
  if (!match) throw new Error(`原生夹具无结果：${result.stdout}\n${result.stderr}`)
  return JSON.parse(match[1]!)
}

async function killAt(mode: 'before' | 'after', identity: Identity, runner: Runner = nodeRunner): Promise<void> {
  const child = spawn(runner.bin, [childFile, mode,
    identity.projectId, identity.grantId, identity.executionId],
    { env: { ...env, ...runner.env }, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32' })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const expected = mode === 'before' ? 'READY_BEFORE_COMMIT' : 'READY_AFTER_COMMIT'
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
  const before = run('setup') as Identity
  await killAt('before', before)
  const beforeView = run('inspect', before) as Snapshot
  expect(beforeView).toMatchObject({ driver: 'NativeSqliteCompat', journalMode: { journal_mode: 'wal' },
    grantState: 'active', decisions: 0, executionStatus: 'running', commandState: 'running',
    openEscalations: 0, requests: [] })

  const after = run('setup') as Identity
  await killAt('after', after)
  const afterView = run('inspect', after) as Snapshot
  expect(afterView).toMatchObject({ driver: 'NativeSqliteCompat', journalMode: { journal_mode: 'wal' },
    grantState: 'paused', decisions: 1, executionStatus: 'running', commandState: 'running',
    openEscalations: 0, requests: [{ executionId: after.executionId, state: 'pending' }] })
}, 30_000)

test.skipIf(!electronUsable)('Electron 固定二进制（run-as-node）WAL：撤权事务提交前后强杀复验', async () => {
  useFreshDataRoot()
  const runner = electronRunner!
  const before = run('setup', undefined, runner) as Identity
  await killAt('before', before, runner)
  const beforeView = run('inspect', before, runner) as Snapshot
  expect(beforeView).toMatchObject({ driver: 'NativeSqliteCompat', journalMode: { journal_mode: 'wal' },
    grantState: 'active', decisions: 0, executionStatus: 'running', commandState: 'running',
    openEscalations: 0, requests: [] })

  const after = run('setup', undefined, runner) as Identity
  await killAt('after', after, runner)
  const afterView = run('inspect', after, runner) as Snapshot
  expect(afterView).toMatchObject({ driver: 'NativeSqliteCompat', journalMode: { journal_mode: 'wal' },
    grantState: 'paused', decisions: 1, executionStatus: 'running', commandState: 'running',
    openEscalations: 0, requests: [{ executionId: after.executionId, state: 'pending' }] })
}, 45_000)
