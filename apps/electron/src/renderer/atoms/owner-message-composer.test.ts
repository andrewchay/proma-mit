import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { OwnerManagementMessage, OwnerManagementView, ProjectOwnerGoalDraft, SendOwnerManagementMessageRequest } from '@gravitas/shared'
import { editOwnerMessageAtom, getOwnerMessageComposer, ownerManagementApiAtom, ownerManagementEditorsAtom, ownerMessageComposersAtom, sendOwnerMessageAtom, getOwnerManagementEditor } from './project-owner-management-atoms'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
function fixture() {
  const store = createStore(), subject = { projectId: 'project-a' }, key = JSON.stringify([subject.projectId, null])
  const goal: ProjectOwnerGoalDraft = { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1, goal: { ...subject, goalVersion: 1, objective: '定位建议', constraints: [], acceptanceCriteria: [] } }
  const view: OwnerManagementView = { manager: { schemaVersion: 1, projectId: subject.projectId, ownerId: 'owner', conversationId: 'conversation', revision: 1, status: 'active', createdAt: 1, updatedAt: 1 }, messages: [], questions: [], pendingEvents: 0 }
  store.set(ownerGoalEditorsAtom, new Map([[key, { ...getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: goal }]]))
  store.set(ownerManagementEditorsAtom, new Map([[subject.projectId, { ...getOwnerManagementEditor(new Map(), subject.projectId), view }]]))
  const calls: SendOwnerManagementMessageRequest[] = []
  let loseReply = false
  store.set(ownerManagementApiAtom, {
    getOwnerManagement: async () => ({ ok: true, value: view }),
    answerOwnerManagementQuestion: async () => { throw new Error('禁止结构化答复冒充消息') },
    sendOwnerManagementMessage: async input => {
      calls.push(input)
      let message = view.messages.find(item => item.eventId === input.requestId)
      if (!message) { message = { id: 'saved', projectId: input.projectId, taskId: input.taskId, conversationId: input.conversationId, eventId: input.requestId, goalRevision: input.expectedGoalRevision, role: 'user', kind: 'conversation', content: input.content, ...(input.deliveryReference ? { deliveryReference: input.deliveryReference } : {}), createdAt: 1 }; view.messages.push(message) }
      if (loseReply) { loseReply = false; throw new Error('回包丢失') }
      return { ok: true, value: message }
    },
  })
  return { store, subject, goal, calls, view, loseReply: () => { loseReply = true } }
}
const composer = (f: ReturnType<typeof fixture>) => getOwnerMessageComposer(f.store.get(ownerMessageComposersAtom), f.subject)

test('Given同一输入框 When发送与双击 Then只保存一次准确消息并清草稿', async () => {
  const f = fixture()
  f.store.set(editOwnerMessageAtom, { subject: f.subject, text: '解释方案取舍' })
  await Promise.all([f.store.set(sendOwnerMessageAtom, f.subject), f.store.set(sendOwnerMessageAtom, f.subject)])
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]).toMatchObject({ content: '解释方案取舍', conversationId: 'conversation', expectedGoalRevision: 1 })
  expect(composer(f)).toMatchObject({ text: '', pending: null, sending: false, error: '' })
})

test('Given用户从准确成果卡发起修改意见 When继续编辑并发送 Then交付版本引用随同一条消息持久化', async () => {
  const f = fixture(), deliveryReference = { messageId: 'a'.repeat(64), artifactHash: 'b'.repeat(64), stepKey: 'audience-analysis' }
  f.store.set(editOwnerMessageAtom, { subject: f.subject, text: '请补充风险', deliveryReference })
  f.store.set(editOwnerMessageAtom, { subject: f.subject, text: '请补充主要风险和应对' })
  expect(composer(f).deliveryReference).toEqual(deliveryReference)
  await f.store.set(sendOwnerMessageAtom, f.subject)
  expect(f.calls[0]?.deliveryReference).toEqual(deliveryReference)
  expect(f.view.messages[0]?.deliveryReference).toEqual(deliveryReference)
  expect(composer(f).deliveryReference).toBeUndefined()
})

test('Given消息已保存但回包丢失 When刷新目标后重提 Then保留同一请求与旧准确版本、不重复消息', async () => {
  const f = fixture(); f.loseReply()
  f.store.set(editOwnerMessageAtom, { subject: f.subject, text: '先讨论范围' })
  await f.store.set(sendOwnerMessageAtom, f.subject)
  expect(composer(f)).toMatchObject({ text: '先讨论范围', error: '回包丢失' })
  f.store.set(editOwnerMessageAtom, { subject: f.subject, text: '不得覆盖未知结果的原请求' })
  expect(composer(f).text).toBe('先讨论范围')
  const key = JSON.stringify([f.subject.projectId, null])
  f.store.set(ownerGoalEditorsAtom, new Map([[key, { ...getOwnerGoalEditor(new Map(), f.subject), loaded: true, snapshot: { ...f.goal, revision: 2 } }]]))
  await f.store.set(sendOwnerMessageAtom, f.subject)
  expect(f.calls[1]).toEqual(f.calls[0])
  expect(f.view.messages).toHaveLength(1)
  expect(composer(f).text).toBe('')
})

test('Given项目与任务草稿 When切换主体 Then相互隔离且目标未保存不发送', async () => {
  const f = fixture(), other = { projectId: 'project-b' }
  f.store.set(editOwnerMessageAtom, { subject: f.subject, text: '项目A草稿' })
  f.store.set(editOwnerMessageAtom, { subject: other, text: '项目B草稿' })
  expect(getOwnerMessageComposer(f.store.get(ownerMessageComposersAtom), other).text).toBe('项目B草稿')
  expect(composer(f).text).toBe('项目A草稿')
  const key = JSON.stringify([f.subject.projectId, null]), entries = new Map(f.store.get(ownerGoalEditorsAtom))
  entries.set(key, { ...getOwnerGoalEditor(entries, f.subject), dirty: true }); f.store.set(ownerGoalEditorsAtom, entries)
  expect(await f.store.set(sendOwnerMessageAtom, f.subject)).toBe(false)
  expect(f.calls).toHaveLength(0)
})
