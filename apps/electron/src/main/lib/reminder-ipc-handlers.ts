/**
 * 智能提醒系统 IPC 处理器
 *
 * 桥接渲染进程的提醒 UI 到主进程服务层。
 */

import { ipcMain } from 'electron'
import {
  checkReminders,
  getActiveReminders,
  dismissReminder,
  markReminderPushed,
  checkConflictForEvent,
  getReminderStats,
  startReminderScan,
  stopReminderScan,
} from './reminder-service'

export const REMINDER_IPC_CHANNELS = {
  CHECK_NOW: 'reminder:check-now',
  GET_ACTIVE: 'reminder:get-active',
  DISMISS: 'reminder:dismiss',
  MARK_PUSHED: 'reminder:mark-pushed',
  CHECK_CONFLICT: 'reminder:check-conflict',
  GET_STATS: 'reminder:get-stats',
  START_SCAN: 'reminder:start-scan',
  STOP_SCAN: 'reminder:stop-scan',
} as const

export function registerReminderIpcHandlers(): void {
  // 手动触发检查
  ipcMain.handle(REMINDER_IPC_CHANNELS.CHECK_NOW, () => {
    return checkReminders()
  })

  // 获取未处理提醒
  ipcMain.handle(REMINDER_IPC_CHANNELS.GET_ACTIVE, () => {
    return getActiveReminders()
  })

  // 标记已处理
  ipcMain.handle(REMINDER_IPC_CHANNELS.DISMISS, (_, id: string) => {
    return dismissReminder(id)
  })

  // 标记已推送
  ipcMain.handle(REMINDER_IPC_CHANNELS.MARK_PUSHED, (_, id: string) => {
    return markReminderPushed(id)
  })

  // 检测日程冲突
  ipcMain.handle(REMINDER_IPC_CHANNELS.CHECK_CONFLICT, (_, event: { startTime: string; endTime: string; id?: string }) => {
    return checkConflictForEvent(event)
  })

  // 获取统计
  ipcMain.handle(REMINDER_IPC_CHANNELS.GET_STATS, () => {
    return getReminderStats()
  })

  // 启动/停止扫描
  ipcMain.handle(REMINDER_IPC_CHANNELS.START_SCAN, () => {
    startReminderScan()
    return { success: true }
  })

  ipcMain.handle(REMINDER_IPC_CHANNELS.STOP_SCAN, () => {
    stopReminderScan()
    return { success: true }
  })

  console.log('[提醒系统] IPC 处理器已注册')
}
