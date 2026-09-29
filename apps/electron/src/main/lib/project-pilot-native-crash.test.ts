import { afterAll, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'pilot-native-wal-'))
const childFile = join(root, 'native-crash-child.cjs')
const env = { ...process.env, PROMA_TEST_CONFIG_DIR: root,
  NODE_PATH: join(import.meta.dir, '../../../../../node_modules') }
const timeoutMs = 20_000
const nodeBinary = process.env.PROMA_NATIVE_NODE_BINARY ?? (process.platform === 'win32'
  ? 'node' : execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim())
const source = join(import.meta.dir, 'project-pilot-native-crash-child.ts')
buildSync({ entryPoints: [source], outfile: childFile, bundle: true, platform: 'node', format: 'cjs',
  target: 'node24', external: ['better-sqlite3', 'electron'], absWorkingDir: process.cwd() })
afterAll(() => rmSync(root, { recursive: true, force: true }))

interface Identity { projectId: string; grantId: string; executionId: string }
interface Snapshot {
  driver: string
  journalMode: { journal_mode: string }
  grantState: string
  decisions: number
  executionStatus: string
  requests: Array<{ executionId: string; state: string }>
}

function run(mode: 'setup' | 'inspect', identity?: Identity): Identity | Snapshot {
  const result = spawnSync(nodeBinary, [childFile, mode, ...(identity
    ? [identity.projectId, identity.grantId, identity.executionId] : [])], { env, encoding: 'utf8', timeout: timeoutMs })
  if (result.status !== 0) throw new Error(`原生夹具退出 ${result.status}: ${result.stdout}\n${result.stderr}`)
  const match = result.stdout.match(/^DATA (.+)$/m)
  if (!match) throw new Error(`原生夹具无结果：${result.stdout}\n${result.stderr}`)
  return JSON.parse(match[1]!)
}

async function killAt(mode: 'before' | 'after', identity: Identity): Promise<void> {
  const child = spawn(nodeBinary, [childFile, mode,
    identity.projectId, identity.grantId, identity.executionId], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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
    child.kill('SIGKILL')
  }
  expect((await finished).signal).toBe('SIGKILL')
}

test.skipIf(process.platform === 'win32')('原生 SQLite WAL：撤权事务提交前后强杀，重开验证回滚与待对账记录', async () => {
  const before = run('setup') as Identity
  await killAt('before', before)
  const beforeView = run('inspect', before) as Snapshot
  expect(beforeView).toMatchObject({ driver: 'NativeSqliteCompat', journalMode: { journal_mode: 'wal' },
    grantState: 'active', decisions: 0, executionStatus: 'running', requests: [] })

  const after = run('setup') as Identity
  await killAt('after', after)
  const afterView = run('inspect', after) as Snapshot
  expect(afterView).toMatchObject({ driver: 'NativeSqliteCompat', journalMode: { journal_mode: 'wal' },
    grantState: 'paused', decisions: 1, executionStatus: 'running',
    requests: [{ executionId: after.executionId, state: 'pending' }] })
}, 30_000)
