/**
 * CampaignList - Campaign 项目列表页 + 详情视图
 *
 * Slice 1: 展示所有 Campaign，支持创建新 Campaign。
 * Slice 2: 点击 Campaign 显示详情页（基本信息 + 三阶段进度）。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Bot, Target } from 'lucide-react'
import { campaignsAtom, campaignConversationMapAtom, currentCampaignIdAtom } from '@/atoms/campaign-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { conversationsAtom, chatPendingMessageAtom } from '@/atoms/chat-atoms'
import { agentWorkspacesAtom, currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { CampaignDetail } from './CampaignDetail'
import { AgentView } from './AgentView'
import { cn } from '@/lib/utils'
import type { AgentSessionMeta, AgentWorkspace, Campaign, Channel, ConversationMeta } from '@gravitas/shared'

type CampaignAssistantMode = 'agent' | 'chat'

export function CampaignList(): React.ReactElement {
  const [campaigns, setCampaigns] = useAtom(campaignsAtom)
  const [conversations, setConversations] = useAtom(conversationsAtom)
  const [campaignConversationMap, setCampaignConversationMap] = useAtom(campaignConversationMapAtom)
  const [, setAgentWorkspaces] = useAtom(agentWorkspacesAtom)
  const currentCampaignId = useAtomValue(currentCampaignIdAtom)
  const setCurrentCampaignId = useSetAtom(currentCampaignIdAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setChatPendingMessage = useSetAtom(chatPendingMessageAtom)
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom)
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const [loading, setLoading] = React.useState(true)
  const [selectedCampaign, setSelectedCampaign] = React.useState<Campaign | null>(null)
  const [agentSession, setAgentSession] = React.useState<AgentSessionMeta | null>(null)
  const [agentWorkspace, setAgentWorkspace] = React.useState<AgentWorkspace | null>(null)
  const [defaultChannel, setDefaultChannel] = React.useState<Channel | null>(null)
  const [assistantLoading, setAssistantLoading] = React.useState(false)

  React.useEffect(() => {
    window.electronAPI
      .listCampaigns()
      .then((list) => {
        setCampaigns(list)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [setCampaigns])

  // Slice 2: 当 currentCampaignId 变化时，获取详情
  React.useEffect(() => {
    if (!currentCampaignId) {
      setSelectedCampaign(null)
      return
    }
    // 先尝试从本地列表找
    const local = campaigns.find((c) => c.id === currentCampaignId)
    if (local) {
      setSelectedCampaign(local)
      return
    }
    // 否则从后端获取
    window.electronAPI
      .getCampaignById(currentCampaignId)
      .then((campaign) => {
        if (campaign) setSelectedCampaign(campaign)
      })
      .catch(console.error)
  }, [currentCampaignId, campaigns])

  const handleBack = () => {
    setCurrentCampaignId(null)
  }

  const ensureDefaultChannel = React.useCallback(async (): Promise<Channel | null> => {
    if (defaultChannel) return defaultChannel
    const channels = await window.electronAPI.listChannels()
    const channel = channels.find((item) => item.enabled) ?? null
    setDefaultChannel(channel)
    return channel
  }, [defaultChannel])

  const ensureCampaignAgent = React.useCallback(async (campaign: Campaign): Promise<{ session: AgentSessionMeta; workspace: AgentWorkspace; channel: Channel } | null> => {
    const channel = await ensureDefaultChannel()
    if (!channel) return null

    const workspaceSlug = `campaign-${campaign.id}`
    let workspaces = await window.electronAPI.listAgentWorkspaces()
    setAgentWorkspaces(workspaces)
    let workspace = workspaces.find((item) => item.slug === workspaceSlug)
    if (!workspace) {
      try {
        workspace = await window.electronAPI.createAgentWorkspace(campaign.name, workspaceSlug)
        setAgentWorkspaces((prev) => [workspace!, ...prev.filter((item) => item.id !== workspace!.id)])
      } catch (error) {
        // 可能是旧工作区同名或另一个窗口刚刚创建；重新拉取，优先找 campaign slug。
        console.warn('[CampaignList] 创建 Campaign 工作区失败，尝试复用已有工作区:', error)
        workspaces = await window.electronAPI.listAgentWorkspaces()
        setAgentWorkspaces(workspaces)
        workspace = workspaces.find((item) => item.slug === workspaceSlug)
          ?? workspaces.find((item) => item.name === campaign.name && item.slug.startsWith('campaign-'))
      }
    }
    if (!workspace) return null

    const sessions = await window.electronAPI.listAgentSessions()
    let session = sessions.find((item) => item.title === campaign.name && item.workspaceId === workspace!.id)
    if (!session) {
      session = await window.electronAPI.createAgentSession(campaign.name, channel.id, workspace.id)
    }

    setAgentSession(session)
    setAgentWorkspace(workspace)
    setCurrentAgentSessionId(session.id)
    setCurrentAgentWorkspaceId(workspace.id)
    window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch(console.error)
    return { session, workspace, channel }
  }, [ensureDefaultChannel, setAgentWorkspaces, setCurrentAgentSessionId, setCurrentAgentWorkspaceId])

  React.useEffect(() => {
    if (!selectedCampaign) {
      setAgentSession(null)
      setAgentWorkspace(null)
      return
    }

    let cancelled = false
    setAssistantLoading(true)
    ensureCampaignAgent(selectedCampaign)
      .then(() => {
        if (cancelled) return
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setAssistantLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [ensureCampaignAgent, selectedCampaign])

  const handleSendToAssistant = React.useCallback((prompt: string) => {
    if (!selectedCampaign) return
    ensureCampaignAgent(selectedCampaign)
      .then((result) => {
        if (!result) return
        return window.electronAPI.sendAgentMessage({
          sessionId: result.session.id,
          userMessage: prompt,
          channelId: result.channel.id,
          workspaceId: result.workspace.id,
          permissionModeOverride: 'bypassPermissions',
          startedAt: Date.now(),
        })
      })
      .catch(console.error)
  }, [ensureCampaignAgent, selectedCampaign])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-sm text-muted-foreground">加载中...</div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 grid grid-cols-[minmax(520px,1fr)_minmax(380px,0.72fr)] overflow-hidden">
      {/* 左侧：Campaign 细节和工作流 */}
      <main className="min-w-0 min-h-0 flex border-r border-border">
        {selectedCampaign ? (
          <CampaignDetail
            campaign={selectedCampaign}
            onBack={handleBack}
            onNavigateToKolData={() => setActiveView('influencer')}
            onSendToAssistant={handleSendToAssistant}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-sm text-muted-foreground gap-2">
            <Target size={32} className="opacity-20 mb-2" />
            <span>选择一个 Campaign 查看详情</span>
          </div>
        )}
      </main>

      {/* 右侧：Agent 对话框 */}
      <aside className="min-w-0 min-h-0 flex flex-col bg-background">
        <div className="h-14 px-4 border-b border-border flex items-center gap-3 titlebar-no-drag">
          <Bot size={16} className="text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">
              Agent 对话
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {selectedCampaign ? selectedCampaign.name : '未选择 Campaign'}
            </div>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {!selectedCampaign ? (
            <div className="h-full flex flex-col items-center justify-center text-sm text-muted-foreground gap-2">
              <Bot size={28} className="opacity-20" />
              <span>选择 Campaign 后开始对话</span>
            </div>
          ) : assistantLoading ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              初始化对话中...
            </div>
          ) : agentSession ? (
            <AgentView sessionId={agentSession.id} />
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              Agent 会话初始化失败
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
