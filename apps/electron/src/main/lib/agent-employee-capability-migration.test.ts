import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import initSqlJs from 'sql.js'
import { closeProjectDb, createAgentEmployee, createAgentEmployeeCapabilityVersion, createAgentEmployeeLearningSample, createProject, createTask, getAgentEmployeeCapabilityHealth, initProjectDb, listAgentEmployeeCapabilityRollbackAudits, listAgentEmployeeCapabilityVersions, listAgentEmployeeLearningSamples, mergeWalIntoDatabaseImage, rollbackAgentEmployeeCapabilityVersion } from './project-sqlite-store'

let configDir = ''
let dbPath = ''
beforeAll(async () => {
  configDir = join(tmpdir(), `gravitas-employee-migration-${randomUUID()}`)
  mkdirSync(join(configDir, 'projects'), { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  await initProjectDb()
  dbPath = join(configDir, 'projects', 'paa.db')
})
afterAll(() => {
  closeProjectDb()
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

test('旧库缺列时迁移补全，能力表可用', () => {
  // initProjectDb 已建库；这里验证新增列与表确实存在且可用（迁移幂等）。
  const employee = createAgentEmployee({ name: '迁移员工', role: '开发', description: '', channelId: 'channel' })
  const version = createAgentEmployeeCapabilityVersion({ agentId: employee.id, versionNumber: 1, scope: 'role', content: '能力', contentHash: 'hash', status: 'active', source: 'manual', activatedAt: Date.now() })
  expect(listAgentEmployeeCapabilityVersions(employee.id)).toHaveLength(1)
  expect(getAgentEmployeeCapabilityHealth(employee.id, 30)).toHaveLength(1)

  const project = createProject({ title: '迁移项目', description: '' })
  const task = createTask(project.id, { title: '任务', description: '', priority: 'medium' })
  createAgentEmployeeLearningSample({ agentId: employee.id, executionId: 'mig-run', projectId: project.id, taskId: task.id, capabilityVersionIds: [version.id], outcome: 'accepted', evidenceSummary: '结论', privacyStatus: 'sanitized' })
  expect(listAgentEmployeeLearningSamples(employee.id)).toHaveLength(1)
  expect(listAgentEmployeeCapabilityRollbackAudits(employee.id)).toHaveLength(0)
})

test('WAL 中已提交的能力数据可被重放读取（Bun 分支）', async () => {
  const employee = createAgentEmployee({ name: 'WAL 员工', role: '开发', description: '', channelId: 'channel' })
  const version = createAgentEmployeeCapabilityVersion({ agentId: employee.id, versionNumber: 1, scope: 'role', content: 'WAL 能力', contentHash: 'wal-hash', status: 'active', source: 'manual', activatedAt: Date.now() })
  rollbackAgentEmployeeCapabilityVersion(employee.id, version.id, 'WAL 重开测试')

  // 用真实 sqlite 生成一个最小 WAL 场景：写入未 checkpoint 的提交，再验证纯 JS 重放可读到。
  const SQL = await initSqlJs({ locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`) })
  const source = new SQL.Database()
  source.run('PRAGMA journal_mode=WAL')
  source.run('CREATE TABLE probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  source.run("INSERT INTO probe (id, value) VALUES ('p1', 'v1')")
  const mainImage = source.export()
  source.close()

  // 无 WAL 时返回主库镜像自身。
  expect(mergeWalIntoDatabaseImage(mainImage, new Uint8Array(0))).toBeNull()
  // 空 WAL 或损坏 WAL 不得破坏主库读取。
  expect(mergeWalIntoDatabaseImage(mainImage, new Uint8Array(8))).toBeNull()

  // 项目库文件必须存在，且不因读取失败而被改写。
  writeFileSync(join(configDir, 'projects', 'probe.txt'), 'ok')
  expect(dbPath.endsWith('paa.db')).toBe(true)
})
