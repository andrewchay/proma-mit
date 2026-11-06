import { expect, test } from 'bun:test'
import type { OwnerManagementMessage } from '@gravitas/shared'
import { findLatestDeliveryReview, findReferencedDelivery } from './owner-delivery-reference'

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

test('Given 旧审阅引用没有步骤 When 成果唯一或有歧义 Then 只显示可唯一关联的审阅', () => {
  const item = { stepKey: 'a', artifactHash: 'hash', title: '设计', content: '', acceptanceCriteria: [], ownerDecision: '', reviewerSummary: '' }
  const delivery: OwnerManagementMessage = { id: 'delivery', projectId: 'project', conversationId: 'c', eventId: 'delivery-event', taskId: 'task', role: 'assistant', kind: 'delivery', content: '', createdAt: 1, delivery: { schemaVersion: 1, planVersion: 1, items: [item] } }
  const review: OwnerManagementMessage = { id: 'review', projectId: 'project', conversationId: 'c', eventId: 'review-event', taskId: 'task', role: 'user', kind: 'conversation', content: '认可', createdAt: 2, deliveryReference: { messageId: 'delivery', artifactHash: 'hash' }, deliveryReviewDecision: 'accepted' }
  const selected = { messageId: 'delivery', artifactHash: 'hash', stepKey: 'a' }
  const deferred: OwnerManagementMessage = { ...review, id: 'deferred', deliveryReviewDecision: 'deferred' }
  expect(findLatestDeliveryReview([delivery, deferred], 'task', selected)).toBeUndefined()
  expect(findLatestDeliveryReview([delivery, review], 'task', selected)).toBe(review)
  delivery.delivery!.items.push({ ...item, stepKey: 'b' })
  expect(findLatestDeliveryReview([delivery, review], 'task', selected)).toBeUndefined()
})
