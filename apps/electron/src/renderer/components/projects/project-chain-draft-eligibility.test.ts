import { expect, test } from 'bun:test'
import { canGuideDeliverableDraft, canLocalUserDraftDeliverable } from './project-chain-draft-eligibility.ts'

test('本机用户只能为自己负责的任务创建或修订交付草案', () => {
  expect(canLocalUserDraftDeliverable('local-user')).toBe(true)
  expect(canLocalUserDraftDeliverable('agent-123')).toBe(false)
  expect(canLocalUserDraftDeliverable(undefined)).toBe(false)
})

test('只有已拍板决策可以关联到交付草案', () => {
  expect(canGuideDeliverableDraft('decided')).toBe(true)
  expect(canGuideDeliverableDraft('candidate')).toBe(false)
  expect(canGuideDeliverableDraft('superseded')).toBe(false)
})
