import { describe, expect, test } from 'bun:test'
import type { AppEventEnvelope } from '@proma/shared'
import { toSystemNotification, soundForEvent } from './notification-policy'

function makeEvent(partial: Partial<AppEventEnvelope> & { type: AppEventEnvelope['type'] }): AppEventEnvelope {
  const base = {
    id: 'evt-1',
    source: 'agent' as const,
    taskId: 's1',
    title: '会话',
    sessionId: 's1',
    timestamp: Date.now(),
  }
  return { ...base, ...partial } as AppEventEnvelope
}

describe('toSystemNotification 路由策略', () => {
  test('waiting_action(permission) → force 系统通知 + sessionId', () => {
    const event = makeEvent({ type: 'waiting_action', actionKind: 'permission', detail: '等待权限确认' })
    const out = toSystemNotification(event)
    expect(out).not.toBeNull()
    expect(out?.force).toBe(true)
    expect(out?.sessionId).toBe('s1')
  })

  test('completed → 系统通知（非 force）', () => {
    const event = makeEvent({ type: 'completed', detail: '任务已完成' })
    const out = toSystemNotification(event)
    expect(out?.force).toBeUndefined()
    expect(out?.body).toBe('任务已完成')
  })

  test('failed → 系统通知', () => {
    const event = makeEvent({ type: 'failed', detail: '网络错误' })
    const out = toSystemNotification(event)
    expect(out?.body).toBe('网络错误')
  })

  test('started/progress → null（不打扰）', () => {
    expect(toSystemNotification(makeEvent({ type: 'started' }))).toBeNull()
    expect(toSystemNotification(makeEvent({ type: 'progress', detail: '正在执行' }))).toBeNull()
  })
})

describe('soundForEvent 提示音映射', () => {
  test('plan_review → exitPlanMode；其他 waiting → permissionRequest', () => {
    expect(soundForEvent(makeEvent({ type: 'waiting_action', actionKind: 'plan_review', detail: '' }))).toBe('exitPlanMode')
    expect(soundForEvent(makeEvent({ type: 'waiting_action', actionKind: 'permission', detail: '' }))).toBe('permissionRequest')
  })

  test('completed → taskComplete；failed → 通用提示音；started/progress → null', () => {
    expect(soundForEvent(makeEvent({ type: 'completed' }))).toBe('taskComplete')
    expect(soundForEvent(makeEvent({ type: 'failed', detail: '' }))).toBe('permissionRequest')
    expect(soundForEvent(makeEvent({ type: 'started' }))).toBeNull()
  })
})
