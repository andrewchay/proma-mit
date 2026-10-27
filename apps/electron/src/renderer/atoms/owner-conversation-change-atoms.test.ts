import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { DecideOwnerConversationChangeRequest, OwnerConversationChangeView, OwnerManagementView, ProjectOwnerGoalDraft } from '@gravitas/shared'
import { decideOwnerConversationChangeAtom, getOwnerConversationChangeEditor, ownerConversationChangeEditorsAtom } from './owner-conversation-change-atoms'
import { getOwnerManagementEditor, ownerManagementApiAtom, ownerManagementEditorsAtom } from './project-owner-management-atoms'
import { ownerGoalApiAtom, getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
function fixture() {
  const store = createStore(), subject = { projectId: 'p' }
  const goal: ProjectOwnerGoalDraft = { schemaVersion: 1, revision: 2, actor: 'local-user', savedAt: 1, state: 'draft', goal: { projectId: 'p', goalVersion: 2, objective: '确认后的目标', constraints: [], acceptanceCriteria: [] } }
  const proposal: OwnerConversationChangeView = { id: 'c'.repeat(64), ...subject, conversationId: 'conversation', messageId: 'm'.repeat(64), goalRevision: 1, summary: '请确认', change: { kind: 'goal_revision', goal: { objective: goal.goal.objective, constraints: [], acceptanceCriteria: [] } }, currentGoal: { objective: '原目标', constraints: [], acceptanceCriteria: [] }, questions: [], previewHash: 'a'.repeat(64), state: 'pending' }
  const view: OwnerManagementView = { manager: null, messages: [], questions: [], changes: [proposal], pendingEvents: 0 }
  store.set(ownerManagementEditorsAtom, new Map([['p', { ...getOwnerManagementEditor(new Map(), 'p'), view }]]))
  store.set(ownerGoalApiAtom, { getOwnerGoalDraft: async () => ({ ok: true, value: goal }), saveOwnerGoalDraft: async () => { throw new Error('禁止直接保存') } })
  const calls: DecideOwnerConversationChangeRequest[] = []
  let mode: 'success' | 'lost' | 'unknown' | 'mismatch' = 'success'
  store.set(ownerManagementApiAtom, {
    getOwnerManagement: async () => ({ ok: true, value: view }), answerOwnerManagementQuestion: async () => { throw new Error('禁止绕行') },
    decideOwnerConversationChange: async input => {
      calls.push(input)
      if (mode === 'unknown') throw new Error('状态未知')
      if (mode === 'lost') { proposal.state = input.action === 'apply' ? 'applied' : 'dismissed'; throw new Error('回包丢失') }
      if (mode === 'mismatch') return { ok: true, value: { changeId: proposal.id, action: input.action, goal: { ...goal, goal: { ...goal.goal, taskId: 'other' } } } }
      proposal.state = input.action === 'apply' ? 'applied' : 'dismissed'
      return { ok: true, value: { changeId: proposal.id, action: input.action, ...(input.action === 'apply' ? { goal } : {}) } }
    },
  })
  const decide = (action: 'apply' | 'dismiss' = 'apply', projectId = 'p') => store.set(decideOwnerConversationChangeAtom, { subject: { projectId }, changeId: proposal.id, action })
  const editor = () => getOwnerConversationChangeEditor(store.get(ownerConversationChangeEditorsAtom), 'p', proposal.id)
  return { store, subject, proposal, view, goal, calls, decide, editor, mode: (next: typeof mode) => { mode = next } }
}

test('Given同一内容确认 When双击或跨项目使用 Then只发一个准确请求并读取最新目标', async () => {
  const f = fixture()
  expect(await f.decide('apply', 'other')).toBe(false)
  expect(await Promise.all([f.decide(), f.decide()])).toEqual([true, false])
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]).toMatchObject({ changeId: f.proposal.id, previewHash: f.proposal.previewHash, action: 'apply' })
  expect(f.editor()).toMatchObject({ busy: false, pending: null, error: '' })
  expect(getOwnerGoalEditor(f.store.get(ownerGoalEditorsAtom), f.subject).snapshot).toEqual(f.goal)
})

test('Given后端已提交但回包丢失 When重新读取准确裁决 Then恢复成功且不用重新保存目标', async () => {
  const f = fixture(); f.mode('lost')
  expect(await f.decide()).toBe(true)
  expect(f.calls).toHaveLength(1)
  expect(f.editor().pending).toBeNull()
})

test('Given结果未知 When尝试反向裁决或来源变更后重提 Then拒绝改动作、保持原请求和摘要', async () => {
  const f = fixture(); f.mode('unknown')
  expect(await f.decide()).toBe(false)
  const original = f.calls[0]
  expect(await f.decide('dismiss')).toBe(false)
  f.proposal.previewHash = 'b'.repeat(64); f.proposal.state = 'stale'
  expect(await f.decide()).toBe(false)
  expect(f.calls).toEqual([original!, original!])
  expect(f.editor()).toMatchObject({ busy: false, error: '状态未知', pending: original })
})

test('Given任务身份错误的回执 When无准确权威裁决可恢复 Then保留未知请求且不接受错误目标', async () => {
  const f = fixture(); f.mode('mismatch')
  expect(await f.decide()).toBe(false)
  expect(f.editor().pending).toBeTruthy()
  expect(f.editor().error).toContain('回执不匹配')
  expect(getOwnerGoalEditor(f.store.get(ownerGoalEditorsAtom), f.subject).snapshot).toBeNull()
})
