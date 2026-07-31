/**
 * 通知策略纯函数（P0-3）—— 无 electron 依赖，可单测。
 */

import type { AppEventEnvelope, SystemNotificationInput } from '@proma/shared'

/** waiting_action 类型 → 提示音场景 */
export function soundForActionKind(kind: string): 'permissionRequest' | 'exitPlanMode' {
  return kind === 'plan_review' ? 'exitPlanMode' : 'permissionRequest'
}

/** 事件 → 系统通知输入；返回 null 表示不通知（started/progress 不打扰） */
export function toSystemNotification(event: AppEventEnvelope): SystemNotificationInput | null {
  switch (event.type) {
    case 'waiting_action': {
      return {
        title: event.title,
        body: event.detail,
        force: true,
        sessionId: event.sessionId,
        sessionTitle: event.title,
      }
    }
    case 'completed':
      return {
        title: event.title,
        body: event.detail ?? '任务已完成',
        sessionId: event.sessionId,
        sessionTitle: event.title,
      }
    case 'failed':
      return {
        title: event.title,
        body: event.detail,
        sessionId: event.sessionId,
        sessionTitle: event.title,
      }
    default:
      return null
  }
}

/** 通知事件对应的提示音场景；返回 null 不播音 */
export function soundForEvent(event: AppEventEnvelope): string | null {
  switch (event.type) {
    case 'waiting_action':
      return soundForActionKind(event.actionKind)
    case 'completed':
      return 'taskComplete'
    case 'failed':
      return 'permissionRequest' // 用通用提示音
    default:
      return null
  }
}
