import { expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { OwnerRuntimeBinding, ProjectOwnerPlanningContext, ProjectOwnerRuntimeApi } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from './project-owner-plan-atoms'
import { editOwnerRuntimeAtom, getOwnerRuntimeEditor, loadOwnerRuntimeAtom, ownerRuntimeApiAtom, ownerRuntimeEditorsAtom, prepareOwnerRuntimeAtom, saveOwnerRuntimeAtom } from './project-owner-runtime-atoms'
const subject = { projectId: 'p' }
const binding: OwnerRuntimeBinding = { schemaVersion: 1, projectId: 'p', revision: 1, ownerRole: 'project_owner', ownerName: '项目Owner', carrierId: 'existing', workspaceId: 'w', channelId: 'c', modelId: 'm', runtime: 'ai-sdk', carrierFingerprint: 'hash', actor: 'local-user', savedAt: 1, changeReason: '明确职责' }
const context: ProjectOwnerPlanningContext = { goal: { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1, goal: { projectId: 'p', goalVersion: 1, objective: '定位方案', constraints: [], acceptanceCriteria: [] } }, sources: { project: { id: 'p', title: '定位', description: '' }, roles: [] }, fingerprint: 'context' }
function setup(overrides: Partial<ProjectOwnerRuntimeApi> = {}) {
  const store = createStore(); const requests: Parameters<ProjectOwnerRuntimeApi['prepareOwnerPlanning']>[0][] = []; let saves = 0
  store.set(ownerRuntimeApiAtom, { getOwnerRuntimeBinding: async () => ({ ok: true, value: binding }), saveOwnerRuntimeBinding: async () => { saves++; return { ok: true, value: { ...binding, revision: 2 } } }, prepareOwnerPlanning: async input => { requests.push(input); return { ok: false, error: { code: 'failed', message: '模拟不确定响应' } } }, listOwnerPlanningRuns: async () => ({ ok: true, value: [] }), getOwnerPlanningContext: async () => ({ ok: true, value: context }), listEmployees: async () => [], listWorkspaces: async () => [], listWorkspaceBindings: async () => [], ...overrides })
  store.set(ownerGoalEditorsAtom, new Map([['["p",null]', { ...getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: context.goal }]]))
  store.set(ownerPlanEditorsAtom, new Map([['["p",null]', { ...getOwnerPlanEditor(new Map(), subject), loaded: true, context }]]))
  return { store, requests, saves: () => saves, read: (s = subject) => getOwnerRuntimeEditor(store.get(ownerRuntimeEditorsAtom), s) }
}
test('Given 首次只读刷新 When 读取绑定/资料/Run Then 零保存/准备，更不调用收费start', async () => {
  const f = setup(); await f.store.set(loadOwnerRuntimeAtom, subject); expect(f.read().binding).toEqual(binding); expect(f.requests).toHaveLength(0); expect(f.saves()).toBe(0)
})
test('Given 未保存目标或计划 When 准备 Then 零写入，配置保存不被误当费用同意', async () => {
  const f = setup(); await f.store.set(loadOwnerRuntimeAtom, subject)
  f.store.set(ownerGoalEditorsAtom, new Map([['["p",null]', { ...getOwnerGoalEditor(f.store.get(ownerGoalEditorsAtom), subject), dirty: true }]])); await f.store.set(prepareOwnerRuntimeAtom, subject); expect(f.requests).toHaveLength(0)
  f.store.set(editOwnerRuntimeAtom, { subject, patch: { ownerName: '治理Owner', changeReason: '明确责任' } }); await f.store.set(saveOwnerRuntimeAtom, subject); expect(f.saves()).toBe(1); expect(f.requests).toHaveLength(0)
})
test('Given 手动准备失败 When 同来源用户再试 Then 复用requestId；版本变化后新准备ID，不自动重试', async () => {
  const f = setup(); await f.store.set(loadOwnerRuntimeAtom, subject); await f.store.set(prepareOwnerRuntimeAtom, subject); expect(f.requests).toHaveLength(1); await f.store.set(prepareOwnerRuntimeAtom, subject); expect(f.requests[1]?.input.requestId).toBe(f.requests[0]?.input.requestId)
  f.store.set(ownerPlanEditorsAtom, new Map([['["p",null]', { ...getOwnerPlanEditor(f.store.get(ownerPlanEditorsAtom), subject), snapshot: { schemaVersion: 1, projectId: 'p', revision: 2, planVersion: 2, goalRevision: 1, goalVersion: 1, state: 'proposed', actor: 'local-user', origin: 'manual', savedAt: 1, changeReason: '变更', contextFingerprint: 'context', planFingerprint: 'plan', sources: context.sources, proposal: { projectId: 'p', goalVersion: 1, mode: 'proposal_only', summary: '计划', assumptions: [], risks: [], steps: [] } } }]])); await f.store.set(prepareOwnerRuntimeAtom, subject); expect(f.requests[2]?.input.requestId).not.toBe(f.requests[0]?.input.requestId); expect(f.requests[2]?.input.expectedPlanRevision).toBe(2)
})
test('Given 切主体与加载晚到 When 本地修改配置 Then 保留输入且主体隔离', async () => {
  let resolve!: (input: Awaited<ReturnType<ProjectOwnerRuntimeApi['getOwnerRuntimeBinding']>>) => void
  const pending = new Promise<Awaited<ReturnType<ProjectOwnerRuntimeApi['getOwnerRuntimeBinding']>>>(done => { resolve = done }); const f = setup({ getOwnerRuntimeBinding: () => pending }); const loading = f.store.set(loadOwnerRuntimeAtom, subject)
  f.store.set(editOwnerRuntimeAtom, { subject, patch: { ownerName: '未保存名称' } }); f.store.set(editOwnerRuntimeAtom, { subject: { projectId: 'other' }, patch: { ownerName: '其他主体输入' } }); resolve({ ok: true, value: binding }); await loading
  expect(f.read().ownerName).toBe('未保存名称'); expect(f.read({ projectId: 'other' }).ownerName).toBe('其他主体输入'); expect(f.read().dirty).toBe(true)
})
test('Given 已保存目标但来源接口failed When 刷新 Then 保留原诊断并禁准备，不吞错误', async () => {
  const f = setup(); const api = f.store.get(ownerRuntimeApiAtom)!; f.store.set(ownerRuntimeApiAtom, { ...api, getOwnerPlanningContext: async () => ({ ok: false, error: { code: 'failed', message: '岗位来源记录损坏' } }) }); await f.store.set(loadOwnerRuntimeAtom, subject)
  expect(f.read().context).toBeNull(); expect(f.read().error).toContain('岗位来源记录损坏'); await f.store.set(prepareOwnerRuntimeAtom, subject); expect(f.requests).toHaveLength(0)
})
