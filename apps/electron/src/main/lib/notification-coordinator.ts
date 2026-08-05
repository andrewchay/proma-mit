/**
 * NotificationCoordinator — 主进程通知协调器（P0-3 第二步）。
 *
 * 订阅统一任务事件（AppEventEnvelope），按策略路由：
 * - waiting_action（权限/提问/计划审批）→ 系统通知（force）+ 播放对应提示音
 * - completed（任务完成）→ 系统通知 + taskComplete 提示音
 * - failed（任务失败）→ 系统通知 + 提示音
 *
 * 提示音由 renderer 播放（音频资源在 renderer），通过 IPC 触发；
 * 点击导航通过 SystemNotificationService 回传 renderer。
 * renderer 的请求入队（pendingPermissionRequests 等 UI 状态）保持不动。
 */

import { BrowserWindow } from 'electron'
import type { SystemNotificationInput } from '@gravitas/shared'
import { sendSystemNotification } from './system-notification-service'
import { getAppEventBus } from './app-event-bus'
import { getSettings } from './settings-service'
import { toSystemNotification, soundForEvent } from './notification-policy'

/** renderer 提示音通道（复用系统通知点击通道前缀） */
const PLAY_SOUND_IPC_CHANNEL = 'system-notification:play-sound'

/** 通知 renderer 播放提示音（若窗口存在） */
function notifyRendererPlaySound(soundType: string): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.isDestroyed())
  if (win) {
    win.webContents.send(PLAY_SOUND_IPC_CHANNEL, { soundType })
  }
}

class NotificationCoordinator {
  private unsubscribe: (() => void) | null = null
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = getAppEventBus().on((event) => {
      // 全局通知开关（settings）
      const settings = getSettings()
      if (settings.notificationsEnabled === false) return

      // 灵动岛启用（mac + 开关）且事件来自 Agent 时，灵动岛浮层已展示，
      // 不再发系统通知避免双通知；Workflow/Automation 等仍走系统通知。
      const { isDynamicIslandPrimary } = require('./dynamic-island/dynamic-island-service') as { isDynamicIslandPrimary: () => boolean }
      const islandPrimary = event.source === 'agent' && isDynamicIslandPrimary()

      const input = toSystemNotification(event)
      if (input && !islandPrimary) {
        sendSystemNotification(input)
      }

      const soundType = soundForEvent(event)
      if (soundType) {
        notifyRendererPlaySound(soundType)
      }
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.started = false
  }
}

/** 单例 */
let coordinator: NotificationCoordinator | null = null

export function getNotificationCoordinator(): NotificationCoordinator {
  coordinator ??= new NotificationCoordinator()
  return coordinator
}

export function startNotificationCoordinator(): void {
  getNotificationCoordinator().start()
}

export function stopNotificationCoordinator(): void {
  coordinator?.stop()
  coordinator = null
}

export { PLAY_SOUND_IPC_CHANNEL }
