import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-terminal-evidence-store-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())

const store = await import('./project-sqlite-store')
const repo = await import('./project-owner-terminal-evidence')
const { ownerExecutionHash } = await import('./project-owner-execution-hash')

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

const evidence = {
  schemaVersion: 1 as const, executionId: 'exec-1', commandId: 'cmd-1', role: 'executor' as const,
  executionStatus: 'failed',
  provider: { subtype: 'error_during_execution', finishReason: 'other', requestId: 'req-1', responseId: null },
  reason: 'provider_stop' as const, detail: 'Owner模型未完整结束',
  tools: { calls: 1, results: 1, lastToolName: 'Read', lastResultStatus: 'ok' as const, incompleteBatch: false },
  cost: { state: 'settled' as const, actualCostMicros: 10, requestCount: 1 },
  development: { worktreePath: '/tmp/w', baseCommit: 'a'.repeat(40), changedFiles: ['index.html'], untrackedFiles: [] },
  capturedAt: 1,
}

test('Given同一命令重复写入 When证据一致 Then幂等且不改写', () => {
  const project = store.createProject({ title: '终端证据', description: '' })
  expect(repo.writeOwnerTerminalEvidence(project.id, evidence)).toEqual(evidence)
  expect(repo.writeOwnerTerminalEvidence(project.id, evidence)).toEqual(evidence)
  expect(repo.readOwnerTerminalEvidence('cmd-1')).toEqual(evidence)
})

test('Given同一命令不同内容 When再次写入 Then拒绝并保留原件', () => {
  const project = store.createProject({ title: '终端证据冲突', description: '' })
  repo.writeOwnerTerminalEvidence(project.id, { ...evidence, commandId: 'cmd-conflict' })
  expect(() => repo.writeOwnerTerminalEvidence(project.id, { ...evidence, commandId: 'cmd-conflict', detail: '不同说明' }))
    .toThrow('不一致')
  expect(repo.readOwnerTerminalEvidence('cmd-conflict')?.detail).toBe('Owner模型未完整结束')
})

test('Given不存在的命令 When读取 Then返回null而不是抛错', () => {
  expect(repo.readOwnerTerminalEvidence('cmd-does-not-exist')).toBeNull()
})

test('Given被篡改的payload When读取 Then拒绝而不是返回错误数据', () => {
  const project = store.createProject({ title: '终端证据篡改', description: '' })
  repo.writeOwnerTerminalEvidence(project.id, { ...evidence, commandId: 'cmd-tamper' })
  store.getProjectDb().prepare("UPDATE project_owner_execution_terminal_evidence SET payload=? WHERE command_id='cmd-tamper'")
    .run(JSON.stringify({ ...evidence, commandId: 'cmd-tamper', detail: '被篡改' }))
  expect(() => repo.readOwnerTerminalEvidence('cmd-tamper')).toThrow('完整性')
})

test('Given夹带未授权字段 When读取 Then拒绝', () => {
  const project = store.createProject({ title: '终端证据夹带', description: '' })
  const withExtra = { ...evidence, commandId: 'cmd-extra', secret: 'should-not-be-here' }
  // 直接写库绕过 write 校验，模拟历史/恶意数据；哈希按夹带后的对象计算，确保只有键白名单能拦住。
  store.getProjectDb().prepare(`INSERT INTO project_owner_execution_terminal_evidence(command_id,project_id,execution_id,payload,integrity_hash,created_at)
    VALUES(?,?,?,?,?,?)`).run('cmd-extra', project.id, 'exec-1', JSON.stringify(withExtra), ownerExecutionHash(withExtra), 1)
  expect(() => repo.readOwnerTerminalEvidence('cmd-extra')).toThrow('夹带未授权字段')
})

/** 直接写库构造历史/恶意行；写侧校验必须拦在落库前，否则读侧会全表不可用。 */
function insertRaw(commandId: string, projectId: string, payload: string, executionId = 'exec-1'): void {
  store.getProjectDb().prepare(`INSERT INTO project_owner_execution_terminal_evidence(command_id,project_id,execution_id,payload,integrity_hash,created_at)
    VALUES(?,?,?,?,?,?)`).run(commandId, projectId, executionId, payload, ownerExecutionHash(JSON.parse(payload)), 1)
}

test('Given空主体标识 When写入 Then拒绝且不落库', () => {
  const project = store.createProject({ title: '终端证据空主体', description: '' })
  expect(() => repo.writeOwnerTerminalEvidence('', { ...evidence, commandId: 'cmd-empty-project' })).toThrow('主体无效')
  expect(() => repo.writeOwnerTerminalEvidence(project.id, { ...evidence, commandId: '' })).toThrow('结构无效')
  expect(() => repo.writeOwnerTerminalEvidence(project.id, { ...evidence, commandId: 'cmd-empty-exec', executionId: '' })).toThrow('结构无效')
  const count = store.getProjectDb().prepare(`SELECT COUNT(*) AS count FROM project_owner_execution_terminal_evidence
    WHERE command_id IN ('cmd-empty-project','cmd-empty-exec')`).get() as { count: number }
  expect(count.count).toBe(0)
})

