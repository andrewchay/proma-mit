/**
 * ModeSwitcher - Agent / Workflow / Chat 三模式切换（带滑动指示器）
 *
 * - Agent / Chat 切换会恢复上次会话并进入 conversations 视图
 * - Workflow 切换进入 workflow 工作台视图
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { appModeAtom, type AppMode } from '@/atoms/app-mode'
import { activeViewAtom } from '@/atoms/active-view'
import { conversationsAtom, currentConversationIdAtom } from '@/atoms/chat-atoms'
import { agentSessionsAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { tabsAtom } from '@/atoms/tab-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { cn } from '@/lib/utils'

type SwitchMode = 'agent' | 'workflow' | 'chat'

const MODES: { value: SwitchMode; label: string }[] = [
  { value: 'agent', label: '智能体' },
  { value: 'workflow', label: '工作流' },
  { value: 'chat', label: '聊天' },
]

/** 滑动指示器位置：三等分 */
const SLIDER_POSITIONS: Record<SwitchMode, string> = {
  agent: 'translate-x-0',
  workflow: 'translate-x-full',
  chat: 'translate-x-[200%]',
}

export function ModeSwitcher(): React.ReactElement {
  const [mode, setMode] = useAtom(appModeAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const activeView = useAtomValue(activeViewAtom)
  const openSession = useOpenSession()
  const conversations = useAtomValue(conversationsAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const currentConversationId = useAtomValue(currentConversationIdAtom)
  const currentAgentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const tabs = useAtomValue(tabsAtom)

  /** 当前激活的模式（activeView === 'workflow' 时为 workflow，否则取 appMode） */
  const activeMode: SwitchMode = activeView === 'workflow' ? 'workflow' : (mode as SwitchMode)

  /** 恢复 Agent/Chat 模式下的上次会话 */
  const restoreSession = React.useCallback((targetMode: AppMode) => {
    const isChatMode = targetMode === 'chat'
    const sessions = isChatMode ? conversations : agentSessions
    const lastId = isChatMode ? currentConversationId : currentAgentSessionId

    if (lastId) {
      const match = sessions.find((s) => s.id === lastId)
      if (match) {
        openSession(targetMode, match.id, match.title)
        return
      }
    }
    const tab = tabs.find((t) => t.type === targetMode)
    if (tab) {
      openSession(targetMode, tab.sessionId, tab.title)
      return
    }
    const recent = sessions.find((s) => !s.archived)
    if (recent) {
      openSession(targetMode, recent.id, recent.title)
      return
    }
    setMode(targetMode)
  }, [openSession, conversations, agentSessions, currentConversationId, currentAgentSessionId, tabs, setMode])

  const handleSwitch = React.useCallback((target: SwitchMode) => {
    if (target === activeMode) return
    if (target === 'workflow') {
      setActiveView('workflow')
      return
    }
    // 切到 Agent/Chat 时回到 conversations 视图
    setActiveView('conversations')
    restoreSession(target)
  }, [activeMode, setActiveView, restoreSession])

  return (
    <div className="pt-2 titlebar-drag-region select-none">
      <div className="relative flex rounded-xl bg-muted p-1 titlebar-drag-region">
        {/* 滑动背景指示器：三等分宽度 */}
        <div
          className={cn(
            'mode-slider pointer-events-none absolute top-1 bottom-1 w-[calc((100%-8px)/3)] rounded-lg bg-background shadow-sm transition-transform duration-300 ease-in-out',
            SLIDER_POSITIONS[activeMode]
          )}
        />
        {MODES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => handleSwitch(value)}
            className={cn(
              'mode-btn titlebar-no-drag relative z-[1] flex h-7 flex-1 items-center justify-center rounded-lg px-1 py-0 text-[12px] font-medium transition-all duration-200 select-none',
              activeMode === value
                ? 'mode-btn-selected text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
