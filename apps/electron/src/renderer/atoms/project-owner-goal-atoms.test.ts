import { expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { ProjectOwnerGoalApi, ProjectOwnerGoalDraft, ProjectOwnerGoalResult } from '@gravitas/shared'
import {
  acknowledgeOwnerGoalComparisonAtom, canSaveOwnerGoal, editOwnerGoalAtom, getOwnerGoalEditor,
  loadOwnerGoalAtom, ownerGoalApiAtom, ownerGoalEditorsAtom, saveOwnerGoalAtom,
} from './project-owner-goal-atoms'

const a = { projectId: 'a' }; const b = { projectId: 'b' }
function draft(projectId = 'a', revision = 1): ProjectOwnerGoalDraft {
  return { schemaVersion: 1, revision, state: 'draft', actor: 'local-user', savedAt: 1,
    goal: { projectId, goalVersion: revision, objective: `服务器目标${revision}`, constraints: [], acceptanceCriteria: [] } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function setup(api: Partial<ProjectOwnerGoalApi> = {}) {
  const store = createStore()
  store.set(ownerGoalApiAtom, {
    getOwnerGoalDraft: async () => ({ ok: true, value: null }),
    saveOwnerGoalDraft: async (request) => ({ ok: true, value: { ...draft(request.projectId, request.expectedRevision + 1), goal: { projectId: request.projectId, ...(request.taskId === undefined ? {} : { taskId: request.taskId }), ...request.input, goalVersion: request.expectedRevision + 1, constraints: request.input.constraints ?? [], acceptanceCriteria: request.input.acceptanceCriteria ?? [] } } }),
    ...api,
  })
  return { store, read: (subject = a) => getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), subject) }
}

test('加载完成前不盲写revision0，目标仅编辑不会调用保存', async () => {
  let writes = 0
  const { store, read } = setup({ saveOwnerGoalDraft: async () => { writes++; return { ok: true, value: draft() } } })
  store.set(editOwnerGoalAtom, { subject: a, patch: { objective: '本地目标' } })
  await store.set(saveOwnerGoalAtom, a); expect(writes).toBe(0)
  await store.set(loadOwnerGoalAtom, a); expect(canSaveOwnerGoal(read())).toBe(true)
  await store.set(saveOwnerGoalAtom, a); expect(writes).toBe(1)
})
test('加载失败保留输入并禁止盲写，明确重试加载后恢复', async () => {
  let fail = true
  const { store, read } = setup({ getOwnerGoalDraft: async () => fail ? { ok: false, error: { code: 'failed', message: '加载失败' } } : { ok: true, value: null } })
  store.set(editOwnerGoalAtom, { subject: a, patch: { objective: '仍保留目标' } })
  await store.set(loadOwnerGoalAtom, a)
  expect(read().objective).toBe('仍保留目标'); expect(canSaveOwnerGoal(read())).toBe(false)
  fail = false; await store.set(loadOwnerGoalAtom, a); expect(canSaveOwnerGoal(read())).toBe(true)
})
test('加载期间输入不会被晚到服务器内容覆盖，需先比较最新版本', async () => {
  const pending = deferred<ProjectOwnerGoalResult<ProjectOwnerGoalDraft | null>>()
  const { store, read } = setup({ getOwnerGoalDraft: () => pending.promise })
  const loading = store.set(loadOwnerGoalAtom, a)
  store.set(editOwnerGoalAtom, { subject: a, patch: { objective: '新输入' } })
  pending.resolve({ ok: true, value: draft() }); await loading
  expect(read().objective).toBe('新输入'); expect(read().requiresReview).toBe(true)
  store.set(acknowledgeOwnerGoalComparisonAtom, a); expect(canSaveOwnerGoal(read())).toBe(true)
})
test('项目和单任务各自隔离，旧项目响应不会写入新项目', async () => {
  const pending = deferred<ProjectOwnerGoalResult<ProjectOwnerGoalDraft | null>>()
  const { store, read } = setup({ getOwnerGoalDraft: (subject) => subject.projectId === 'a' ? pending.promise : Promise.resolve({ ok: true, value: draft('b') }) })
  const loading = store.set(loadOwnerGoalAtom, a)
  await store.set(loadOwnerGoalAtom, b)
  store.set(editOwnerGoalAtom, { subject: { projectId: 'b', taskId: 't' }, patch: { objective: '任务输入' } })
  pending.resolve({ ok: true, value: draft('a') }); await loading
  expect(read(b).objective).toBe('服务器目标1'); expect(read(a).objective).toBe('服务器目标1')
  expect(getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), { projectId: 'b', taskId: 't' }).objective).toBe('任务输入')
  expect(read(b).dirty).toBe(false)
})
test('冲突保留输入，不自动重试；加载最新并人工比较后才能保存', async () => {
  let version = 1; let writes = 0
  const { store, read } = setup({
    getOwnerGoalDraft: async () => ({ ok: true, value: draft('a', version) }),
    saveOwnerGoalDraft: async () => { writes++; return { ok: false, error: { code: 'conflict', message: '已更新' } } },
  })
  await store.set(loadOwnerGoalAtom, a)
  store.set(editOwnerGoalAtom, { subject: a, patch: { objective: '我的输入' } })
  await store.set(saveOwnerGoalAtom, a); expect(read().conflict).toBe(true)
  await store.set(saveOwnerGoalAtom, a); expect(writes).toBe(1)
  version = 2; await store.set(loadOwnerGoalAtom, a)
  expect(read().objective).toBe('我的输入'); expect(read().snapshot?.revision).toBe(2)
  expect(canSaveOwnerGoal(read())).toBe(false)
  store.set(acknowledgeOwnerGoalComparisonAtom, a); expect(canSaveOwnerGoal(read())).toBe(true)
})
test('保存期间继续编辑，成功返回仅更新权威版本，不抹掉新输入', async () => {
  const pending = deferred<ProjectOwnerGoalResult<ProjectOwnerGoalDraft>>()
  const { store, read } = setup({ saveOwnerGoalDraft: () => pending.promise })
  await store.set(loadOwnerGoalAtom, a)
  store.set(editOwnerGoalAtom, { subject: a, patch: { objective: '第一次输入' } })
  const saving = store.set(saveOwnerGoalAtom, a)
  store.set(editOwnerGoalAtom, { subject: a, patch: { objective: '保存期间的新输入' } })
  pending.resolve({ ok: true, value: draft() }); await saving
  expect(read().objective).toBe('保存期间的新输入'); expect(read().dirty).toBe(true)
  expect(read().snapshot?.revision).toBe(1); expect(canSaveOwnerGoal(read())).toBe(true)
})
test('保存失败保留目标/约束/标准，允许手动修复重试但不自动重试', async () => {
  const { store, read } = setup({ saveOwnerGoalDraft: async () => { throw new Error('通信失败') } })
  await store.set(loadOwnerGoalAtom, a)
  store.set(editOwnerGoalAtom, { subject: a, patch: { objective: '目标', constraintsText: '约束', criteriaText: '标准' } })
  await store.set(saveOwnerGoalAtom, a)
  expect(read()).toMatchObject({ objective: '目标', constraintsText: '约束', criteriaText: '标准', saving: false, dirty: true, error: '通信失败' })
})
test('无修改或空目标不能保存，保存成功采用服务器规范化副本', async () => {
  const { store, read } = setup({ saveOwnerGoalDraft: async () => ({ ok: true, value: draft() }) })
  await store.set(loadOwnerGoalAtom, a); expect(canSaveOwnerGoal(read())).toBe(false)
  store.set(editOwnerGoalAtom, { subject: a, patch: { objective: ' ' } }); expect(canSaveOwnerGoal(read())).toBe(false)
  store.set(editOwnerGoalAtom, { subject: a, patch: { objective: '  本地目标  ' } })
  await store.set(saveOwnerGoalAtom, a)
  expect(read().objective).toBe('服务器目标1'); expect(read().dirty).toBe(false)
})
test('刷新本地未保存草案时保留输入；跨主体API响应被拒绝', async () => {
  const { store, read } = setup({ getOwnerGoalDraft: async () => ({ ok: true, value: draft('wrong') }) })
  await store.set(loadOwnerGoalAtom, a)
  expect(read().loaded).toBe(false); expect(read().error).toContain('主体')
})