test('Given同一命令但项目不同 When再次写入 Then拒绝并保留原件', () => {
  const first = store.createProject({ title: '终端证据项目A', description: '' })
  const second = store.createProject({ title: '终端证据项目B', description: '' })
  repo.writeOwnerTerminalEvidence(first.id, { ...evidence, commandId: 'cmd-cross-project' })
  expect(() => repo.writeOwnerTerminalEvidence(second.id, { ...evidence, commandId: 'cmd-cross-project' })).toThrow('不一致')
  expect(repo.readOwnerTerminalEvidence('cmd-cross-project')?.commandId).toBe('cmd-cross-project')
})

test('Given同一命令但执行不同 When再次写入 Then拒绝并保留原件', () => {
  const project = store.createProject({ title: '终端证据执行冲突', description: '' })
  repo.writeOwnerTerminalEvidence(project.id, { ...evidence, commandId: 'cmd-cross-execution' })
  expect(() => repo.writeOwnerTerminalEvidence(project.id, { ...evidence, commandId: 'cmd-cross-execution', executionId: 'exec-2' })).toThrow('不一致')
  expect(repo.readOwnerTerminalEvidence('cmd-cross-execution')?.executionId).toBe('exec-1')
})

test('Given写侧schemaVersion不为1 When写入 Then拒绝且不落库', () => {
  const project = store.createProject({ title: '终端证据版本', description: '' })
  expect(() => repo.writeOwnerTerminalEvidence(project.id, { ...evidence, commandId: 'cmd-schema-2', schemaVersion: 2 } as unknown as typeof evidence)).toThrow('结构无效')
  expect(repo.readOwnerTerminalEvidence('cmd-schema-2')).toBeNull()
})

test('Given写侧capturedAt非法 When写入 Then拒绝', () => {
  const project = store.createProject({ title: '终端证据时间', description: '' })
  expect(() => repo.writeOwnerTerminalEvidence(project.id, { ...evidence, commandId: 'cmd-time-zero', capturedAt: 0 })).toThrow('结构无效')
  expect(() => repo.writeOwnerTerminalEvidence(project.id, { ...evidence, commandId: 'cmd-time-nan', capturedAt: Number.NaN })).toThrow('结构无效')
})

test('Given写侧夹带未授权字段 When写入 Then拒绝且不落库', () => {
  const project = store.createProject({ title: '终端证据写侧夹带', description: '' })
  expect(() => repo.writeOwnerTerminalEvidence(project.id, { ...evidence, commandId: 'cmd-write-extra', secret: 'x' } as unknown as typeof evidence)).toThrow('夹带未授权字段')
  expect(repo.readOwnerTerminalEvidence('cmd-write-extra')).toBeNull()
})

test('Given写入成功 When读取原始行 Thencreated_at等于capturedAt', () => {
  const project = store.createProject({ title: '终端证据时间戳', description: '' })
  const capturedAt = 1_700_000_000_000
  repo.writeOwnerTerminalEvidence(project.id, { ...evidence, commandId: 'cmd-created-at', capturedAt })
  const row = store.getProjectDb().prepare('SELECT created_at FROM project_owner_execution_terminal_evidence WHERE command_id=?').get('cmd-created-at') as { created_at: number }
  expect(row.created_at).toBe(capturedAt)
})

test('Given库内不是有效JSON When读取 Then拒绝而不是崩溃', () => {
  const project = store.createProject({ title: '终端证据坏JSON', description: '' })
  store.getProjectDb().prepare(`INSERT INTO project_owner_execution_terminal_evidence(command_id,project_id,execution_id,payload,integrity_hash,created_at)
    VALUES(?,?,?,?,?,?)`).run('cmd-bad-json', project.id, 'exec-1', 'not json', 'hash', 1)
  expect(() => repo.readOwnerTerminalEvidence('cmd-bad-json')).toThrow('不是有效JSON')
})

test('Given库内不是对象 When读取 Then报结构无效', () => {
  const project = store.createProject({ title: '终端证据非对象', description: '' })
  insertRaw('cmd-array', project.id, '[]')
  insertRaw('cmd-null', project.id, 'null')
  expect(() => repo.readOwnerTerminalEvidence('cmd-array')).toThrow('结构无效')
  expect(() => repo.readOwnerTerminalEvidence('cmd-null')).toThrow('结构无效')
})

test('Given库内证据损坏 When读取单条 Then抛错', () => {
  const project = store.createProject({ title: '终端证据降级', description: '' })
  insertRaw('cmd-degraded', project.id, JSON.stringify({ ...evidence, commandId: 'cmd-degraded', capturedAt: 0 }))
  // 降级展示由 listOwnerExecutionCommands 的 try/catch 保证（见 project-owner-execution-command.ts）；
  // 这里只锁住"读侧对损坏行必然抛错"这一前提，避免降级分支静默失效。
  expect(() => repo.readOwnerTerminalEvidence('cmd-degraded')).toThrow('结构无效')
})
