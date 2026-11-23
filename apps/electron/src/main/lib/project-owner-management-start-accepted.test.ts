import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-start-accepted-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())

const store = await import('./project-sqlite-store')
const management = await import('./project-owner-management-store')
// 管理记录的完整性用普通 JSON 序列化哈希（非键序无关），必须与读取侧同款。
const { createHash } = await import('node:crypto')
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

function project(): string {
  const value = store.createProject({ title: 'Owner启动接受', description: '' })
  // 管理主体是 recordOwnerManagementStartAccepted 的前置；直接落库，避免绕过私有 ensureManager。
  const manager = { schemaVersion: 1 as const, projectId: value.id, ownerId: 'owner-1', conversationId: 'conv-1', revision: 1, status: 'active' as const, createdAt: Date.now(), updatedAt: Date.now() }
  store.getProjectDb().prepare('INSERT INTO project_owner_managers (project_id, revision, payload, integrity_hash) VALUES (?, 1, ?, ?)')
    .run(value.id, JSON.stringify(manager), digest(manager))
  return value.id
}

function lastAssistantContent(projectId: string): string {
  const row = store.getProjectDb()
    .prepare("SELECT payload FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload,'$.role')='assistant' ORDER BY rowid DESC LIMIT 1")
    .get(projectId) as { payload: string } | undefined
  return row ? (JSON.parse(row.payload) as { content: string }).content : ''
}

test('Given没有复用步骤 When记录启动接受 Then使用通用说明', () => {
  const projectId = project()
  management.recordOwnerManagementStartAccepted(projectId, 'intent-plain', 1)
  const content = lastAssistantContent(projectId)
  expect(content).toContain('已按你确认的结果与边界开始组织执行')
  expect(content).not.toContain('沿用')
})

// 用户看到「开始执行」时必须能判断新工作是否真的建立在旧成果上，
// 否则「已验收步骤不重跑」这件事在界面上不可见。
test('Given复用了已验收步骤 When记录启动接受 Then说明沿用哪些步骤且不重复计费', () => {
  const projectId = project()
  management.recordOwnerManagementStartAccepted(projectId, 'intent-reuse', 1, undefined, [
    { stepKey: 'brief', taskId: 'task-brief', artifactHash: 'a'.repeat(64) },
  ])
  const content = lastAssistantContent(projectId)
  expect(content).toContain('已验收的 1 个步骤')
  expect(content).toContain('brief')
  expect(content).toContain('不会重复派工或重复计费')
})

test('Given复用多个步骤 When记录启动接受 Then逐个列出步骤键', () => {
  const projectId = project()
  management.recordOwnerManagementStartAccepted(projectId, 'intent-many', 1, undefined, [
    { stepKey: 'brief', taskId: 't1', artifactHash: 'a'.repeat(64) },
    { stepKey: 'design', taskId: 't2', artifactHash: 'b'.repeat(64) },
  ])
  expect(lastAssistantContent(projectId)).toContain('brief、design')
})

test('Given空复用清单 When记录启动接受 Then不出现沿用说明', () => {
  const projectId = project()
  management.recordOwnerManagementStartAccepted(projectId, 'intent-empty', 1, undefined, [])
  expect(lastAssistantContent(projectId)).not.toContain('沿用')
})
