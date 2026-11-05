import { expect, test } from 'bun:test'
import type { OwnerManagementMessage } from '@gravitas/shared'
import { getOwnerWaitingLabel, hasCompletedOwnerDelivery, isOwnerWaitingForUser } from './project-owner-progress-state'

function message(kind: OwnerManagementMessage['kind'], role: OwnerManagementMessage['role'] = 'assistant', taskId?: string): OwnerManagementMessage {
  return { id: kind, projectId: 'project', conversationId: 'conversation', eventId: kind, role, kind, content: kind, createdAt: 1, ...(taskId ? { taskId } : {}) }
}

test('Given Owner最新消息是阻塞或配置请求 When 显示项目进度 Then 标记为等待用户决定', () => {
  expect(isOwnerWaitingForUser([message('management_progress'), message('attention')])).toBe(true)
  expect(isOwnerWaitingForUser([message('configuration_required')])).toBe(true)
})

test('Given Owner在阻塞后已继续推进 When 显示项目进度 Then 不保留过期的暂停状态', () => {
  expect(isOwnerWaitingForUser([message('attention'), message('management_progress')])).toBe(false)
})

test('Given 用户已回复但Owner尚未回应 When 显示项目进度 Then 仍提示等待处理', () => {
  expect(isOwnerWaitingForUser([message('attention'), message('conversation', 'user')])).toBe(true)
})

test('Given Owner已在阻塞后回复 When 显示项目进度 Then 清除旧的等待状态', () => {
  expect(isOwnerWaitingForUser([message('attention'), message('reply')])).toBe(false)
})

test('Given Owner提出澄清问题或新方案 When 显示项目进度 Then 标记为等待用户审阅', () => {
  expect(isOwnerWaitingForUser([message('clarification')])).toBe(true)
  expect(isOwnerWaitingForUser([message('change_proposal')])).toBe(true)
  expect(isOwnerWaitingForUser([message('execution_arranged')])).toBe(true)
})

test('Given Owner等待用户处理 When 显示对话进度 Then 标签说明具体下一步', () => {
  expect(getOwnerWaitingLabel([message('attention')], undefined, 'stale')).toBe('授权范围需要重新确认')
  expect(getOwnerWaitingLabel([message('attention')])).toBe('Owner 提出需要关注的事项')
  expect(getOwnerWaitingLabel([message('plan_proposal')])).toBe('方案待你审阅')
  expect(getOwnerWaitingLabel([message('clarification')])).toBe('需要补充必要信息')
  expect(getOwnerWaitingLabel([message('management_progress')])).toBeNull()
})

test('Given 同一项目的不同任务有不同状态 When 加载某个任务进度 Then 只使用该任务自己的Owner消息', () => {
  const messages = [message('attention', 'assistant', 'task-a'), message('management_progress', 'assistant', 'task-b')]
  expect(isOwnerWaitingForUser(messages, 'task-a')).toBe(true)
  expect(isOwnerWaitingForUser(messages, 'task-b')).toBe(false)
  expect(isOwnerWaitingForUser([message('attention', 'assistant', 'task-a')])).toBe(false)
})

test('Given成果交付 When匹配当前授权与方案 Then仅全部命令结算后显示完成', () => {
  const delivery: OwnerManagementMessage = { ...message('delivery'), eventId: 'owner-delivery:grant:hash', delivery: { schemaVersion: 1, planVersion: 2, items: [] } }
  const commands = [{ grantId: 'grant', state: 'settled' as const }]
  expect(hasCompletedOwnerDelivery([delivery], commands, undefined, 2, 'grant')).toBe(true)
  expect(hasCompletedOwnerDelivery([delivery], commands, undefined, 3, 'grant')).toBe(false)
  expect(hasCompletedOwnerDelivery([delivery], commands, undefined, 2, 'other')).toBe(false)
  expect(hasCompletedOwnerDelivery([delivery], [...commands, { grantId: 'grant', state: 'running' }], undefined, 2, 'grant')).toBe(false)
})
