import { afterAll, expect, test } from 'bun:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'

const stageRoot = mkdtempSync(join(tmpdir(), 'owner-native-recovery-stage-'))
const childFile = join(stageRoot, 'owner-native-recovery-child.cjs')
const dataRoots: string[] = []
const nodeBinary = process.env.PROMA_NATIVE_NODE_BINARY ?? execFileSync(
  'node', ['-p', 'process.execPath'], { encoding: 'utf8' },
).trim()
const env = { ...process.env, NODE_PATH: join(import.meta.dir, '../../../../../node_modules') }
const electronBinary = join(import.meta.dir, '../../../../../node_modules/.bin/electron')
const nativeModuleDir = join(import.meta.dir, '../../../../../node_modules/better-sqlite3')
const electronProbe = spawnSync(electronBinary, ['-e',
  `const D=require(${JSON.stringify(nativeModuleDir)});new D(':memory:').close();console.log('OWNER_ELECTRON_NATIVE_OK')`],
{ env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000 })
const runners = [{ bin: nodeBinary, env: {} }, ...(electronProbe.status === 0 ? [{ bin: electronBinary, env: { ELECTRON_RUN_AS_NODE: '1' } }] : [])]
buildSync({ entryPoints: [join(import.meta.dir, 'project-owner-native-recovery-child.ts')], outfile: childFile,
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', absWorkingDir: process.cwd(),
  external: ['better-sqlite3', 'electron'] })
afterAll(() => { rmSync(stageRoot, { recursive: true, force: true }); for (const root of dataRoots) rmSync(root, { recursive: true, force: true }) })

async function killAt(runner: typeof runners[number], runnerEnv: NodeJS.ProcessEnv, mode: string, marker: string): Promise<string> {
  const child = spawn(runner.bin, [childFile, mode], { env: { ...runnerEnv, ...runner.env },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const exited = new Promise<NodeJS.Signals | null>(resolve => child.once('exit', (_code, signal) => resolve(signal)))
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`等待原生恢复窗口超时：${stdout}\n${stderr}`)), 30_000)
    child.stdout.on('data', () => {
      if (stdout.includes(marker)) { clearTimeout(timeout); resolve() }
    })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`夹具退出${code}：${stdout}\n${stderr}`)) })
  })
  try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
  expect(await exited).toBe('SIGKILL')
  return stdout
}

function inspect(runner: typeof runners[number], runnerEnv: NodeJS.ProcessEnv) {
  const result = spawnSync(runner.bin, [childFile, 'inspect'], { env: { ...runnerEnv, ...runner.env },
    encoding: 'utf8', timeout: 30_000 })
  expect(result.status).toBe(0)
  const line = result.stdout.split('\n').find(item => item.startsWith('OWNER_INSPECT '))
  expect(line).toBeDefined()
  return JSON.parse(line!.slice('OWNER_INSPECT '.length)) as {
    journalMode: { journal_mode: string }
    rows: Array<{ status: string; decided_at: number | null; decision_reason: string | null; execution_status: string;
      grant_state: string; command_state: string; actual_cost_micros: number | null; reserved_cost_micros: number }>
  }
}

test.skipIf(process.platform === 'win32')('Owner待审批动作在原生SQLite WAL进程强杀后由独立进程失效并保留未知费用', async () => {
  for (const runner of runners) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'owner-native-recovery-data-'))
    dataRoots.push(dataRoot)
    const runnerEnv = { ...env, PROMA_TEST_CONFIG_DIR: dataRoot }
    await killAt(runner, runnerEnv, 'setup', 'READY_OWNER_PENDING')
    await killAt(runner, runnerEnv, 'recover-before', 'READY_OWNER_RECOVERY_BEFORE_COMMIT')
    const beforeCommit = inspect(runner, runnerEnv)
    expect(beforeCommit).toMatchObject({ journalMode: { journal_mode: 'wal' }, rows: [{ status: 'pending',
      decided_at: null, decision_reason: null, execution_status: 'running', grant_state: 'active', command_state: 'running',
      actual_cost_micros: null, reserved_cost_micros: 1000 }] })
    const recovered = spawnSync(runner.bin, [childFile, 'recover'], { env: { ...runnerEnv, ...runner.env },
      encoding: 'utf8', timeout: 30_000 })
    expect(recovered.status).toBe(0)
    const line = recovered.stdout.split('\n').find(item => item.startsWith('OWNER_RECOVERY '))
    expect(line).toBeDefined()
    const snapshot = JSON.parse(line!.slice('OWNER_RECOVERY '.length)) as {
      results: Array<{ state: string; startBoundary: string }>
      rows: Array<{ status: string; decided_at: number; decision_reason: string; execution_status: string; grant_state: string; command_state: string }>
    }
    expect(snapshot.results).toHaveLength(1)
    expect(snapshot.results[0]).toMatchObject({ state: 'unknown_recorded', startBoundary: 'started_proven' })
    expect(snapshot.rows).toHaveLength(1)
    expect(snapshot.rows[0]).toMatchObject({ status: 'invalidated', decided_at: expect.any(Number),
      decision_reason: 'runtime_recovered', execution_status: 'stale', grant_state: 'paused', command_state: 'needs_reconcile' })
    const repeatedRecovery = await killAt(runner, runnerEnv, 'recover-after', 'READY_OWNER_RECOVERY_AFTER_COMMIT')
    expect(repeatedRecovery).toContain('READY_OWNER_RECOVERY_AFTER_COMMIT []')
    const afterCommit = inspect(runner, runnerEnv)
    expect(afterCommit).toMatchObject({ journalMode: { journal_mode: 'wal' }, rows: [{ status: 'invalidated',
      decision_reason: 'runtime_recovered', execution_status: 'stale', grant_state: 'paused', command_state: 'needs_reconcile',
      actual_cost_micros: null, reserved_cost_micros: 1000 }] })
  }
}, 120_000)
