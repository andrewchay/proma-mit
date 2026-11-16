/**
 * openSessionInStore — 非 Hook 环境下切换当前会话
 *
 * 主区只渲染一个会话，所以"打开会话"就是写三个 atom：
 * appMode、activeView、currentConversationId / currentAgentSessionId。
 *
 * 供 store 级别的调用方使用（全局事件监听器、store.get 场景）。
 * React 组件内优先用 useOpenSession，它还会同步未读标记和工作区。
 */

import type { createStore } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { currentConversationIdAtom } from '@/atoms/chat-atoms'
import { scratchPadOpenAtom } from '@/atoms/scratch-pad'
import {
  agentSessionsAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'

export interface OpenSessionInput {
  type: 'chat' | 'agent'
  sessionId: string
  /** 是否顺带同步工作区（默认 true，与 useOpenSession 行为一致） */
  syncWorkspace?: boolean
}

export function openSessionInStore(store: ReturnType<typeof createStore>, input: OpenSessionInput): void {
  const { type, sessionId, syncWorkspace = true } = input

  store.set(appModeAtom, type)
  store.set(activeViewAtom, 'conversations')
  store.set(scratchPadOpenAtom, false)

  if (type === 'chat') {
    store.set(currentConversationIdAtom, sessionId)
    return
  }

  store.set(currentAgentSessionIdAtom, sessionId)

  // 清除"已完成未查看"标记
  const unviewed = store.get(unviewedCompletedSessionIdsAtom)
  if (unviewed.has(sessionId)) {
    const next = new Set(unviewed)
    next.delete(sessionId)
    store.set(unviewedCompletedSessionIdsAtom, next)
  }

  if (!syncWorkspace) return
  const session = store.get(agentSessionsAtom).find((s) => s.id === sessionId)
  if (session?.workspaceId) {
    store.set(currentAgentWorkspaceIdAtom, session.workspaceId)
    window.electronAPI.updateSettings({
      agentWorkspaceId: session.workspaceId,
    }).catch(console.error)
  }
}
