/**
 * 主进程系统通知类型（P0-3a）。
 *
 * renderer 的桌面通知委托给主进程 Electron Notification 发送，
 * 解决「窗口未聚焦时 Web Notification 不可靠」问题；
 * 点击事件由主进程回传给 renderer（保留导航回调能力）。
 */

/** 通知场景类型（与 renderer 音效选择一致） */
export type SystemNotificationSoundType = 'taskComplete' | 'permissionRequest' | 'exitPlanMode'

/** 发送系统通知请求 */
export interface SystemNotificationInput {
  title: string
  body?: string
  /** 是否强制弹出（无视窗口焦点） */
  force?: boolean
  /** 点击后导航到会话（可选） */
  sessionId?: string
  /** 点击后的标题（用于导航） */
  sessionTitle?: string
  /** 自定义点击回调标识（renderer 侧通过 onSystemNotificationClicked 匹配） */
  callbackId?: string
}

/** 点击事件 payload（主进程 → renderer） */
export interface SystemNotificationClickedPayload {
  callbackId?: string
  sessionId?: string
  sessionTitle?: string
}

/** IPC 通道 */
export const SYSTEM_NOTIFICATION_IPC_CHANNELS = {
  /** renderer → main：发送系统通知 */
  NOTIFY: 'system-notification:notify',
  /** main → renderer：用户点击系统通知 */
  CLICKED: 'system-notification:clicked',
} as const
