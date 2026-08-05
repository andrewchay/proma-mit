/**
 * SystemNotificationService — 主进程系统通知服务（P0-3a）。
 *
 * 用 Electron Notification 发送系统级通知（窗口未聚焦/后台也可靠），
 * 点击事件回传给 renderer（保留原有导航回调能力）。
 * 提示音仍由 renderer 播放（音频资源在 renderer），本服务只管系统通知。
 */

import { Notification, BrowserWindow, app } from 'electron'
import { ipcMain } from 'electron'
import { SYSTEM_NOTIFICATION_IPC_CHANNELS } from '@gravitas/shared'
import type { SystemNotificationInput, SystemNotificationClickedPayload } from '@gravitas/shared'

/** 发送系统通知；返回是否真正弹出 */
export function sendSystemNotification(input: SystemNotificationInput): boolean {
  if (!Notification.isSupported()) return false
  if (!input.force && BrowserWindow.getFocusedWindow()) {
    // 窗口聚焦时无需系统通知（renderer 侧可自行处理；此处由调用方决定 force）
    return false
  }

  const notification = new Notification({
    title: input.title,
    body: input.body ?? '',
    silent: true, // 提示音由 renderer 播放，避免双音
  })

  notification.on('click', () => {
    // macOS 点击通知默认会唤起应用；主动聚焦主窗口
    if (process.platform === 'darwin') app.show()
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
    if (win) {
      win.show()
      win.focus()
    }

    // 回传点击事件给 renderer（保留导航/自定义回调）
    const payload: SystemNotificationClickedPayload = {
      ...(input.callbackId ? { callbackId: input.callbackId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.sessionTitle ? { sessionTitle: input.sessionTitle } : {}),
    }
    const target = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (target && !target.webContents.isDestroyed()) {
      target.webContents.send(SYSTEM_NOTIFICATION_IPC_CHANNELS.CLICKED, payload)
    }
  })

  notification.show()
  return true
}

/** 注册 IPC handler */
export function registerSystemNotificationIpc(): void {
  ipcMain.handle(
    SYSTEM_NOTIFICATION_IPC_CHANNELS.NOTIFY,
    async (_event, input: SystemNotificationInput): Promise<boolean> => {
      return sendSystemNotification(input)
    },
  )
}
