import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { OwnerExecutionCommandView, ProjectOwnerGoalResult } from '@gravitas/shared'
import { getOwnerCommandProgress, loadOwnerCommandProgressAtom, ownerCommandProgressApiAtom, ownerCommandProgressAtom } from './owner-command-progress-atoms'
const status = (projectId: string) => ({ projectId, state: 'manual' as const, reservedCostMicros: 0, committedCostMicros: 0, runReservations: 0, reason: '人工确认' })
function command(taskId: string): OwnerExecutionCommandView {
  return { commandId: `cmd-${taskId}`, grantId: 'g', taskId, taskTitle: '任务', employeeId: 'e', role: 'executor', reworkOrdinal: 0, state: 'running', executionId: 'run', executionStatus: 'running', acceptanceCriteria: ['标准'], reservedCostMicros: 10, actualCostMicros: null, ackFingerprint: 'f', createdAt: 1, updatedAt: 1, grantAuthorization: { grantState: 'active', dispatchMode: 'manual', maxCostMicros: 100, maxRuns: 3, maxRework: 1, expiresAt: 9999999999999, roleBudgetCaps: [] } }
}
test('Given人工/自主运行 When只读刷新 Then读取真实命令且零派发接口', async () => {
  const store = createStore(), subject = { projectId: 'p', taskId: 't' }
  store.set(ownerCommandProgressApiAtom, { listOwnerExecutionCommands: async () => ({ ok: true, value: [command('t')] }), getOwnerAutonomousScheduleStatus: async () => ({ ok: true, value: status('p') }) })
  await store.set(loadOwnerCommandProgressAtom, subject)
  const state = getOwnerCommandProgress(store.get(ownerCommandProgressAtom), subject)
  expect(state.loaded).toBe(true)
  expect(state.commands[0]?.actualCostMicros).toBeNull()
  expect(state.commands[0]?.state).toBe('running')
})
test('Given在途A请求与主体B When重复刷新及A晚到 Then去重并且不覆盖B', async () => {
  const store = createStore(); let done!: (value: ProjectOwnerGoalResult<OwnerExecutionCommandView[]>) => void, calls = 0
  const wait = new Promise<ProjectOwnerGoalResult<OwnerExecutionCommandView[]>>(resolve => { done = resolve })
  store.set(ownerCommandProgressApiAtom, { listOwnerExecutionCommands: async subject => { if (subject.projectId === 'a') { calls++; return wait } return { ok: true, value: [command('b')] } }, getOwnerAutonomousScheduleStatus: async subject => ({ ok: true, value: status(subject.projectId) }) })
  const a = store.set(loadOwnerCommandProgressAtom, { projectId: 'a' })
  await store.set(loadOwnerCommandProgressAtom, { projectId: 'a' })
  await store.set(loadOwnerCommandProgressAtom, { projectId: 'b' })
  done({ ok: true, value: [command('a')] }); await a
  expect(calls).toBe(1)
  expect(getOwnerCommandProgress(store.get(ownerCommandProgressAtom), { projectId: 'b' }).commands[0]?.taskId).toBe('b')
})
test('Given错误项目或命令Task响应 When刷新 Then拒绝并保留上次事实供核查', async () => {
  const store = createStore(), subject = { projectId: 'p', taskId: 't' }
  const api = { listOwnerExecutionCommands: async () => ({ ok: true as const, value: [command('t')] }), getOwnerAutonomousScheduleStatus: async () => ({ ok: true as const, value: status('p') }) }
  store.set(ownerCommandProgressApiAtom, api); await store.set(loadOwnerCommandProgressAtom, subject)
  store.set(ownerCommandProgressApiAtom, { ...api, listOwnerExecutionCommands: async () => ({ ok: true, value: [command('other')] }) })
  await store.set(loadOwnerCommandProgressAtom, subject)
  expect(getOwnerCommandProgress(store.get(ownerCommandProgressAtom), subject).loaded).toBe(false)
  expect(getOwnerCommandProgress(store.get(ownerCommandProgressAtom), subject).commands[0]?.taskId).toBe('t')
  store.set(ownerCommandProgressApiAtom, { ...api, getOwnerAutonomousScheduleStatus: async () => ({ ok: true, value: status('wrong-project') }) })
  await store.set(loadOwnerCommandProgressAtom, subject)
  expect(getOwnerCommandProgress(store.get(ownerCommandProgressAtom), subject).error).toContain('主体不匹配')
})
