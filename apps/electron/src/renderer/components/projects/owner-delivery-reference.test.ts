import { expect, test } from 'bun:test'
import type { OwnerManagementMessage } from '@gravitas/shared'
import { findReferencedDelivery } from './owner-delivery-reference'

test('Given 历史成果引用 When 未提供步骤且成果唯一 Then 可解析，重复或跨任务引用被拒', () => {
  const item = { stepKey: 'a', artifactHash: 'hash', title: '设计', content: '', acceptanceCriteria: [], ownerDecision: '', reviewerSummary: '' }
  const message: OwnerManagementMessage = { id: 'message', projectId: 'project', conversationId: 'c', eventId: 'event', taskId: 'task', role: 'assistant', kind: 'delivery', content: '', createdAt: 1, delivery: { schemaVersion: 1, planVersion: 1, items: [item] } }
  const reference = { messageId: 'message', artifactHash: 'hash' }
  expect(findReferencedDelivery([message], 'task', reference)).toEqual(item)
  expect(findReferencedDelivery([message], undefined, reference)).toBeUndefined()
  message.delivery!.items.push({ ...item, stepKey: 'b' })
  expect(findReferencedDelivery([message], 'task', reference)).toBeUndefined()
  expect(findReferencedDelivery([message], 'task', { ...reference, stepKey: 'b' })?.stepKey).toBe('b')
})
