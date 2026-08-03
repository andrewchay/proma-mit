/**
 * useOpenSession — 统一的"打开/聚焦会话 Tab"操作
 *
 * 封装 openTab + setTabs + setActiveTabId + setAppMode + setCurrentXxxId，
 * 确保所有打开会话的入口都能正确同步 appMode 和 currentSessionId。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { tabsAtom, activeTabIdAtom, openTabPreview, openTabPermanent, type TabType } from '@/atoms/tab-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { currentConversationIdAtom } from '@/atoms/chat-atoms'
import {
  currentAgentSessionIdAtom,
  agentSessionsAtom,
  currentAgentWorkspaceIdAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'

type OpenSessionFn = (type: TabType, sessionId: string, title: string) => void

export interface OpenSessionActions {
  /** 以临时预览标签打开（单击，斜体，打开其他会话时自动替换） */
  openSessionPreview: OpenSessionFn
  /** 以常驻标签打开（双击，正体，需要手动关闭） */
  openSessionPermanent: OpenSessionFn
  /** 以常驻标签打开（默认行为，兼容现有调用方） */
  openSession: OpenSessionFn
}

export function useOpenSession(): OpenSessionActions {
  const [tabs, setTabs] = useAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setCurrentConversationId = useSetAtom(currentConversationIdAtom)
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)

  const activateSession = React.useCallback(
    (type: TabType, sessionId: string): void => {
      setAppMode(type)

      if (type === 'chat') {
        setCurrentConversationId(sessionId)
      } else {
        setCurrentAgentSessionId(sessionId)

        // 清除该会话的"已完成未查看"标记，与 TabBar.handleActivate 保持一致
        setUnviewedCompleted((prev) => {
          if (!prev.has(sessionId)) return prev
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })

        // 同步 workspaceId，确保与 TabBar 切换行为一致
        const session = agentSessions.find((s) => s.id === sessionId)
        if (session?.workspaceId) {
          setCurrentAgentWorkspaceId(session.workspaceId)
          window.electronAPI.updateSettings({
            agentWorkspaceId: session.workspaceId,
          }).catch(console.error)
        }
      }
    },
    [setAppMode, setCurrentConversationId, setCurrentAgentSessionId, agentSessions, setCurrentAgentWorkspaceId, setUnviewedCompleted],
  )

  const openSession = React.useCallback<OpenSessionFn>(
    (type, sessionId, title) => {
      const result = openTabPermanent(tabs, { type, sessionId, title })
      setTabs(result.tabs)
      setActiveTabId(result.activeTabId)
      activateSession(type, sessionId)
    },
    [tabs, setTabs, setActiveTabId, activateSession],
  )

  const openSessionPreview = React.useCallback<OpenSessionFn>(
    (type, sessionId, title) => {
      const result = openTabPreview(tabs, { type, sessionId, title })
      setTabs(result.tabs)
      setActiveTabId(result.activeTabId)
      activateSession(type, sessionId)
    },
    [tabs, setTabs, setActiveTabId, activateSession],
  )

  const openSessionPermanent = React.useCallback<OpenSessionFn>(
    (type, sessionId, title) => {
      const result = openTabPermanent(tabs, { type, sessionId, title })
      setTabs(result.tabs)
      setActiveTabId(result.activeTabId)
      activateSession(type, sessionId)
    },
    [tabs, setTabs, setActiveTabId, activateSession],
  )

  return { openSessionPreview, openSessionPermanent, openSession }
}
