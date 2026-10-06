/**
 * 出海 Sourcing 邮件 IPC 处理器注册
 *
 * 从 ipc.ts 分离：邮件通道数量多且自成体系，独立注册便于维护。
 * 密码明文只在 SAVE_CONFIG 请求体内短暂存在，不落日志、不回传。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { OUTBOUND_MAIL_IPC_CHANNELS } from '@gravitas/shared'
import type {
  OutboundInboxQuery,
  OutboundMailTestResult,
  OutboundMailboxConfigView,
  OutboundOutboxItem,
  OutboundSyncResult,
} from '@gravitas/shared'
import {
  getMailboxConfigView,
  saveMailboxConfig,
  testMailboxConnection,
} from './mailbox-config-service'
import {
  listInbox,
  setSyncInterval,
  syncInboxNow,
} from './mail-sync-service'
import {
  approveAndSend,
  getMailStatus,
  loadOutboxItems,
  queueEmail,
  rejectEmail,
} from './mail-send-service'
import { computeOutreachMetrics } from './outreach-metrics-service'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerOutboundMailIpcHandlers(): void {
  // ===== 账户配置 =====
  ipcMain.handle(OUTBOUND_MAIL_IPC_CHANNELS.GET_CONFIG, (): OutboundMailboxConfigView | null => {
    return getMailboxConfigView()
  })

  ipcMain.handle(
    OUTBOUND_MAIL_IPC_CHANNELS.SAVE_CONFIG,
    async (_event, input: Parameters<typeof saveMailboxConfig>[0]): Promise<OutboundMailboxConfigView> => {
      const view = saveMailboxConfig(input)
      setSyncInterval(view.syncIntervalMinutes)
      return view
    },
  )

  ipcMain.handle(OUTBOUND_MAIL_IPC_CHANNELS.TEST_CONNECTION, async (): Promise<OutboundMailTestResult> => {
    return testMailboxConnection()
  })

  // ===== 收件箱 =====
  ipcMain.handle(OUTBOUND_MAIL_IPC_CHANNELS.LIST_INBOX, (_event, query: OutboundInboxQuery | undefined) => {
    return listInbox(query ?? {})
  })

  ipcMain.handle(OUTBOUND_MAIL_IPC_CHANNELS.SYNC_NOW, async (): Promise<OutboundSyncResult> => {
    const result = await syncInboxNow()
    broadcast(OUTBOUND_MAIL_IPC_CHANNELS.ON_SYNCED, result)
    return result
  })

  // ===== 待发队列 =====
  ipcMain.handle(OUTBOUND_MAIL_IPC_CHANNELS.LIST_OUTBOX, (): OutboundOutboxItem[] => {
    return loadOutboxItems()
  })

  ipcMain.handle(
    OUTBOUND_MAIL_IPC_CHANNELS.QUEUE_EMAIL,
    (_event, input: { to: string; subject: string; body: string; inReplyTo?: string | null; references?: string[]; source?: 'agent' | 'manual'; replyToInboxId?: string | null }): OutboundOutboxItem => {
      const item = queueEmail(input)
      broadcast(OUTBOUND_MAIL_IPC_CHANNELS.ON_OUTBOX_CHANGED, { id: item.id, status: item.status })
      return item
    },
  )

  ipcMain.handle(
    OUTBOUND_MAIL_IPC_CHANNELS.APPROVE_SEND,
    async (_event, input: { id: string; edited?: { to?: string; subject?: string; body?: string } }): Promise<OutboundOutboxItem> => {
      const item = await approveAndSend(input.id, input.edited)
      broadcast(OUTBOUND_MAIL_IPC_CHANNELS.ON_OUTBOX_CHANGED, { id: item.id, status: item.status })
      return item
    },
  )

  ipcMain.handle(
    OUTBOUND_MAIL_IPC_CHANNELS.REJECT_EMAIL,
    (_event, input: { id: string; note?: string }): OutboundOutboxItem => {
      const item = rejectEmail(input.id, input.note)
      broadcast(OUTBOUND_MAIL_IPC_CHANNELS.ON_OUTBOX_CHANGED, { id: item.id, status: item.status })
      return item
    },
  )

  // ===== 漏斗指标 =====
  ipcMain.handle(OUTBOUND_MAIL_IPC_CHANNELS.GET_METRICS, () => {
    return computeOutreachMetrics()
  })
}

/** 供 Agent 工具（execute.ts 运行于主进程）使用的内部查询入口 */
export function getOutboundMailStatusForAgent(query: { companyEmail?: string; threadMailId?: string }) {
  return getMailStatus(query)
}

/** 启动时恢复定时同步（配置已开启时） */
export function restoreOutboundMailSchedule(): void {
  try {
    const view = getMailboxConfigView()
    if (view?.syncIntervalMinutes) setSyncInterval(view.syncIntervalMinutes)
  } catch (error) {
    console.warn('[出海邮件] 恢复定时同步失败:', error)
  }
}
