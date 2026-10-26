import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-preservation-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const sessions = await import('./agent-session-manager')
const workspaces = await import('./agent-workspace-manager')
const paths = await import('./config-paths')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const workspace = workspaces.createAgentWorkspace(`preserve-${randomUUID()}`)
  const session = sessions.createAgentSession('保留证据', 'fake-channel', workspace.id)
  const root = paths.getAgentSessionWorkspacePath(workspace.slug, session.id)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'artifact.html'), '<main>成果</main>')
  writeFileSync(paths.getAgentSessionMessagesPath(session.id), '原始会话证据\n')
  return { session, root }
}

test('GivenOwner会话被项目引用 When普通删除 Then索引、消息和成果均保留', () => {
  const { session, root } = fixture()
  const project = store.createProject({ title: '保全项目', description: '' })
  const task = store.createTask(project.id, { title: '成果', description: '' })
  store.createAgentExecution({ id: randomUUID(), projectId: project.id, entityType: 'task', entityId: task.id, agentId: 'fake', sessionId: session.id, prompt: '离线夹具' })
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='owner-reference' WHERE id=?").run(task.id)
  expect(() => sessions.deleteAgentSession(session.id)).toThrow('成果与执行证据')
  expect(sessions.getAgentSessionMeta(session.id)?.id).toBe(session.id)
  expect(readFileSync(join(root, 'artifact.html'), 'utf8')).toContain('成果')
  expect(readFileSync(paths.getAgentSessionMessagesPath(session.id), 'utf8')).toBe('原始会话证据\n')
})

test('Given曾经Owner会话的执行关联已删除 When保全标记仍在 Then不能降级普通删除', () => {
  const { session, root } = fixture()
  store.getProjectDb().prepare('INSERT INTO project_owner_business_session_restrictions(session_id,execution_id,task_id,observed_at,project_id) VALUES(?,?,?,?,?)').run(session.id, 'removed-execution', 'removed-task', Date.now(), 'removed-project')
  expect(() => sessions.deleteAgentSession(session.id)).toThrow('成果与执行证据')
  expect(existsSync(root)).toBe(true)
})

test('Given普通无Owner引用的会话 When删除 Then原删除流程正常清理', () => {
  const { session, root } = fixture()
  sessions.deleteAgentSession(session.id)
  expect(sessions.getAgentSessionMeta(session.id)).toBeUndefined()
  expect(existsSync(root)).toBe(false)
  expect(existsSync(paths.getAgentSessionMessagesPath(session.id))).toBe(false)
})
