/**
 * useOpenSession — 统一的"打开/聚焦会话"操作
 *
 * 主区只渲染一个会话，因此这里只做一件事：把选中的会话写入渲染状态
 * （appMode + currentConversationId / currentAgentSessionId），并同步
 * 该会话的副作用（清未读完成标记、切换工作区）。
 *
 * 历史背景：此前的实现基于多标签模型（openTab + setTabs + setActiveTabId），
 * 三个入口分别对应"临时预览 / 常驻 / 默认"。标签模型移除后语义合并，
 * 但为了不改动十余个调用点，三个函数名保留为同一实现的别名。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { currentConversationIdAtom } from '@/atoms/chat-atoms'
import { scratchPadOpenAtom } from '@/atoms/scratch-pad'
import {
  currentAgentSessionIdAtom,
  agentSessionsAtom,
  currentAgentWorkspaceIdAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'

/** 会话类型。保留旧名以兼容既有调用点。 */
export type TabType = 'chat' | 'agent'

type OpenSessionFn = (type: TabType, sessionId: string, title?: string) => void

export interface OpenSessionActions {
  /** 打开会话（原"临时预览"语义，现与 openSession 等价） */
  openSessionPreview: OpenSessionFn
  /** 打开会话（原"常驻标签"语义，现与 openSession 等价） */
  openSessionPermanent: OpenSessionFn
  /** 打开会话（默认行为） */
  openSession: OpenSessionFn
}

export function useOpenSession(): OpenSessionActions {
  const setAppMode = useSetAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setCurrentConversationId = useSetAtom(currentConversationIdAtom)
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  const setScratchPadOpen = useSetAtom(scratchPadOpenAtom)

  const openSession = React.useCallback<OpenSessionFn>(
    (type, sessionId) => {
      setAppMode(type)
      // Proactive Center 等是独立主视图；打开会话时必须切回会话主视图，
      // 否则 activeView 仍停在别的模块，MainArea 会继续遮住刚打开的会话。
      setActiveView('conversations')
      // 便签同样是主区视图，打开会话时让位
      setScratchPadOpen(false)

      if (type === 'chat') {
        setCurrentConversationId(sessionId)
        return
      }

      setCurrentAgentSessionId(sessionId)

      // 清除该会话的"已完成未查看"标记
      setUnviewedCompleted((prev) => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })

      // 同步 workspaceId，保证侧边栏列表与主区一致
      const session = agentSessions.find((s) => s.id === sessionId)
      if (session?.workspaceId) {
        setCurrentAgentWorkspaceId(session.workspaceId)
        window.electronAPI.updateSettings({
          agentWorkspaceId: session.workspaceId,
        }).catch(console.error)
      }
    },
    [
      setAppMode,
      setActiveView,
      setScratchPadOpen,
      setCurrentConversationId,
      setCurrentAgentSessionId,
      agentSessions,
      setCurrentAgentWorkspaceId,
      setUnviewedCompleted,
    ],
  )

  return {
    openSession,
    openSessionPreview: openSession,
    openSessionPermanent: openSession,
  }
}
