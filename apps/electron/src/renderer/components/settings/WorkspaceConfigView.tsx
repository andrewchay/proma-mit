/**
 * WorkspaceConfigView — 工作空间配置（右侧主区独立页面）
 *
 * 与其它工作模块保持一致：点击侧边栏入口后在主内容区打开独立页面，而不是弹出设置弹窗。
 * 主体直接复用设置面板里的 AgentSettings，保证 Skills / MCP / 内置工具 / 配置快照 / 评测
 * 的能力与设置弹窗完全一致，避免两套实现漂移。
 *
 * 顶部返回栏位于全局 50px 窗口拖拽区内，因此显式声明 titlebar-no-drag。
 */

import type * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ArrowLeft, Bot } from 'lucide-react'
import { activeViewAtom } from '@/atoms/active-view'
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AgentSettings } from './AgentSettings'

export function WorkspaceConfigView(): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 flex-shrink-0 titlebar-no-drag">
        <button
          onClick={() => setActiveView('conversations')}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[13px] text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/85 transition-colors"
        >
          <ArrowLeft size={15} />
          返回对话
        </button>
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground/75">
          <Bot size={15} className="text-foreground/45" />
          工作空间配置
        </div>
        {currentWorkspace && (
          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-foreground/55">
            {currentWorkspace.name}
          </span>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="px-6 py-4">
          <AgentSettings />
        </div>
      </ScrollArea>
    </div>
  )
}
