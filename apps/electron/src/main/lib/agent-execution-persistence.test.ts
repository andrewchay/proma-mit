/**
 * AgentExecution 持久化测试 — 执行记录（含 prompt）必须真正落库并能被读回。
 *
 * 覆盖两类回归：
 * 1) updateAgentExecution 把 prompt 写回 SQLite，重开数据库后仍为最新值；
 * 2) 生产分支以 WAL 模式写入时，测试分支（sql.js）必须合并 `-wal` 再读，
 *    否则「已提交的执行记录/prompt」会读成旧快照甚至 0 行。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import {
  closeProjectDb,
  createAgentExecution,
  createProject,
  createTask,
  getAgentExecution,
  getProjectDb,
  initProjectDb,
  mergeWalIntoDatabaseImage,
  updateAgentExecution,
} from './project-sqlite-store'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-execution-'))
const previousDirectory = process.env.PROMA_TEST_CONFIG_DIR

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = directory
  await initProjectDb()
})

afterAll(() => {
  closeProjectDb()
  if (previousDirectory === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousDirectory
  rmSync(directory, { recursive: true, force: true })
})

function readPromptColumn(id: string): string {
  const row = getProjectDb().prepare('SELECT prompt FROM agent_executions WHERE id = ?').get(id) as
    | { prompt: string }
    | undefined
  return row!.prompt
}

test('Given 执行记录已创建 When 更新 prompt 并重开数据库 Then prompt 保持最新值', async () => {
  const project = createProject({ title: '执行记录持久化', description: '' })
  const task = createTask(project.id, { title: '实现', description: '' })
  createAgentExecution({
    id: 'run-prompt',
    projectId: project.id,
    entityType: 'task',
    entityId: task.id,
    agentId: 'agent-a',
    sessionId: 'session-prompt',
    prompt: '初始 prompt',
  })
  expect(readPromptColumn('run-prompt')).toBe('初始 prompt')

  const updated = updateAgentExecution('run-prompt', { prompt: '研发基线 prompt' })
  expect(updated?.prompt).toBe('研发基线 prompt')
  expect(readPromptColumn('run-prompt')).toBe('研发基线 prompt')

  // 重开后必须仍是最新值（而不是落回初始值）
  closeProjectDb()
  await initProjectDb()
  expect(getAgentExecution('run-prompt')?.prompt).toBe('研发基线 prompt')
  expect(readPromptColumn('run-prompt')).toBe('研发基线 prompt')

  // 后续只改状态不应覆盖已写入的 prompt
  updateAgentExecution('run-prompt', { status: 'running' })
  expect(readPromptColumn('run-prompt')).toBe('研发基线 prompt')
})

test('Given 执行记录不存在 When 更新 prompt Then 返回 null 且不写入任何行', () => {
  expect(updateAgentExecution('missing-run', { prompt: '无效' })).toBeNull()
  const row = getProjectDb().prepare('SELECT COUNT(*) AS c FROM agent_executions WHERE id = ?').get('missing-run') as { c: number }
  expect(row.c).toBe(0)
})

test('Given 已提交事务只存在于 WAL When 测试分支读库 Then 必须合并 WAL 才能看到最新 prompt', async () => {
  // 用真实 SQLite（better-sqlite3）造一个「主库旧快照 + WAL 新提交」的场景，
  // 复现生产分支（WAL 写入）与测试分支（readFileSync 主库）之间的读取落差。
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'gravitas-wal-'))
  const dbPath = join(fixtureDirectory, 'paa.db')
  try {
    // 1) 先用项目自身在临时库写入基线数据并落盘
    const baselineDirectory = mkdtempSync(join(tmpdir(), 'gravitas-wal-base-'))
    const previous = process.env.PROMA_TEST_CONFIG_DIR
    process.env.PROMA_TEST_CONFIG_DIR = baselineDirectory
    closeProjectDb()
    await initProjectDb()
    const project = createProject({ title: 'WAL 场景', description: '' })
    const task = createTask(project.id, { title: '任务', description: '' })
    createAgentExecution({
      id: 'run-wal',
      projectId: project.id,
      entityType: 'task',
      entityId: task.id,
      agentId: 'agent-a',
      sessionId: 'session-wal',
      prompt: '初始 prompt',
    })
    closeProjectDb()
    copyFileSync(join(baselineDirectory, 'projects', 'paa.db'), dbPath)

    // 2) 用原生 SQLite 以 WAL 模式追加一次「只写 WAL、不 checkpoint」的更新。
    //    注意：关闭连接会触发自动 checkpoint，因此必须在关闭前把主库与 WAL 快照下来。
    const { openNativeSqlite } = await import('./native-sqlite')
    const { readFileSync } = await import('node:fs')
    const native = openNativeSqlite(dbPath)
    let mainSnapshot: Uint8Array
    let walSnapshot: Uint8Array
    try {
      native.exec('PRAGMA journal_mode = WAL')
      native.exec('PRAGMA wal_autocheckpoint = 0')
      native.exec("UPDATE agent_executions SET prompt = 'WAL 中提交的最新 prompt' WHERE id = 'run-wal'")
      const walPath = `${dbPath}-wal`
      expect(existsSync(walPath)).toBe(true)
      walSnapshot = readFileSync(walPath)
      mainSnapshot = readFileSync(dbPath)
    } finally {
      native.close()
    }

    const SQL = await initSqlJs({ locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`) })

    // 3) 未合并时，直接读主库文件仍是旧值（这正是修复前的缺陷表现）
    const stale = new SQL.Database(mainSnapshot)
    const stalePrompt = stale.exec("SELECT prompt FROM agent_executions WHERE id = 'run-wal'")[0]?.values[0]?.[0]
    stale.close()
    expect(stalePrompt).toBe('初始 prompt')

    // 4) 合并 WAL 后必须读到最新 prompt
    const merged = mergeWalIntoDatabaseImage(mainSnapshot, walSnapshot)
    expect(merged).not.toBeNull()
    const fresh = new SQL.Database(merged!)
    const freshPrompt = fresh.exec("SELECT prompt FROM agent_executions WHERE id = 'run-wal'")[0]?.values[0]?.[0]
    const freshCount = fresh.exec('SELECT COUNT(*) FROM agent_executions')[0]?.values[0]?.[0]
    fresh.close()
    expect(freshPrompt).toBe('WAL 中提交的最新 prompt')
    expect(freshCount).toBe(1)

    rmSync(baselineDirectory, { recursive: true, force: true })
    if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
    else process.env.PROMA_TEST_CONFIG_DIR = previous
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true })
  }
})

test('Given WAL 文件损坏或不存在 When 合并 Then 安全返回 null 而不抛错', () => {
  const pageSize = 4096
  const fakeMain = new Uint8Array(pageSize * 2)
  expect(mergeWalIntoDatabaseImage(fakeMain, new Uint8Array(0))).toBeNull()
  expect(mergeWalIntoDatabaseImage(fakeMain, new Uint8Array([1, 2, 3]))).toBeNull()
  // WAL 头 magic 正确但帧全被破坏：应返回 null（不能把未提交/损坏数据当成有效镜像）
  const brokenWal = new Uint8Array(32 + 24 + pageSize)
  const view = new DataView(brokenWal.buffer)
  view.setUint32(0, 0x377f0682, false)
  view.setUint32(8, pageSize, false)
  expect(mergeWalIntoDatabaseImage(fakeMain, brokenWal)).toBeNull()
})
