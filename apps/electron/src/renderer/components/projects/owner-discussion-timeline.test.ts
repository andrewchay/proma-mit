import { expect, test } from 'bun:test'
import type { OwnerExecutionGrant, OwnerManagementMessage, ProjectOwnerPlanDraft } from '@gravitas/shared'
import { ownerDiscussionTimeline } from './owner-discussion-timeline'

test('Given 对话和方案授权账本 When 合并讨论记录 Then 按时间排序且同一版本不重复', () => {
  const messages = [{ id: 'before', createdAt: 10 }, { id: 'after', createdAt: 40 }] as OwnerManagementMessage[]
  const oldPlan = { revision: 1, state: 'confirmed', savedAt: 20 } as ProjectOwnerPlanDraft
  const draft = { revision: 2, state: 'proposed', savedAt: 21 } as ProjectOwnerPlanDraft
  const grant = { grantId: 'g', issuedAt: 30, state: 'active' } as OwnerExecutionGrant
  const result = ownerDiscussionTimeline(messages, [oldPlan, draft], oldPlan, [grant], { ...grant, state: 'paused' })
  expect(result.map(entry => [entry.kind, entry.at])).toEqual([['message', 10], ['plan', 20], ['grant', 30], ['message', 40]])
  expect(result[2]).toMatchObject({ grant: { state: 'paused' } })
  const stale = { ...oldPlan, state: 'stale' as const }
  expect(ownerDiscussionTimeline([], [oldPlan], stale, [], null)).toMatchObject([{ kind: 'plan', plan: { state: 'confirmed' } }])
  const revoked = { ...grant, state: 'paused' as const, revokedAt: 35 }
  expect(ownerDiscussionTimeline(messages, [], null, [revoked], { ...grant, state: 'paused' }).map(entry => [entry.kind, entry.at])).toEqual([['message', 10], ['grant', 30], ['grant_revoked', 35], ['message', 40]])
})
