import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-projection-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const projection = await import('./project-owner-state-projection')
const goals = await import('./project-owner-goal-service')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

test('Given 首次核对 When 建立投影 Then 记录基线且不产生脏域', () => {
  const project = store.createProject({ title: '投影基线', description: '' })
  expect(projection.readOwnerStateProjection(project.id)).toBeNull()
  const first = projection.reconcileOwnerStateProjection(project.id)
  expect(first.changed).toBe(true)
  expect(first.dirtyDomains).toEqual([])
  expect(projection.readOwnerStateProjection(project.id)).toMatchObject({ stateHash: first.stateHash, dirtyDomains: [] })
})

test('Given 权威状态未变化 When 重复核对 Then 不产生脏域也不改摘要', () => {
  const project = store.createProject({ title: '投影稳定', description: '' })
  const first = projection.reconcileOwnerStateProjection(project.id)
  const second = projection.reconcileOwnerStateProjection(project.id, Date.now() + 1000)
  expect(second).toEqual({ changed: false, dirtyDomains: [], stateHash: first.stateHash })
})

test('Given 目标新增修订 When 核对 Then 只把目标域标脏', () => {
  const project = store.createProject({ title: '投影目标', description: '' })
  projection.reconcileOwnerStateProjection(project.id)
  goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成定位建议', constraints: [], acceptanceCriteria: [] })
  const result = projection.reconcileOwnerStateProjection(project.id)
  expect(result.changed).toBe(true)
  // 保存目标同时产生待消费的管理事件，因此目标域与对话域都会变脏。
  expect(result.dirtyDomains).toEqual(['goal', 'conversation'])
})

test('Given 员工待决事项出现 When 核对 Then 员工交互域变脏且不计入目标域', () => {
  const project = store.createProject({ title: '投影交互', description: '' })
  projection.reconcileOwnerStateProjection(project.id)
  store.getProjectDb().prepare(`INSERT INTO project_owner_employee_interactions(id,project_id,request_id,revision,payload,integrity_hash)
    VALUES(?,?,?,?,?,?)`).run('interaction-1', project.id, 'request-1', 1, JSON.stringify({ state: 'pending_owner' }), 'hash')
  const result = projection.reconcileOwnerStateProjection(project.id)
  expect(result.dirtyDomains).toEqual(['employee_interaction'])
})

test('Given 投影被删除 When 重建 Then 摘要与重建前一致', () => {
  const project = store.createProject({ title: '投影重建', description: '' })
  goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '可重建', constraints: [], acceptanceCriteria: [] })
  const first = projection.reconcileOwnerStateProjection(project.id)
  store.getProjectDb().prepare('DELETE FROM project_owner_state_projections WHERE project_id = ?').run(project.id)
  expect(projection.readOwnerStateProjection(project.id)).toBeNull()
  expect(projection.reconcileOwnerStateProjection(project.id).stateHash).toBe(first.stateHash)
})

test('Given 投影向量被篡改 When 读取 Then 明确要求重建而不是静默使用', () => {
  const project = store.createProject({ title: '投影篡改', description: '' })
  projection.reconcileOwnerStateProjection(project.id)
  store.getProjectDb().prepare('UPDATE project_owner_state_projections SET vector_json = ? WHERE project_id = ?').run(JSON.stringify({ goalRevision: 9 }), project.id)
  expect(() => projection.readOwnerStateProjection(project.id)).toThrow('请重建')
})
