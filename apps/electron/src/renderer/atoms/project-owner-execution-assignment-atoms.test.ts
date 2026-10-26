import { expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { OwnerExecutionAssignmentRunView, ProjectOwnerGoalResult } from '@gravitas/shared'
import { getOwnerExecutionAssignmentEditor, loadOwnerExecutionAssignmentRunsAtom, ownerExecutionAssignmentApiAtom, ownerExecutionAssignmentEditorsAtom } from './project-owner-execution-assignment-atoms'
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function run(id: string): OwnerExecutionAssignmentRunView {
  return { sourceStatus: 'current', link: { schemaVersion: 1, id, projectId: 'p', requestId: id, planningTaskId: id, purpose: 'owner_execution_assignment', bindingRevision: 1, goalRevision: 1, goalVersion: 1, planRevision: 2, contextFingerprint: 'a'.repeat(64), carrierFingerprint: 'b'.repeat(64), protocolVersion: '2', promptHash: 'c'.repeat(64), assignmentContextFingerprint: 'd'.repeat(64), maxRequests: 1, maxOutputTokens: 4096, createdAt: 1 }, executions: [], outcomes: [] }
}
test('Given 推送和聚焦同时刷新安排 When 旧结果或错误晚到 Then 不覆盖更新安排和成功状态', async () => {
  for (const stale of [{ ok: true as const, value: [run('old')] }, { ok: false as const, error: { code: 'failed' as const, message: '旧请求错误' } }]) {
    const store = createStore(), old = deferred<ProjectOwnerGoalResult<OwnerExecutionAssignmentRunView[]>>()
    let count = 0
    store.set(ownerExecutionAssignmentApiAtom, { prepareOwnerExecutionAssignment: async () => { throw new Error('不能准备或调用模型') }, listOwnerExecutionAssignmentRuns: async () => ++count === 1 ? old.promise : { ok: true, value: [run('latest')] } })
    const first = store.set(loadOwnerExecutionAssignmentRunsAtom, { projectId: 'p' })
    await store.set(loadOwnerExecutionAssignmentRunsAtom, { projectId: 'p' })
    old.resolve(stale); await first
    const state = getOwnerExecutionAssignmentEditor(store.get(ownerExecutionAssignmentEditorsAtom), { projectId: 'p' })
    expect(state.runs[0]?.link.id).toBe('latest')
    expect(state.error).toBe('')
    expect(state.loading).toBe(false)
  }
})
