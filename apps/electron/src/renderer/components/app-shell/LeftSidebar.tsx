/**
 * LeftSidebar - 左侧导航栏
 *
 * 包含：
 * - Chat/Agent 模式切换器
 * - 导航菜单项（点击切换主内容区视图）
 * - 星标对话区域（可展开/收起）
 * - 对话列表（新对话按钮 + 右键菜单 + 按 updatedAt 降序排列）
 */

import * as React from 'react'
import { useAtom, useSetAtom, useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { Star, StarOff, Settings, Plus, Trash2, Pencil, ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, ArrowRightLeft, Search, Archive, ArchiveRestore, ArrowLeft, Hammer, Bot, MessageSquare, MoreHorizontal, Workflow, FolderOpen, FolderPlus, Users, Megaphone, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ModeSwitcher } from './ModeSwitcher'
import { SearchDialog } from './SearchDialog'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { activeViewAtom } from '@/atoms/active-view'
import { CORE_WORK_MODULES } from '@/atoms/work-module-registry'
import { appModeAtom, type AppMode } from '@/atoms/app-mode'
import { settingsTabAtom, settingsOpenAtom } from '@/atoms/settings-tab'
import { CAPABILITY_MANIFEST, enabledCapabilitiesAtom, isCapabilityEnabled, type CapabilityId } from '@/atoms/marketing-atoms'
import {
  conversationsAtom,
  currentConversationIdAtom,
  selectedModelAtom,
  streamingConversationIdsAtom,
  conversationModelsAtom,
  conversationContextLengthAtom,
  conversationThinkingEnabledAtom,
  conversationParallelModeAtom,
} from '@/atoms/chat-atoms'
import {
  agentSessionsAtom,
  currentAgentSessionIdAtom,
  agentSessionIndicatorMapAtom,
  unviewedCompletedSessionIdsAtom,
  workingDoneSessionIdsAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  agentSessionChannelMapAtom,
  agentSessionModelMapAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
  workspaceCapabilitiesVersionAtom,
  agentDiffPanelTabAtom,
  agentDiffRefreshVersionAtom,
  agentDiffUnseenChangesAtom,
  agentDiffUnseenFilesAtom,
} from '@/atoms/agent-atoms'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'
import { previewPanelOpenMapAtom, previewFileMapAtom } from '@/atoms/preview-atoms'
import { clearPreviewCacheForSession } from '@/components/diff/DiffTabContent'
import {
  tabsAtom,
  activeTabIdAtom,
  sidebarCollapsedAtom,
  closeTab,
  updateTabTitle,
} from '@/atoms/tab-atoms'
import { userProfileAtom } from '@/atoms/user-profile'
import { sidebarViewModeAtom } from '@/atoms/sidebar-atoms'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import { hasUpdateAtom } from '@/atoms/updater'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { workingSessionIdsSetAtom } from '@/atoms/working-atoms'
import { hasEnvironmentIssuesAtom } from '@/atoms/environment'
import { promptConfigAtom, selectedPromptIdAtom, conversationPromptIdAtom } from '@/atoms/system-prompt-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { useSyncActiveTabSideEffects } from '@/hooks/useSyncActiveTabSideEffects'
import { CollapsedWorkspacePopover } from '@/components/agent/CollapsedWorkspacePopover'
import { MoveSessionDialog } from '@/components/agent/MoveSessionDialog'
import { detectIsMac } from '@/lib/platform'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import type { ConversationMeta, AgentSessionMeta, WorkspaceCapabilities } from '@gravitas/shared'
import { WorkflowSidebarList } from '@/components/workflow/WorkflowSidebarList'

export interface LeftSidebarProps {
  /** 可选固定宽度，默认使用 CSS 响应式宽度 */
  width?: number
  /** 正在被拖拽调整宽度（禁用宽度 transition，保证跟手） */
  resizing?: boolean
}

/** 日期分组标签 */
type DateGroup = '今天' | '昨天' | '更早'

/** 按 updatedAt 将项目分为 今天 / 昨天 / 更早 三组 */
function groupByDate<T extends { updatedAt: number }>(items: T[]): Array<{ label: DateGroup; items: T[] }> {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86_400_000

  const today: T[] = []
  const yesterday: T[] = []
  const earlier: T[] = []

  for (const item of items) {
    if (item.updatedAt >= todayStart) {
      today.push(item)
    } else if (item.updatedAt >= yesterdayStart) {
      yesterday.push(item)
    } else {
      earlier.push(item)
    }
  }

  const groups: Array<{ label: DateGroup; items: T[] }> = []
  if (today.length > 0) groups.push({ label: '今天', items: today })
  if (yesterday.length > 0) groups.push({ label: '昨天', items: yesterday })
  if (earlier.length > 0) groups.push({ label: '更早', items: earlier })
  return groups
}

const RAIL_STATUS_CLASS: Record<SessionIndicatorStatus, string> = {
  idle: 'hidden',
  running: 'bg-blue-500 animate-pulse',
  blocked: 'bg-orange-500',
  completed: 'bg-emerald-500',
}

const SIDEBAR_DRAG_STRIP_HEIGHT = {
  collapsedMac: 50,
  expandedMac: 30,
  collapsed: 8,
  expanded: 4,
} as const

function getRailInitial(title: string): string {
  return title.trim().slice(0, 1).toUpperCase() || '·'
}

function SidebarWindowDragStrip({ height }: { height: number }): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className="sidebar-window-drag-strip"
      style={{ height }}
    />
  )
}

export function LeftSidebar({ width, resizing = false }: LeftSidebarProps): React.ReactElement {
  const [activeView, setActiveView] = useAtom(activeViewAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const [conversations, setConversations] = useAtom(conversationsAtom)
  const currentConversationId = useAtomValue(currentConversationIdAtom)
  const draftSessionIds = useAtomValue(draftSessionIdsAtom)
  const setDraftSessionIds = useSetAtom(draftSessionIdsAtom)

  /** 待删除对话 ID，非空时显示确认弹窗 */
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null)
  /** 待删除项目（工作区）ID，非空时显示确认弹窗 */
  const [pendingDeleteWorkspaceId, setPendingDeleteWorkspaceId] = React.useState<string | null>(null)
  /** 待迁移会话 ID，非空时显示迁移对话框 */
  const [moveTargetId, setMoveTargetId] = React.useState<string | null>(null)
  /** 星标对话已改为独立常驻区块，不再需要折叠 state。 */
  /** 展开全部会话的项目 ID 集合 */
  const [expandedProjectIds, setExpandedProjectIds] = React.useState<Set<string>>(new Set())
  /** 协作子会话树的展开状态：默认展开的父会话（子会话当前活跃、且用户未手动折叠） */
  const [expandedDelegationParentIds, setExpandedDelegationParentIds] = React.useState<Set<string>>(new Set())
  /** 协作子会话树的手动折叠状态（用户显式折叠的父会话） */
  const [collapsedDelegationParentIds, setCollapsedDelegationParentIds] = React.useState<Set<string>>(new Set())
  /** 工作模块区域高度（px，可拖分隔条调整） */
  const [workModuleHeight, setWorkModuleHeight] = React.useState(190)
  /** 工作模块是否折叠（收到底部只剩分隔条） */
  const [workModuleCollapsed, setWorkModuleCollapsed] = React.useState(false)
  /** 拖动分隔条时记录起始位置，避免 drag 抖动 */
  const workModuleDragRef = React.useRef<{ startY: number; startHeight: number } | null>(null)

  /** 工作模块分隔条拖动开始 */
  const handleWorkModuleResizeStart = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    workModuleDragRef.current = { startY: e.clientY, startHeight: workModuleHeight }
    const onMove = (ev: MouseEvent): void => {
      const drag = workModuleDragRef.current
      if (!drag) return
      // 工作模块贴底（外层 p-2=8px），高度 = 窗口底部 - 8px padding - 当前鼠标 Y；受窗口高度约束
      const newHeight = Math.max(0, Math.min(window.innerHeight - 8 - ev.clientY, window.innerHeight - 128))
      setWorkModuleHeight(newHeight)
      // 拖到接近底部（高度过小）自动进入折叠态
      setWorkModuleCollapsed(newHeight < 24)
    }
    const onUp = (): void => {
      workModuleDragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'
  }, [workModuleHeight])

  /** 切换工作模块折叠/展开（点击分隔条箭头） */
  const handleToggleWorkModule = React.useCallback(() => {
    setWorkModuleCollapsed((prev) => {
      const next = !prev
      if (!next) setWorkModuleHeight(190)
      return next
    })
  }, [])

  /** 正在新建项目的名称输入（项目管理视图内联新建） */
  const [creatingProject, setCreatingProject] = React.useState(false)
  const [newProjectName, setNewProjectName] = React.useState('')
  const createProjectInputRef = React.useRef<HTMLInputElement>(null)
  const [userProfile, setUserProfile] = useAtom(userProfileAtom)
  const selectedModel = useAtomValue(selectedModelAtom)
  const streamingIds = useAtomValue(streamingConversationIdsAtom)
  const mode = useAtomValue(appModeAtom)
  const isMac = React.useMemo(() => detectIsMac(), [])
  const hasUpdate = useAtomValue(hasUpdateAtom)
  const hasEnvironmentIssues = useAtomValue(hasEnvironmentIssuesAtom)
  const promptConfig = useAtomValue(promptConfigAtom)
  const setSelectedPromptId = useSetAtom(selectedPromptIdAtom)

  // Agent 模式状态
  const [agentSessions, setAgentSessions] = useAtom(agentSessionsAtom)
  const [currentAgentSessionId, setCurrentAgentSessionId] = useAtom(currentAgentSessionIdAtom)
  const agentIndicatorMap = useAtomValue(agentSessionIndicatorMapAtom)
  const unviewedCompletedSessionIds = useAtomValue(unviewedCompletedSessionIdsAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const setSessionChannelMap = useSetAtom(agentSessionChannelMapAtom)
  const setSessionModelMap = useSetAtom(agentSessionModelMapAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const setMode = useSetAtom(appModeAtom)

  // 工作区能力（MCP + Skill 计数）
  const [capabilities, setCapabilities] = React.useState<WorkspaceCapabilities | null>(null)
  const _capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom)

  // Tab 状态
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom)
  const { openSession, openSessionPreview, openSessionPermanent } = useOpenSession()
  const syncActiveTabSideEffects = useSyncActiveTabSideEffects()

  // 归档 & 搜索状态
  const [viewMode, setViewMode] = useAtom(sidebarViewModeAtom)
  const setSearchDialogOpen = useSetAtom(searchDialogOpenAtom)

  // 当 activeTabId 变化时，自动滚动侧边栏使选中项可见
  React.useEffect(() => {
    if (!activeTabId) return
    requestAnimationFrame(() => {
      const el = document.querySelector('.session-item-selected')
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [activeTabId])

  // per-conversation/session Map atoms（删除时清理）
  const setConvModels = useSetAtom(conversationModelsAtom)
  const setConvContextLength = useSetAtom(conversationContextLengthAtom)
  const setConvThinking = useSetAtom(conversationThinkingEnabledAtom)
  const setConvParallel = useSetAtom(conversationParallelModeAtom)
  const setConvPromptId = useSetAtom(conversationPromptIdAtom)
  const setPreviewPanelOpen = useSetAtom(previewPanelOpenMapAtom)
  const setPreviewFile = useSetAtom(previewFileMapAtom)
  const setDiffPanelTab = useSetAtom(agentDiffPanelTabAtom)
  const setDiffRefreshVersion = useSetAtom(agentDiffRefreshVersionAtom)
  const setDiffUnseen = useSetAtom(agentDiffUnseenChangesAtom)
  const setDiffUnseenFiles = useSetAtom(agentDiffUnseenFilesAtom)
  const setWorkingDone = useSetAtom(workingDoneSessionIdsAtom)

  /** 清理 per-conversation/session Map atoms 条目 */
  const cleanupMapAtoms = React.useCallback((id: string) => {
    const deleteKey = <T,>(prev: Map<string, T>): Map<string, T> => {
      if (!prev.has(id)) return prev
      const map = new Map(prev)
      map.delete(id)
      return map
    }
    setConvModels(deleteKey)
    setConvContextLength(deleteKey)
    setConvThinking(deleteKey)
    setConvParallel(deleteKey)
    setConvPromptId(deleteKey)
    setPreviewPanelOpen(deleteKey)
    setPreviewFile(deleteKey)
    setDiffPanelTab(deleteKey)
    setDiffRefreshVersion(deleteKey)
    setDiffUnseen(deleteKey)
    setDiffUnseenFiles(deleteKey)
    setSessionChannelMap(deleteKey)
    setSessionModelMap(deleteKey)
    clearPreviewCacheForSession(id)
  }, [setConvModels, setConvContextLength, setConvThinking, setConvParallel, setConvPromptId, setPreviewPanelOpen, setPreviewFile, setDiffPanelTab, setDiffRefreshVersion, setDiffUnseen, setDiffUnseenFiles, setSessionChannelMap, setSessionModelMap])

  const currentWorkspaceSlug = React.useMemo(() => {
    if (!currentWorkspaceId) return null
    return workspaces.find((w) => w.id === currentWorkspaceId)?.slug ?? null
  }, [currentWorkspaceId, workspaces])

  React.useEffect(() => {
    if (!currentWorkspaceSlug || mode !== 'agent') {
      setCapabilities(null)
      return
    }
    window.electronAPI
      .getWorkspaceCapabilities(currentWorkspaceSlug)
      .then(setCapabilities)
      .catch(console.error)
  }, [currentWorkspaceSlug, mode])

  /** 星标对话列表（仅活跃模式显示，排除 draft） */
  const pinnedConversations = React.useMemo(
    () => viewMode === 'active' ? conversations.filter((c) => c.pinned && !draftSessionIds.has(c.id)) : [],
    [conversations, viewMode, draftSessionIds]
  )

  /** Working 区域状态 */
  const workingSessionIds = useAtomValue(workingSessionIdsSetAtom)

  /** 星标 Agent 会话列表（仅活跃模式显示，按当前工作区过滤，排除 draft 和 Working） */
  // 已迁移到项目管理视图（项目下直接展示），此列表不再需要
  /** 对话按日期分组（根据 viewMode 过滤归档状态，排除 draft） */
  const conversationGroups = React.useMemo(
    () => {
      const filtered = viewMode === 'archived'
        ? conversations.filter((c) => c.archived && !draftSessionIds.has(c.id))
        : conversations.filter((c) => !c.archived && !c.pinned && !draftSessionIds.has(c.id))
      return groupByDate(filtered)
    },
    [conversations, viewMode, draftSessionIds]
  )

  /** 已归档对话数量 */
  const archivedConversationCount = React.useMemo(
    () => conversations.filter((c) => c.archived).length,
    [conversations]
  )

  /** 已归档 Agent 会话数量（当前工作区） */
  const archivedAgentSessionCount = React.useMemo(
    () => agentSessions.filter((s) => s.archived && (!currentWorkspaceId || s.workspaceId === currentWorkspaceId)).length,
    [agentSessions, currentWorkspaceId]
  )

  // 初始加载对话列表 + 用户档案 + Agent 会话
  React.useEffect(() => {
    window.electronAPI
      .listConversations()
      .then((list) => {
        setConversations(list)
      })
      .catch(console.error)
    window.electronAPI
      .getUserProfile()
      .then(setUserProfile)
      .catch(console.error)
    window.electronAPI
      .listAgentSessions()
      .then(setAgentSessions)
      .catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setConversations, setUserProfile, setAgentSessions])

  // 自动任务区块：加载运行中的任务（started / progress / waiting_action）
  // 窗口聚焦时重新同步会话列表，修复长时间后前后端不一致
  React.useEffect(() => {
    const handleFocus = (): void => {
      window.electronAPI.listConversations().then(setConversations).catch(console.error)
      window.electronAPI.listAgentSessions().then(setAgentSessions).catch(console.error)
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [setConversations, setAgentSessions])

  /** 处理导航项点击 */
  // 切换模式时重置归档视图
  React.useEffect(() => {
    setViewMode('active')
  }, [setViewMode])

  /** 创建新对话（继承当前选中的模型/渠道） */
  const handleNewConversation = async (): Promise<void> => {
    try {
      const meta = await window.electronAPI.createConversation(
        undefined,
        selectedModel?.modelId,
        selectedModel?.channelId,
      )
      setConversations((prev) => [meta, ...prev])
      // 打开新标签页
      openSession('chat', meta.id, meta.title)
      // 确保在对话视图
      setActiveView('conversations')
      // 根据默认提示词重置选中
      if (promptConfig.defaultPromptId) {
        setSelectedPromptId(promptConfig.defaultPromptId)
      }
    } catch (error) {
      console.error('[侧边栏] 创建对话失败:', error)
    }
  }

  /** 选择对话（单击 → 临时预览标签，VS Code 风格） */
  const handleSelectConversation = React.useCallback((id: string, title: string): void => {
    openSessionPreview('chat', id, title)
    setActiveView('conversations')
  }, [openSessionPreview, setActiveView])

  /** 双击对话 → 常驻标签 */
  const handlePermanentConversation = React.useCallback((id: string, title: string): void => {
    openSessionPermanent('chat', id, title)
    setActiveView('conversations')
  }, [openSessionPermanent, setActiveView])

  /** 请求删除对话（弹出确认框） */
  const handleRequestDelete = React.useCallback((id: string): void => {
    setPendingDeleteId(id)
  }, [])

  /** 重命名对话标题 */
  const handleRename = async (id: string, newTitle: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateConversationTitle(id, newTitle)
      setConversations((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c))
      )
      // 同步更新标签页标题
      setTabs((prev) => updateTabTitle(prev, id, newTitle))
    } catch (error) {
      console.error('[侧边栏] 重命名对话失败:', error)
    }
  }

  /** 切换对话星标状态 */
  const handleTogglePin = async (id: string): Promise<void> => {
    try {
      const original = conversations.find((c) => c.id === id)
      const updated = await window.electronAPI.togglePinConversation(id)
      setConversations((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c))
      )
      // 归档会话被星标时会自动取消归档
      if (original?.archived && updated.pinned && !updated.archived) {
        toast.success('已取消归档并星标')
      }
    } catch (error) {
      console.error('[侧边栏] 切换星标失败:', error)
    }
  }

  /** 切换对话归档状态 */
  const handleToggleArchive = async (id: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.toggleArchiveConversation(id)
      setConversations((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c))
      )
      // 归档时自动关闭该对话的标签页，并同步新激活标签的副作用
      // （appMode、currentXxxId 等），避免文件面板/工具栏等 per-tab
      // 状态被遗留为旧值或被错误地置 null。
      if (updated.archived) {
        const wasActive = activeTabId === id
        const tabResult = closeTab(tabs, activeTabId, id)
        setTabs(tabResult.tabs)
        setActiveTabId(tabResult.activeTabId)
        cleanupMapAtoms(id)
        if (wasActive) {
          const newActiveTab = tabResult.activeTabId
            ? tabResult.tabs.find((t) => t.id === tabResult.activeTabId) ?? null
            : null
          syncActiveTabSideEffects(newActiveTab)
        }
      }
      toast.success(updated.archived ? '已归档' : '已取消归档')
    } catch (error) {
      console.error('[侧边栏] 切换归档失败:', error)
    }
  }

  /** 确认删除对话 */
  const handleConfirmDelete = async (): Promise<void> => {
    if (!pendingDeleteId) return

    // 关闭对应的标签页：setTabs 与 setActiveTabId 成组更新，便于阅读，
    // 也避免将来在两者之间意外插入 await 导致跨渲染状态不一致。
    // （React 18 在同一事件回调中会自动批处理多次 setState，所以单次渲染
    // 的一致性由 React 保证，这里只是保持代码组织清晰。）
    const wasActive = activeTabId === pendingDeleteId
    const tabResult = closeTab(tabs, activeTabId, pendingDeleteId)
    setTabs(tabResult.tabs)
    setActiveTabId(tabResult.activeTabId)

    // 若关闭的是当前活跃标签，同步新激活标签的副作用（appMode、
    // currentXxxId、以及右侧文件面板等 per-tab 状态），保持与 TabBar
    // 关闭逻辑一致，避免删除/归档当前会话后新标签状态缺失。
    if (wasActive) {
      const newActiveTab = tabResult.activeTabId
        ? tabResult.tabs.find((t) => t.id === tabResult.activeTabId) ?? null
        : null
      syncActiveTabSideEffects(newActiveTab)
    }

    // 清理 draft 标记（如有）
    setDraftSessionIds((prev: Set<string>) => {
      if (!prev.has(pendingDeleteId)) return prev
      const next = new Set(prev)
      next.delete(pendingDeleteId)
      return next
    })

    // 清理 per-conversation/session Map atoms 条目
    cleanupMapAtoms(pendingDeleteId)

    // 从 Working Done 集合移除
    setWorkingDone((prev) => {
      if (!prev.has(pendingDeleteId)) return prev
      const next = new Set(prev)
      next.delete(pendingDeleteId)
      return next
    })

    if (mode === 'agent') {
      // Agent 模式：删除 Agent 会话
      // 注意：当前会话指针（currentAgentSessionId）已由上面的
      // syncActiveTabSideEffects 在 wasActive 分支同步到新激活标签，
      // 这里不要再按旧闭包值强制置 null，否则会覆盖新 sessionId，
      // 导致 RightSidePanel 消失（依赖 currentAgentSessionIdAtom）。
      try {
        await window.electronAPI.deleteAgentSession(pendingDeleteId)
        // 全量刷新确保与后端同步
        const sessions = await window.electronAPI.listAgentSessions()
        setAgentSessions(sessions)
      } catch (error) {
        console.error('[侧边栏] 删除 Agent 会话失败:', error)
        // 即使后端报错，也从本地列表移除（可能是会话已不存在）
        setAgentSessions((prev) => prev.filter((s) => s.id !== pendingDeleteId))
      } finally {
        setPendingDeleteId(null)
      }
      return
    }

    try {
      await window.electronAPI.deleteConversation(pendingDeleteId)
      // 全量刷新确保与后端同步
      const conversations = await window.electronAPI.listConversations()
      setConversations(conversations)
    } catch (error) {
      console.error('[侧边栏] 删除对话失败:', error)
      // 即使后端报错，也从本地列表移除（可能是对话已不存在）
      setConversations((prev) => prev.filter((c) => c.id !== pendingDeleteId))
    } finally {
      setPendingDeleteId(null)
    }
  }

  /** 创建新 Agent 会话 */
  const handleNewAgentSession = async (): Promise<void> => {
    await handleNewAgentSessionInWorkspace(currentWorkspaceId ?? undefined)
  }

  /** 在指定工作区创建新 Agent 会话（项目内 + 按钮使用） */
  const handleNewAgentSessionInWorkspace = async (workspaceId: string | undefined): Promise<void> => {
    try {
      const meta = await window.electronAPI.createAgentSession(
        undefined,
        agentChannelId || undefined,
        workspaceId,
      )
      setAgentSessions((prev) => [meta, ...prev])
      // 从全局默认值初始化 per-session 渠道/模型配置
      if (agentChannelId) {
        setSessionChannelMap((prev) => {
          const map = new Map(prev)
          map.set(meta.id, agentChannelId)
          return map
        })
      }
      if (agentModelId) {
        setSessionModelMap((prev) => {
          const map = new Map(prev)
          map.set(meta.id, agentModelId)
          return map
        })
      }
      // 打开新标签页
      openSession('agent', meta.id, meta.title)
      setActiveView('conversations')
    } catch (error) {
      console.error('[侧边栏] 创建 Agent 会话失败:', error)
    }
  }

  /** 选择 Agent 会话（单击 → 临时预览标签，VS Code 风格） */
  const handleSelectAgentSession = React.useCallback((id: string, title: string): void => {
    const session = agentSessions.find((s) => s.id === id)
    // 新项目管理视图：点击项目下的会话时同步切换当前工作区
    if (session?.workspaceId && session.workspaceId !== currentWorkspaceId) {
      setCurrentAgentWorkspaceId(session.workspaceId)
      window.electronAPI.updateSettings({ agentWorkspaceId: session.workspaceId }).catch(console.error)
    }
    openSessionPreview('agent', id, title)
    setActiveView('conversations')
    // 清除该会话的"已完成未查看"标记
    setUnviewedCompleted((prev: Set<string>) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [openSessionPreview, setActiveView, setUnviewedCompleted, agentSessions, currentWorkspaceId, setCurrentAgentWorkspaceId])

  /** 双击 Agent 会话 → 常驻标签 */
  const handlePermanentAgentSession = React.useCallback((id: string, title: string): void => {
    const session = agentSessions.find((s) => s.id === id)
    if (session?.workspaceId && session.workspaceId !== currentWorkspaceId) {
      setCurrentAgentWorkspaceId(session.workspaceId)
      window.electronAPI.updateSettings({ agentWorkspaceId: session.workspaceId }).catch(console.error)
    }
    openSessionPermanent('agent', id, title)
    setActiveView('conversations')
    setUnviewedCompleted((prev: Set<string>) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [openSessionPermanent, setActiveView, setUnviewedCompleted, agentSessions, currentWorkspaceId, setCurrentAgentWorkspaceId])

  /** 重命名 Agent 会话标题 */
  const handleAgentRename = async (id: string, newTitle: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(id, newTitle)
      setAgentSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s))
      )
      // 同步更新标签页标题
      setTabs((prev) => updateTabTitle(prev, id, newTitle))
    } catch (error) {
      console.error('[侧边栏] 重命名 Agent 会话失败:', error)
    }
  }

  /** 切换 Agent 会话星标状态 */
  const handleTogglePinAgent = async (id: string): Promise<void> => {
    try {
      const original = agentSessions.find((s) => s.id === id)
      const updated = await window.electronAPI.togglePinAgentSession(id)
      setAgentSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s))
      )
      // 归档会话被星标时会自动取消归档
      if (original?.archived && updated.pinned && !updated.archived) {
        toast.success('已取消归档并星标')
      }
    } catch (error) {
      console.error('[侧边栏] 切换 Agent 会话星标失败:', error)
    }
  }

  /** 切换 Agent 会话手动工作中状态 */
  const handleToggleManualWorkingAgent = async (id: string): Promise<void> => {
    try {
      const isCurrentlyInWorking = workingSessionIds.has(id)
      if (isCurrentlyInWorking) {
        // 从工作中移出：清除 manualWorking + 清除 workingDone
        const session = agentSessions.find((s) => s.id === id)
        if (session?.manualWorking) {
          const updated = await window.electronAPI.toggleManualWorkingAgentSession(id)
          setAgentSessions((prev) =>
            prev.map((s) => (s.id === updated.id ? updated : s))
          )
        }
        setWorkingDone((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      } else {
        // 加入工作中
        const original = agentSessions.find((s) => s.id === id)
        const updated = await window.electronAPI.toggleManualWorkingAgentSession(id)
        setAgentSessions((prev) =>
          prev.map((s) => (s.id === updated.id ? updated : s))
        )
        if (original?.archived && updated.manualWorking && !updated.archived) {
          toast.success('已取消归档并标记为工作中')
        }
      }
    } catch (error) {
      console.error('[Sidebar] Failed to toggle manual working:', error)
      toast.error('操作失败')
    }
  }

  /** 切换 Agent 会话归档状态 */
  const handleToggleArchiveAgent = async (id: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.toggleArchiveAgentSession(id)
      setAgentSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s))
      )
      // 归档时自动关闭该会话的标签页，并同步新激活标签的副作用，
      // 否则 RightSidePanel（依赖 currentAgentSessionIdAtom）会因为
      // 指针被错误置 null 而消失。
      if (updated.archived) {
        const wasActive = activeTabId === id
        const tabResult = closeTab(tabs, activeTabId, id)
        setTabs(tabResult.tabs)
        setActiveTabId(tabResult.activeTabId)
        cleanupMapAtoms(id)
        // 从 Working Done 集合移除
        setWorkingDone((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        if (wasActive) {
          const newActiveTab = tabResult.activeTabId
            ? tabResult.tabs.find((t) => t.id === tabResult.activeTabId) ?? null
            : null
          syncActiveTabSideEffects(newActiveTab)
        }
      }
      toast.success(updated.archived ? '已归档' : '已取消归档')
    } catch (error) {
      console.error('[侧边栏] 切换 Agent 会话归档失败:', error)
    }
  }

  /** 请求迁移会话到其他工作区（弹出迁移对话框） */
  const handleRequestMove = React.useCallback((id: string): void => {
    setMoveTargetId(id)
  }, [])

  /** 迁移会话到另一个工作区后的回调 */
  const handleSessionMoved = (updatedSession: AgentSessionMeta, targetWorkspaceName: string): void => {
    setAgentSessions((prev) =>
      prev.map((s) => (s.id === updatedSession.id ? updatedSession : s))
    )
    // 如果迁移的是当前选中的会话，取消选中并关闭标签页
    if (currentAgentSessionId === updatedSession.id) {
      const tabResult = closeTab(tabs, activeTabId, updatedSession.id)
      setTabs(tabResult.tabs)
      setActiveTabId(tabResult.activeTabId)
      setCurrentAgentSessionId(null)
      // 从 Working Done 集合移除
      setWorkingDone((prev) => {
        if (!prev.has(updatedSession.id)) return prev
        const next = new Set(prev)
        next.delete(updatedSession.id)
        return next
      })
    }
    setMoveTargetId(null)
    toast.success('会话已迁移', {
      description: `已迁移到「${targetWorkspaceName}」，请切换工作区查看`,
    })
  }

  /** Agent 会话按工作区过滤 + 归档过滤 + 排除 draft + 排除 Working */
  const filteredAgentSessions = React.useMemo(
    () => {
      const byWorkspace = agentSessions.filter((s) => s.workspaceId === currentWorkspaceId && !draftSessionIds.has(s.id))
      return viewMode === 'archived'
        ? byWorkspace.filter((s) => s.archived)
        : byWorkspace.filter((s) => !s.archived && !s.pinned && !workingSessionIds.has(s.id))
    },
    [agentSessions, currentWorkspaceId, viewMode, draftSessionIds, workingSessionIds]
  )

  /** Agent 会话按日期分组 */
  const agentSessionGroups = React.useMemo(
    () => groupByDate(filteredAgentSessions),
    [filteredAgentSessions]
  )

  /** 每个项目（工作区）下的会话，按 updatedAt 降序，排除归档与 draft */
  const sessionsByWorkspace = React.useMemo(() => {
    const map = new Map<string, AgentSessionMeta[]>()
    for (const s of agentSessions) {
      if (!s.workspaceId || s.archived || draftSessionIds.has(s.id)) continue
      const list = map.get(s.workspaceId) ?? []
      list.push(s)
      map.set(s.workspaceId, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    return map
  }, [agentSessions, draftSessionIds])

  /**
   * 项目列表排序：基于最近聊天记录（会话 updatedAt）降序。
   * 最上方 = 最后发送消息的项目；无会话的项目按工作区自身 updatedAt 兜底。
   */
  const projectList = React.useMemo(() => {
    const lastActivity = new Map<string, number>()
    for (const [wsId, sessions] of sessionsByWorkspace) {
      const latest = sessions[0]?.updatedAt
      if (latest) lastActivity.set(wsId, latest)
    }
    return [...workspaces].sort((a, b) => {
      const aTime = lastActivity.get(a.id) ?? a.updatedAt
      const bTime = lastActivity.get(b.id) ?? b.updatedAt
      if (aTime !== bTime) return bTime - aTime
      return b.updatedAt - a.updatedAt
    })
  }, [workspaces, sessionsByWorkspace])

  /** 切换项目展开（显示全部会话） */
  const toggleProjectExpanded = React.useCallback((id: string): void => {
    setExpandedProjectIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** 项目（工作区）是否允许删除：非默认工作区且至少保留一个 */
  const canDeleteWorkspace = React.useCallback(
    (ws: { id: string; slug: string }): boolean => ws.slug !== 'default' && workspaces.length > 1,
    [workspaces]
  )

  /** 切换协作子会话树展开/折叠 */
  const handleToggleDelegationParent = React.useCallback((sessionId: string, expanded: boolean): void => {
    if (expanded) {
      // 当前展开 → 折叠：记录手动折叠
      setCollapsedDelegationParentIds((prev) => {
        const next = new Set(prev)
        next.add(sessionId)
        return next
      })
      setExpandedDelegationParentIds((prev) => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    } else {
      // 当前折叠 → 展开：解除折叠标记
      setCollapsedDelegationParentIds((prev) => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
      setExpandedDelegationParentIds((prev) => {
        const next = new Set(prev)
        next.add(sessionId)
        return next
      })
    }
  }, [])

  /** 请求删除项目（弹出确认框） */
  const handleRequestDeleteWorkspace = React.useCallback((id: string): void => {
    setPendingDeleteWorkspaceId(id)
  }, [])

  /** 确认删除项目 */
  const handleConfirmDeleteWorkspace = async (): Promise<void> => {
    if (!pendingDeleteWorkspaceId) return

    try {
      await window.electronAPI.deleteAgentWorkspace(pendingDeleteWorkspaceId)
      const remaining = workspaces.filter((w) => w.id !== pendingDeleteWorkspaceId)
      setWorkspaces(remaining)

      // 若删除的是当前工作区，切换到剩余第一个；无剩余则清空当前指针
      if (pendingDeleteWorkspaceId === currentWorkspaceId) {
        if (remaining.length > 0) {
          setCurrentAgentWorkspaceId(remaining[0]!.id)
          window.electronAPI.updateSettings({ agentWorkspaceId: remaining[0]!.id }).catch(console.error)
        } else {
          setCurrentAgentWorkspaceId(null)
        }
      }
      toast.success('项目已删除')
    } catch (error) {
      console.error('[侧边栏] 删除项目失败:', error)
      toast.error('删除项目失败')
    } finally {
      setPendingDeleteWorkspaceId(null)
    }
  }

  /** 新建项目：内联输入 */
  const handleStartCreateProject = (): void => {
    setCreatingProject(true)
    setNewProjectName('')
    requestAnimationFrame(() => {
      createProjectInputRef.current?.focus()
    })
  }

  const handleCreateProject = async (): Promise<void> => {
    const trimmed = newProjectName.trim()
    if (!trimmed) {
      setCreatingProject(false)
      return
    }
    try {
      const ws = await window.electronAPI.createAgentWorkspace(trimmed)
      setWorkspaces((prev) => [ws, ...prev])
      setCurrentAgentWorkspaceId(ws.id)
      window.electronAPI.updateSettings({ agentWorkspaceId: ws.id }).catch(console.error)
    } catch (error) {
      const msg = error instanceof Error ? error.message : '创建失败'
      toast.error(msg)
    } finally {
      setCreatingProject(false)
      setNewProjectName('')
    }
  }

  const handleCreateProjectKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return
      e.preventDefault()
      void handleCreateProject()
    } else if (e.key === 'Escape') {
      setCreatingProject(false)
      setNewProjectName('')
    }
  }


  const handleRailModeSwitch = React.useCallback((targetMode: AppMode) => {
    setViewMode('active')
    setActiveView('conversations')
    if (targetMode === mode) return

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

    const recent = sessions.find((s) => !s.archived && !draftSessionIds.has(s.id))
    if (recent) {
      openSession(targetMode, recent.id, recent.title)
      return
    }

    setMode(targetMode)
  }, [
    mode,
    conversations,
    agentSessions,
    currentConversationId,
    currentAgentSessionId,
    tabs,
    draftSessionIds,
    openSession,
    setMode,
    setViewMode,
    setActiveView,
  ])

  const railRecentItems = React.useMemo(() => {
    if (mode === 'chat') {
      return conversations
        .filter((c) => !c.archived && !draftSessionIds.has(c.id))
        .sort((a, b) => {
          const activeDelta = Number(b.id === activeTabId) - Number(a.id === activeTabId)
          if (activeDelta !== 0) return activeDelta
          const streamingDelta = Number(streamingIds.has(b.id)) - Number(streamingIds.has(a.id))
          if (streamingDelta !== 0) return streamingDelta
          const pinnedDelta = Number(!!b.pinned) - Number(!!a.pinned)
          if (pinnedDelta !== 0) return pinnedDelta
          return b.updatedAt - a.updatedAt
        })
        .slice(0, 5)
        .map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          type: 'chat' as const,
          initial: getRailInitial(conversation.title),
          active: conversation.id === activeTabId,
          status: streamingIds.has(conversation.id) ? 'running' as const : 'idle' as const,
          pinned: !!conversation.pinned,
        }))
    }

    return agentSessions
      .filter((session) =>
        !session.archived
        && !draftSessionIds.has(session.id)
        && (!currentWorkspaceId || session.workspaceId === currentWorkspaceId)
      )
      .sort((a, b) => {
        const statusA = agentIndicatorMap.get(a.id) ?? (unviewedCompletedSessionIds.has(a.id) ? 'completed' : 'idle')
        const statusB = agentIndicatorMap.get(b.id) ?? (unviewedCompletedSessionIds.has(b.id) ? 'completed' : 'idle')
        const priority = (session: AgentSessionMeta, status: SessionIndicatorStatus): number => {
          if (session.id === activeTabId) return 0
          if (status === 'blocked') return 1
          if (status === 'running') return 2
          if (workingSessionIds.has(session.id)) return 3
          if (session.pinned) return 4
          if (status === 'completed') return 5
          return 6
        }
        const priorityDelta = priority(a, statusA) - priority(b, statusB)
        if (priorityDelta !== 0) return priorityDelta
        return b.updatedAt - a.updatedAt
      })
      .slice(0, 5)
      .map((session) => ({
        id: session.id,
        title: session.title,
        type: 'agent' as const,
        initial: getRailInitial(session.title),
        active: session.id === activeTabId,
        status: agentIndicatorMap.get(session.id) ?? (unviewedCompletedSessionIds.has(session.id) ? 'completed' as const : 'idle' as const),
        pinned: !!session.pinned,
      }))
  }, [
    mode,
    conversations,
    agentSessions,
    draftSessionIds,
    currentWorkspaceId,
    activeTabId,
    streamingIds,
    agentIndicatorMap,
    unviewedCompletedSessionIds,
    workingSessionIds,
  ])

  // 删除确认弹窗（collapsed/expanded 共享）
  const deleteDialog = (
    <AlertDialog
      open={pendingDeleteId !== null}
      onOpenChange={(open) => { if (!open) setPendingDeleteId(null) }}
    >
      <AlertDialogContent
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            handleConfirmDelete()
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除对话</AlertDialogTitle>
          <AlertDialogDescription>
            删除后将无法恢复，确定要删除这个对话吗？
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirmDelete}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  // 删除项目确认弹窗（仅展开态项目列表可见）
  const deleteWorkspaceDialog = (
    <AlertDialog
      open={pendingDeleteWorkspaceId !== null}
      onOpenChange={(open) => { if (!open) setPendingDeleteWorkspaceId(null) }}
    >
      <AlertDialogContent
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            handleConfirmDeleteWorkspace()
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除项目</AlertDialogTitle>
          <AlertDialogDescription>
            删除后工作区配置将被移除，但本地目录文件会保留。确定要删除这个项目吗？
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirmDeleteWorkspace}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  // 迁移会话对话框（collapsed/expanded 共享）
  const moveDialog = (
    <MoveSessionDialog
      open={moveTargetId !== null}
      onOpenChange={(open) => { if (!open) setMoveTargetId(null) }}
      sessionId={moveTargetId ?? ''}
      currentWorkspaceId={currentWorkspaceId ?? undefined}
      workspaces={workspaces}
      onMoved={handleSessionMoved}
    />
  )

  // ===== 折叠状态：精简图标视图 =====
  if (sidebarCollapsed) {
    return (
      <div
        className="relative h-full flex flex-col items-center bg-background rounded-2xl shadow-xl transition-[width] duration-300 px-2"
        style={{ width: 60, flexShrink: 0 }}
      >
        <SidebarWindowDragStrip
          height={isMac ? SIDEBAR_DRAG_STRIP_HEIGHT.collapsedMac : SIDEBAR_DRAG_STRIP_HEIGHT.collapsed}
        />

        {/* macOS 需要避开左上角红绿灯；边栏覆盖全局标题栏拖拽层，因此留白自身也要可拖拽。 */}
        <div className={cn('w-full flex-shrink-0 titlebar-drag-region', isMac ? 'h-[50px]' : 'h-2')} />

        {/* 展开按钮：mini rail 的唯一布局控制入口 */}
        <div className="pt-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="展开侧边栏"
                onClick={() => setSidebarCollapsed(false)}
                className="size-10 flex items-center justify-center rounded-[12px] text-foreground/60 bg-muted hover:bg-foreground/[0.08] hover:text-foreground transition-colors titlebar-no-drag"
              >
                <PanelLeftOpen size={17} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">展开侧边栏 ({navigator.platform.includes('Mac') ? '⌘B' : 'Ctrl+B'})</TooltipContent>
          </Tooltip>
        </div>

        <div className="my-3 h-px w-8 bg-border/70" />

        {/* 模式切换 */}
        <div className="flex flex-col items-center gap-1.5">
          <CollapsedWorkspacePopover>
            <button
              type="button"
              aria-label="切换到 Agent 模式（悬停查看工作区）"
              onClick={() => handleRailModeSwitch('agent')}
              className={cn(
                'relative size-10 flex items-center justify-center rounded-[12px] transition-colors titlebar-no-drag',
                mode === 'agent'
                  ? 'bg-primary/10 text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
                  : 'text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/75'
              )}
            >
              <Bot size={18} />
            </button>
          </CollapsedWorkspacePopover>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="切换到 Chat 模式"
                onClick={() => handleRailModeSwitch('chat')}
                className={cn(
                  'relative size-10 flex items-center justify-center rounded-[12px] transition-colors titlebar-no-drag',
                  mode === 'chat'
                    ? 'bg-primary/10 text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
                    : 'text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/75'
                )}
              >
                <MessageSquare size={17} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Chat 模式</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Proactive Center"
                onClick={() => {
                  setActiveView('proactive')
                  setSidebarCollapsed(false)
                }}
                className={cn(
                  'relative size-10 flex items-center justify-center rounded-[12px] transition-colors titlebar-no-drag',
                  activeView === 'proactive'
                    ? 'bg-primary/10 text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
                    : 'text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/75'
                )}
              >
                <Zap size={17} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Proactive Center</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Workflow 工作台"
                onClick={() => {
                  setActiveView('workflow')
                  // 折叠态下展开侧边栏，露出 workflow 列表（模板/我的 Workflow/运行历史）与新建入口
                  setSidebarCollapsed(false)
                }}
                className={cn(
                  'relative size-10 flex items-center justify-center rounded-[12px] transition-colors titlebar-no-drag',
                  activeView === 'workflow'
                    ? 'bg-primary/10 text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
                    : 'text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/75'
                )}
              >
                <Workflow size={17} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Workflow 工作台</TooltipContent>
          </Tooltip>
        </div>

        <div className="my-3 h-px w-8 bg-border/70" />

        {/* 高频操作 */}
        <div className="flex flex-col items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={mode === 'agent' ? '新建 Agent 会话' : '新建 Chat 对话'}
                onClick={mode === 'agent' ? handleNewAgentSession : handleNewConversation}
                className="size-10 flex items-center justify-center rounded-[12px] text-foreground/70 bg-primary/5 hover:bg-primary/10 transition-colors titlebar-no-drag border border-dashed border-[hsl(var(--dashed-border))] hover:border-[hsl(var(--dashed-border-hover))]"
              >
                <Plus size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {mode === 'agent' ? '新会话' : '新对话'}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="搜索"
                onClick={() => setSearchDialogOpen(true)}
                className="size-10 flex items-center justify-center rounded-[12px] text-foreground/45 bg-primary/5 hover:bg-primary/10 hover:text-foreground/70 transition-colors titlebar-no-drag border border-dashed border-[hsl(var(--dashed-border))] hover:border-[hsl(var(--dashed-border-hover))]"
              >
                <Search size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">搜索</TooltipContent>
          </Tooltip>
        </div>

        <div className="my-3 h-px w-8 bg-border/70" />

        {/* 最近/关键会话入口 */}
        <div className="flex-1 min-h-0 w-full overflow-y-auto scrollbar-none">
          <div className="flex flex-col items-center gap-1.5 pb-2">
            {railRecentItems.map((item) => (
              <Tooltip key={`${item.type}-${item.id}`}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`打开${item.type === 'agent' ? 'Agent 会话' : 'Chat 对话'}：${item.title}`}
                    onClick={() => {
                      if (item.type === 'agent') {
                        handleSelectAgentSession(item.id, item.title)
                      } else {
                        handleSelectConversation(item.id, item.title)
                      }
                    }}
                    className={cn(
                      'relative size-10 flex items-center justify-center overflow-hidden rounded-[12px] transition-colors titlebar-no-drag',
                      item.active
                        ? 'bg-primary/10 text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
                        : 'text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/80'
                    )}
                  >
                    <span
                      className={cn(
                        'absolute left-1 top-1.5 bottom-1.5 w-[2px] rounded-full pointer-events-none',
                        RAIL_STATUS_CLASS[item.status]
                      )}
                    />
                    <span className="text-[13px] font-semibold leading-none">{item.initial}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {item.type === 'agent' ? 'Agent' : 'Chat'} · {item.title}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>

        {/* 用户头像（点击打开设置） */}
        <div className="pt-3 pb-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="打开设置"
                onClick={() => setSettingsOpen(true)}
                className="relative size-10 flex items-center justify-center rounded-[12px] transition-colors titlebar-no-drag hover:bg-foreground/5"
              >
                <UserAvatar avatar={userProfile.avatar} size={28} />
                {(hasUpdate || hasEnvironmentIssues) && (
                  <span className="absolute top-0 right-0 w-2 h-2 rounded-full bg-red-500" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">设置</TooltipContent>
          </Tooltip>
        </div>

        {deleteDialog}
        {moveDialog}
        <SearchDialog />
      </div>
    )
  }

  /** 工作模块区块（可拖动分隔条 / 收到底部 / 点击箭头展开），供项目列表与 workflow 列表两种视图复用 */
  const renderWorkModule = (): React.ReactElement => (
    <div className="flex-shrink-0">
      {/* 分隔条：可拖动 + 点击箭头折叠/展开 */}
      <div
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={handleWorkModuleResizeStart}
        className="group/resize relative flex items-center justify-center h-[7px] cursor-row-resize select-none titlebar-no-drag"
      >
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-px bg-border/50 group-hover/resize:bg-primary/40 transition-colors" />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleToggleWorkModule() }}
          className="relative z-10 flex items-center justify-center size-4 rounded-full bg-background border border-border/60 text-foreground/35 hover:text-foreground/70 hover:border-primary/40 transition-colors shadow-sm"
          title={workModuleCollapsed ? '展开工作模块' : '收起到底部'}
        >
          <ChevronDown size={10} className={cn('transition-transform duration-150', workModuleCollapsed && 'rotate-180')} />
        </button>
      </div>

      {/* 工作模块内容：折叠时高度 0 隐藏，拖动时按高度撑开 */}
      <div
        className="overflow-hidden"
        style={{ height: workModuleCollapsed ? 0 : Math.max(workModuleHeight, 64) }}
      >
        <div className="px-2 pt-1 pb-1">
          <div className="px-2 py-1 text-[11px] font-medium text-foreground/40 select-none">
            工作模块
          </div>
          <div className="flex flex-col gap-0.5 mt-1">
            {CORE_WORK_MODULES.map(({ id, label, icon: Icon }) => {
              const active = activeView === id
              return (
                <button
                  key={id}
                  onClick={() => setActiveView(id)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-colors titlebar-no-drag',
                    active
                      ? 'bg-primary text-primary-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
                      : 'text-foreground/55 hover:bg-foreground/[0.04] hover:text-foreground/80'
                  )}
                >
                  <Icon size={16} className={active ? 'text-primary-foreground' : 'text-foreground/40'} />
                  <span className="flex-1 text-left">{label}</span>
                </button>
              )
            })}
            <button
              onClick={() => setActiveView('proactive')}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-colors titlebar-no-drag',
                activeView === 'proactive'
                  ? 'bg-primary text-primary-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
                  : 'text-foreground/55 hover:bg-foreground/[0.04] hover:text-foreground/80'
              )}
            >
              <Zap size={16} className={activeView === 'proactive' ? 'text-primary-foreground' : 'text-foreground/40'} />
              <span className="flex-1 text-left">Proactive Center</span>
            </button>
            <button
              onClick={() => { setSettingsTab('agent'); setSettingsOpen(true) }}
              className="group w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] font-medium text-foreground/55 hover:bg-foreground/[0.04] hover:text-foreground/80 transition-colors titlebar-no-drag"
            >
              <Bot size={16} className="text-foreground/40" />
              <span className="flex-1 text-left">Agent 技能</span>
              {capabilities && (
                <span className="flex-shrink-0 min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-foreground/[0.08] text-[10px] text-foreground/55 tabular-nums">
                  {capabilities.skills.length}
                </span>
              )}
            </button>
            {/* 已激活领域能力包固定在侧栏工作模块的最底部。 */}
            <SubscribedCapabilities />
          </div>
        </div>
      </div>
    </div>
  )

  // ===== 展开状态：完整侧边栏 =====
  return (
    <div
      className={cn(
        'relative h-full flex flex-col bg-background rounded-l-2xl rounded-r-none shadow-xl',
        resizing ? '' : 'transition-[width] duration-300'
      )}
      style={{ width: width ?? 260, minWidth: 180, flexShrink: 0 }}
    >
      <SidebarWindowDragStrip
        height={isMac ? SIDEBAR_DRAG_STRIP_HEIGHT.expandedMac : SIDEBAR_DRAG_STRIP_HEIGHT.expanded}
      />

      {/* macOS 需要避开左上角红绿灯；边栏覆盖全局标题栏拖拽层，因此留白自身也要可拖拽。 */}
      <div className={cn('w-full flex-shrink-0 titlebar-drag-region', isMac ? 'h-[30px]' : 'h-1')} />

      {/* 模式切换器 + 折叠按钮 */}
      <div className="titlebar-drag-region flex items-start gap-1.5 px-3">
        <div className="flex-1 min-w-0">
          <ModeSwitcher />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="mt-2 size-10 flex-shrink-0 flex items-center justify-center rounded-[10px] bg-muted text-foreground/40 hover:bg-foreground/[0.08] hover:text-foreground/60 transition-colors titlebar-no-drag"
            >
              <PanelLeftClose size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">收起侧边栏 ({navigator.platform.includes('Mac') ? '⌘B' : 'Ctrl+B'})</TooltipContent>
        </Tooltip>
      </div>

      {/* 工作模块已移至侧边栏底部项目列表下方 */}

      {/* 新对话/新会话按钮 + 搜索按钮 */}
      <div className="px-3 pt-2 flex items-center gap-1.5">
        <button
          onClick={mode === 'agent' ? handleNewAgentSession : handleNewConversation}
          className="flex-1 flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-medium text-foreground/70 bg-primary/5 hover:bg-primary/10 transition-colors duration-100 titlebar-no-drag border border-dashed border-[hsl(var(--dashed-border))] hover:border-[hsl(var(--dashed-border-hover))]"
        >
          <Plus size={14} />
          <span>{mode === 'agent' ? '新会话' : '新对话'}</span>
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setSearchDialogOpen(true)}
              className="flex-shrink-0 size-[36px] flex items-center justify-center rounded-[10px] text-foreground/40 bg-primary/5 hover:bg-primary/10 hover:text-foreground/60 transition-colors duration-100 titlebar-no-drag border border-dashed border-[hsl(var(--dashed-border))] hover:border-[hsl(var(--dashed-border-hover))]"
            >
              <Search size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">搜索 (⌘F)</TooltipContent>
        </Tooltip>
      </div>

      {/* Chat 模式：星标对话独立区块（常驻展示，不依赖折叠） */}
      {mode === 'chat' && (
        <div className="px-3 pt-3 pb-1">
          <div className="rounded-xl bg-foreground/[0.03] border border-primary/10 overflow-hidden">
            <div className="px-3 py-1.5 flex items-center gap-1.5">
              <Star size={12} className="text-foreground/50" />
              <span className="text-[11px] font-medium text-foreground/50 select-none flex-1">星标对话</span>
              <span className="text-[10px] text-foreground/30 tabular-nums">{pinnedConversations.length}</span>
            </div>
            <div className="max-h-[40vh] overflow-y-auto flex flex-col gap-0.5 px-1 pb-1">
              {pinnedConversations.length > 0 ? (
                pinnedConversations.map((conv) => (
                  <ConversationItem
                    key={`pinned-${conv.id}`}
                    conversation={conv}
                    active={conv.id === activeTabId}
                    streaming={streamingIds.has(conv.id)}
                    showPinIcon={false}
                    onSelect={handleSelectConversation}
                    onOpenPermanent={handlePermanentConversation}
                    onRequestDelete={handleRequestDelete}
                    onRename={handleRename}
                    onTogglePin={handleTogglePin}
                    onToggleArchive={handleToggleArchive}
                  />
                ))
              ) : (
                <div className="px-3 py-2 text-[11px] text-foreground/30">没有星标对话，点会话旁的星标收藏</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Workflow 模式：侧边栏显示工作流列表（模板 / 我的 Workflow / 运行历史），底部工作模块常驻 */}
      {activeView === 'workflow' ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-3 pt-3 pb-2 flex-1 min-h-0">
            <WorkflowSidebarList />
          </div>
          {renderWorkModule()}
        </div>
      ) : mode === 'agent' && viewMode === 'active' ? (
        <div className="flex-1 flex flex-col min-h-0">
          {/* ===== 项目列表（常驻） ===== */}
          <>
            {/* 标题 + 新建项目 */}
              <div className="px-3 pt-2 pb-1 flex items-center justify-between flex-shrink-0">
                <span className="text-[11px] font-medium text-foreground/40 select-none">进行中的项目</span>
                <div className="flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => { void window.electronAPI.openFolderDialog().then((folder) => {
                          if (!folder) return
                          return window.electronAPI.createAgentWorkspace(folder.name, folder.path)
                            .then((ws) => { setWorkspaces((prev) => [ws, ...prev]); setCurrentAgentWorkspaceId(ws.id); window.electronAPI.updateSettings({ agentWorkspaceId: ws.id }).catch(console.error) })
                            .catch((err) => toast.error(err instanceof Error ? err.message : '打开本地项目失败'))
                        }) }}
                        className="p-1 rounded hover:bg-foreground/[0.06] text-foreground/35 hover:text-foreground/60 transition-colors titlebar-no-drag"
                        title="打开本地项目文件夹"
                      >
                        <FolderPlus size={13} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">打开本地项目文件夹</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={handleStartCreateProject}
                        className="p-1 rounded hover:bg-foreground/[0.06] text-foreground/35 hover:text-foreground/60 transition-colors titlebar-no-drag"
                        title="新建项目"
                      >
                        <Plus size={13} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">新建项目</TooltipContent>
                  </Tooltip>
                </div>
              </div>

              {/* 新建项目输入框 */}
              {creatingProject && (
                <div className="px-3 pb-1 flex-shrink-0">
                  <div className="flex items-center gap-2 px-2 py-[5px] rounded-md bg-foreground/[0.03]">
                    <FolderOpen size={13} className="flex-shrink-0 text-foreground/40" />
                    <input
                      ref={createProjectInputRef}
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                      onKeyDown={handleCreateProjectKeyDown}
                      onBlur={() => { setCreatingProject(false); setNewProjectName('') }}
                      placeholder="项目名称..."
                      className="flex-1 min-w-0 bg-transparent text-[13px] text-foreground border-b border-primary/50 outline-none px-0.5"
                      maxLength={50}
                    />
                  </div>
                </div>
              )}

              {/* 项目列表：扁平树状（无卡片边框） */}
              <div className="flex-1 overflow-y-auto px-2 pb-3 scrollbar-none min-h-0">
                {projectList.length === 0 ? (
                  <div className="px-2 py-3 text-[11px] text-foreground/30 text-center select-none">
                    暂无项目，点击上方 + 新建
                  </div>
                ) : (
                  <div className="flex flex-col">
                    {projectList.map((ws) => {
                      const wsSessions = sessionsByWorkspace.get(ws.id) ?? []
                      const isCurrent = ws.id === currentWorkspaceId
                      const expanded = expandedProjectIds.has(ws.id)
                      // 协作子会话树：把子会话挂到父会话下（根会话出现在列表，子会话跟随父会话缩进）
                      const wsTreeItems = buildAgentSessionTrees(wsSessions)
                      // 「显示更多」基于根会话计数；若有子会话的父会话语义为需要展示，则保持展开
                      const rootCount = wsTreeItems.length
                      const visibleRoots = expanded ? wsTreeItems : wsTreeItems.slice(0, 5)
                      const hasMore = rootCount > 5
                      return (
                        <div key={ws.id}>
                          {/* 项目行（无边框，扁平树） */}
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              if (!isCurrent) {
                                setCurrentAgentWorkspaceId(ws.id)
                                window.electronAPI.updateSettings({ agentWorkspaceId: ws.id }).catch(console.error)
                              }
                              toggleProjectExpanded(ws.id)
                            }}
                            className={cn(
                              'group flex items-center gap-1.5 pl-1 pr-2 py-[6px] rounded-md cursor-pointer titlebar-no-drag transition-colors',
                              isCurrent
                                ? 'bg-foreground/[0.07]'
                                : 'hover:bg-foreground/[0.04]'
                            )}
                          >
                            {/* 文件夹图标 */}
                            <FolderOpen size={13} className={cn('flex-shrink-0', isCurrent ? 'text-foreground/70' : 'text-foreground/40')} />

                            <span className={cn('flex-1 min-w-0 truncate text-[13px]', isCurrent ? 'text-foreground font-medium' : 'text-foreground/75')}>
                              {ws.name}
                            </span>

                            {/* 本地项目标签 */}
                            {ws.rootPath && (
                              <span className="flex-shrink-0 px-1.5 py-[1px] rounded-full bg-foreground/[0.06] text-[10px] text-foreground/45 select-none">
                                本地项目
                              </span>
                            )}

                            {/* 右侧操作区（hover 时展开） */}
                            <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              {/* 项目内新会话按钮 */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setCurrentAgentWorkspaceId(ws.id)
                                  window.electronAPI.updateSettings({ agentWorkspaceId: ws.id }).catch(console.error)
                                  void handleNewAgentSessionInWorkspace(ws.id)
                                }}
                                className="p-1 rounded hover:bg-foreground/[0.08] text-foreground/30 hover:text-foreground/60 transition-colors titlebar-no-drag"
                                title="在该项目新建会话"
                              >
                                <Plus size={13} />
                              </button>

                              {/* 删除项目 */}
                              {canDeleteWorkspace(ws) && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleRequestDeleteWorkspace(ws.id)
                                  }}
                                  className="p-1 rounded hover:bg-destructive/10 text-foreground/30 hover:text-destructive transition-colors titlebar-no-drag"
                                  title="删除项目"
                                >
                                  <Trash2 size={12} />
                                </button>
                              )}
                            </div>

                            {/* 展开/收起箭头 */}
                            <ChevronRight
                              size={13}
                              className={cn(
                                'flex-shrink-0 text-foreground/30 transition-transform duration-150',
                                expanded && 'rotate-90'
                              )}
                            />
                          </div>

                          {/* 项目下会话列表（父子树） */}
                          {wsSessions.length > 0 && (
                            <div className="pb-1">
                              <div className="flex flex-col gap-px pl-1 border-l-2 border-primary/15 ml-[15px]">
                                {visibleRoots.map((item) => {
                                  const childCount = item.childSessions.length
                                  const treeActive = treeContainsSessionId(item, activeTabId)
                                  const activeChildVisible = item.childSessions.some((child) => child.id === activeTabId)
                                  const expandedChildren = expandedDelegationParentIds.has(item.session.id)
                                    || (activeChildVisible && !collapsedDelegationParentIds.has(item.session.id))
                                  return (
                                    <div key={item.session.id} className="flex flex-col gap-px">
                                      <AgentSessionItem
                                        session={item.session}
                                        active={treeActive}
                                        indicatorStatus={getSessionTreeStatus(item, agentIndicatorMap)}
                                        isInWorkingSection={workingSessionIds.has(item.session.id)}
                                        delegationSummary={childCount > 0
                                          ? {
                                            total: childCount,
                                            completed: countCompletedDelegatedChildren(item.childSessions),
                                            expanded: expandedChildren,
                                            onToggle: () => handleToggleDelegationParent(item.session.id, expandedChildren),
                                          }
                                          : undefined}
                                        onSelect={handleSelectAgentSession}
                                        onOpenPermanent={handlePermanentAgentSession}
                                        onRequestDelete={handleRequestDelete}
                                        onRequestMove={handleRequestMove}
                                        onRename={handleAgentRename}
                                        onTogglePin={handleTogglePinAgent}
                                        onToggleManualWorking={handleToggleManualWorkingAgent}
                                        onToggleArchive={handleToggleArchiveAgent}
                                      />
                                      {childCount > 0 && expandedChildren && (
                                        <div className="ml-3 border-l border-foreground/10 pl-2 flex flex-col gap-px">
                                          {item.childSessions.map((child) => (
                                            <DelegatedChildSessionItem
                                              key={child.id}
                                              session={child}
                                              activeSessionId={activeTabId}
                                              agentIndicatorMap={agentIndicatorMap}
                                              workspaceName={undefined}
                                              onSelect={handleSelectAgentSession}
                                              onOpenPermanent={handlePermanentAgentSession}
                                              onRequestDelete={handleRequestDelete}
                                              onRequestMove={handleRequestMove}
                                              onRename={handleAgentRename}
                                              onTogglePin={handleTogglePinAgent}
                                              onToggleManualWorking={handleToggleManualWorkingAgent}
                                              onToggleArchive={handleToggleArchiveAgent}
                                            />
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                              {hasMore && (
                                <button
                                  onClick={() => toggleProjectExpanded(ws.id)}
                                  className="ml-[15px] mt-0.5 flex items-center gap-1 px-2 py-1 text-[11px] text-foreground/40 hover:text-foreground/70 transition-colors titlebar-no-drag"
                                >
                                  {expanded ? '收起' : `更多 (${wsTreeItems.length - 5})`}
                                  <ChevronDown size={11} className={cn('transition-transform duration-150', expanded && 'rotate-180')} />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* 工作模块（复用 renderWorkModule，项目列表与 workflow 列表共用底部区块） */}
              {renderWorkModule()}
          </>
        </div>
      ) : (
        <>
          {/* 归档视图标题栏 */}
          {viewMode === 'archived' && (
            <div className="px-6 pt-3 pb-1">
              <div className="text-[12px] font-medium text-foreground/40">
                已归档{mode === 'agent' ? '会话' : '对话'}
              </div>
            </div>
          )}

          {/* Chat 模式 / 归档视图：单列表布局 */}
          <div className="flex-1 overflow-y-auto px-3 pt-2 pb-3 scrollbar-none">
            {mode === 'chat' ? (
              /* Chat 模式：对话按日期分组 */
              conversationGroups.map((group) => (
                <div key={group.label} className="mb-1">
                  <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-foreground/40 select-none">
                    {group.label}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {group.items.map((conv) => (
                      <ConversationItem
                        key={conv.id}
                        conversation={conv}
                        active={conv.id === activeTabId}
                        streaming={streamingIds.has(conv.id)}
                        showPinIcon={!!conv.pinned}
                        onSelect={handleSelectConversation}
                        onOpenPermanent={handlePermanentConversation}
                        onRequestDelete={handleRequestDelete}
                        onRename={handleRename}
                        onTogglePin={handleTogglePin}
                        onToggleArchive={handleToggleArchive}
                      />
                    ))}
                  </div>
                </div>
              ))
            ) : (
              /* Agent 模式归档：Agent 会话按日期分组 */
              agentSessionGroups.map((group) => (
                <div key={group.label} className="mb-1">
                  <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-foreground/40 select-none">
                    {group.label}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {group.items.map((session) => (
                      <AgentSessionItem
                        key={session.id}
                        session={session}
                        active={session.id === activeTabId}
                        indicatorStatus={agentIndicatorMap.get(session.id) ?? 'idle'}
                        isInWorkingSection={workingSessionIds.has(session.id)}
                        onSelect={handleSelectAgentSession}
                        onOpenPermanent={handlePermanentAgentSession}
                        onRequestDelete={handleRequestDelete}
                        onRequestMove={handleRequestMove}
                        onRename={handleAgentRename}
                        onTogglePin={handleTogglePinAgent}
                        onToggleManualWorking={handleToggleManualWorkingAgent}
                        onToggleArchive={handleToggleArchiveAgent}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* 已归档入口 / 返回活跃对话 */}
      <div className="px-3 pb-1">
        {viewMode === 'active' ? (
          <>
            {mode === 'chat' && archivedConversationCount > 0 && (
              <button
                onClick={() => setViewMode('archived')}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-[10px] text-[12px] text-foreground/40 hover:bg-foreground/[0.04] hover:text-foreground/60 transition-colors titlebar-no-drag"
              >
                <Archive size={13} className="text-foreground/30" />
                <span>已归档 ({archivedConversationCount})</span>
              </button>
            )}
            {mode === 'agent' && archivedAgentSessionCount > 0 && (
              <button
                onClick={() => setViewMode('archived')}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-[10px] text-[12px] text-foreground/40 hover:bg-foreground/[0.04] hover:text-foreground/60 transition-colors titlebar-no-drag"
              >
                <Archive size={13} className="text-foreground/30" />
                <span>已归档 ({archivedAgentSessionCount})</span>
              </button>
            )}
          </>
        ) : (
          <button
            onClick={() => setViewMode('active')}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-[10px] text-[12px] text-foreground/60 bg-foreground/[0.04] hover:bg-foreground/[0.07] hover:text-foreground/80 transition-colors titlebar-no-drag"
          >
            <ArrowLeft size={13} className="text-foreground/50" />
            <span>返回活跃{mode === 'agent' ? '会话' : '对话'}</span>
          </button>
        )}
      </div>

      {/* 底部：用户资料 + 设置入口 */}
      <div className="px-3 pb-3">
        <button
          onClick={() => setSettingsOpen(true)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-[10px] transition-colors titlebar-no-drag text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground"
        >
          <UserAvatar avatar={userProfile.avatar} size={28} />
          <span className="flex-1 text-sm truncate text-left">{userProfile.userName}</span>
          <div className="relative flex-shrink-0 text-foreground/40">
            <Settings size={16} />
            {(hasUpdate || hasEnvironmentIssues) && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
            )}
          </div>
        </button>
      </div>

      {deleteDialog}
      {deleteWorkspaceDialog}
      {moveDialog}
      <SearchDialog />
    </div>
  )
}

// ===== 对话列表项 =====

interface ConversationItemProps {
  conversation: ConversationMeta
  active: boolean
  streaming: boolean
  /** 是否在标题旁显示星标图标 */
  showPinIcon: boolean
  onSelect: (id: string, title: string) => void
  /** 双击 → 常驻标签打开（VS Code 风格） */
  onOpenPermanent: (id: string, title: string) => void
  onRequestDelete: (id: string) => void
  onRename: (id: string, newTitle: string) => Promise<void>
  onTogglePin: (id: string) => Promise<void>
  onToggleArchive: (id: string) => Promise<void>
}

const ConversationItem = React.memo(function ConversationItem({
  conversation,
  active,
  streaming,
  showPinIcon,
  onSelect,
  onOpenPermanent,
  onRequestDelete,
  onRename,
  onTogglePin,
  onToggleArchive,
}: ConversationItemProps): React.ReactElement {
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)
  const justStartedEditing = React.useRef(false)

  /** 进入编辑模式 */
  const startEdit = (): void => {
    setEditTitle(conversation.title)
    setEditing(true)
    justStartedEditing.current = true
    // 延迟聚焦，等待 ContextMenu 完全关闭后再 focus
    setTimeout(() => {
      justStartedEditing.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 300)
  }

  /** 保存标题 */
  const saveTitle = async (): Promise<void> => {
    // ContextMenu 关闭导致的 blur，忽略
    if (justStartedEditing.current) return
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === conversation.title) {
      setEditing(false)
      return
    }
    await onRename(conversation.id, trimmed)
    setEditing(false)
  }

  /** 键盘事件 */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  const isPinned = !!conversation.pinned

  const menuItems = (
    MenuItem: typeof ContextMenuItem | typeof DropdownMenuItem,
    MenuSeparator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
  ) => (
    <>
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onTogglePin(conversation.id)}>
        {isPinned ? <StarOff size={14} /> : <Star size={14} />}
        {isPinned ? '取消星标' : '星标对话'}
      </MenuItem>
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => startEdit()}>
        <Pencil size={14} />
        重命名
      </MenuItem>
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onToggleArchive(conversation.id)}>
        {conversation.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        {conversation.archived ? '取消归档' : '归档'}
      </MenuItem>
      <MenuSeparator className="my-0.5" />
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5 text-destructive" onSelect={() => onRequestDelete(conversation.id)}>
        <Trash2 size={14} />
        删除对话
      </MenuItem>
    </>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(conversation.id, conversation.title)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            onOpenPermanent(conversation.id, conversation.title)
          }}
          className={cn(
            'group relative w-full flex items-center gap-2 px-3 py-[4px] rounded-md transition-colors duration-100 titlebar-no-drag text-left',
            active
              ? 'session-item-selected bg-primary/10 shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
              : 'hover:bg-primary/5'
          )}
        >
          {/* 流式状态左侧竖线条（与 Agent 保持一致） */}
          {streaming && (
            <span
              className="absolute left-1 top-1.5 bottom-1.5 w-[2px] rounded-full bg-emerald-500 animate-pulse pointer-events-none"
              aria-hidden="true"
            />
          )}
          <div className="flex-1 min-w-0">
            {editing ? (
              <input
                ref={inputRef}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={saveTitle}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-transparent text-[13px] leading-5 text-foreground border-b border-primary/50 outline-none px-0 py-0"
                maxLength={100}
              />
            ) : (
              <div className={cn(
                'truncate text-[13px] leading-5 flex items-center gap-1.5',
                active ? 'text-foreground' : 'text-foreground/80'
              )}>
                {/* 星标标记 */}
                {showPinIcon && (
                  <Star size={11} className="flex-shrink-0 text-amber-500 fill-current" />
                )}
                <span className="truncate">{conversation.title}</span>
              </div>
            )}
          </div>

          {/* 三点菜单按钮（hover 时可见，始终占位避免跳动） */}
          {!editing && (
            <div
              className="flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className={cn(
                      'p-1 rounded-md text-foreground/30 hover:bg-foreground/[0.08] hover:text-foreground/60 transition-colors',
                      'opacity-0 pointer-events-none',
                      'group-hover:opacity-100 group-hover:pointer-events-auto',
                      'data-[state=open]:bg-foreground/[0.08] data-[state=open]:text-foreground/60 data-[state=open]:opacity-100 data-[state=open]:pointer-events-auto',
                    )}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40 z-[9999] min-w-0 p-0.5">
                  {menuItems(DropdownMenuItem, DropdownMenuSeparator)}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40 z-[9999] min-w-0 p-0.5">
        {menuItems(ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>
    </ContextMenu>
  )
})

// ===== Agent 会话列表项 =====

/** 会话行左侧状态色块的颜色 — 与 SessionIndicatorStatus 呼应 */
type SessionLeftAccent = 'orange' | 'blue' | 'green'
const SESSION_LEFT_ACCENT_CLASS: Record<SessionLeftAccent, string> = {
  orange: 'bg-orange-500',
  blue: 'bg-blue-500',
  green: 'bg-green-500',
}

interface AgentSessionItemProps {
  session: AgentSessionMeta
  active: boolean
  indicatorStatus: SessionIndicatorStatus
  /** 是否在工作中分区（auto 或 manual） */
  isInWorkingSection?: boolean
  /** 行左侧状态色块；未传则不显示 */
  leftAccent?: SessionLeftAccent
  /** 工作区名称 Badge（跨工作区列表时显示） */
  workspaceName?: string
  /** collaboration 协作子会话树折叠摘要；父会话有子会话时传入以显示折叠钮 */
  delegationSummary?: {
    /** 子会话数量 */
    total: number
    /** 已完成的子会话数 */
    completed: number
    /** 当前是否展开 */
    expanded: boolean
    /** 切换展开/折叠 */
    onToggle: () => void
  }
  onSelect: (id: string, title: string) => void
  /** 双击 → 常驻标签打开（VS Code 风格） */
  onOpenPermanent: (id: string, title: string) => void
  onRequestDelete: (id: string) => void
  onRequestMove: (id: string) => void
  onRename: (id: string, newTitle: string) => Promise<void>
  onTogglePin: (id: string) => Promise<void>
  onToggleManualWorking: (id: string) => Promise<void>
  onToggleArchive: (id: string) => Promise<void>
}

const AgentSessionItem = React.memo(function AgentSessionItem({
  session,
  active,
  indicatorStatus,
  isInWorkingSection,
  leftAccent,
  workspaceName,
  delegationSummary,
  onSelect,
  onOpenPermanent,
  onRequestDelete,
  onRequestMove,
  onRename,
  onTogglePin,
  onToggleManualWorking,
  onToggleArchive,
}: AgentSessionItemProps): React.ReactElement {
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)
  const justStartedEditing = React.useRef(false)

  const startEdit = (): void => {
    setEditTitle(session.title)
    setEditing(true)
    justStartedEditing.current = true
    setTimeout(() => {
      justStartedEditing.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 300)
  }

  const saveTitle = async (): Promise<void> => {
    if (justStartedEditing.current) return
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === session.title) {
      setEditing(false)
      return
    }
    await onRename(session.id, trimmed)
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  const isWorking = isInWorkingSection || session.manualWorking
  const canMove = indicatorStatus === 'idle' || indicatorStatus === 'completed'

  const menuItems = (
    MenuItem: typeof ContextMenuItem | typeof DropdownMenuItem,
    MenuSeparator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
  ) => (
    <>
      <MenuItem
        className="text-xs py-1 [&>svg]:size-3.5"
        disabled={indicatorStatus === 'running'}
        onSelect={() => { if (indicatorStatus !== 'running') onToggleManualWorking(session.id) }}
      >
        <Hammer size={14} className={isWorking ? 'fill-current' : ''} />
        {indicatorStatus === 'running' ? '运行中无法移出' : isWorking ? '取消工作中' : '标记为工作中'}
      </MenuItem>
      {canMove && (
        <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onRequestMove(session.id)}>
          <ArrowRightLeft size={14} />
          迁移到其他工作区
        </MenuItem>
      )}
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => startEdit()}>
        <Pencil size={14} />
        重命名
      </MenuItem>
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onToggleArchive(session.id)}>
        {session.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        {session.archived ? '取消归档' : '归档'}
      </MenuItem>
      <MenuSeparator className="my-0.5" />
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5 text-destructive" onSelect={() => onRequestDelete(session.id)}>
        <Trash2 size={14} />
        删除会话
      </MenuItem>
    </>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(session.id, session.title)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            onOpenPermanent(session.id, session.title)
          }}
          className={cn(
            'group relative w-full flex items-center gap-2 px-3 py-[4px] rounded-md transition-colors duration-100 titlebar-no-drag text-left',
            active
              ? 'session-item-selected bg-primary/10 shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
              : 'hover:bg-primary/5'
          )}
        >
          {leftAccent && (
            <span
              className={cn(
                'absolute left-1 top-1.5 bottom-1.5 w-[2px] rounded-full pointer-events-none',
                SESSION_LEFT_ACCENT_CLASS[leftAccent]
              )}
            />
          )}
          <div className="flex-1 min-w-0">
            {editing ? (
              <input
                ref={inputRef}
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={saveTitle}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-transparent text-[13px] leading-5 text-foreground border-b border-primary/50 outline-none px-0 py-0"
                maxLength={100}
              />
            ) : (
              <div className={cn(
                'truncate text-[13px] leading-5 flex items-center gap-1.5',
                active ? 'text-foreground' : 'text-foreground/80'
              )}>
                <span className="truncate">{session.title}</span>
                {/* 星标按钮：直接点击切换，已星标=实心琥珀 ⭐，未星标=弱化空星 */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    void onTogglePin(session.id)
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={session.pinned ? '取消星标' : '星标会话'}
                  className={cn(
                    'flex-shrink-0 rounded p-0.5 transition-colors',
                    session.pinned
                      ? 'text-amber-500 hover:text-amber-400'
                      : 'text-foreground/20 hover:text-foreground/50 opacity-0 group-hover:opacity-100'
                  )}
                >
                  <Star size={11} className={cn(session.pinned && 'fill-current')} />
                </button>
                {workspaceName && (
                  <span className="flex-shrink-0 px-1.5 py-0 rounded-full bg-primary/10 text-[10px] leading-4 workspace-badge font-medium truncate max-w-[80px]">
                    {workspaceName}
                  </span>
                )}
                {delegationSummary && delegationSummary.total > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      delegationSummary.onToggle()
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title={delegationSummary.expanded ? '折叠协作子会话' : '展开协作子会话'}
                    className="flex-shrink-0 flex items-center gap-0.5 rounded px-1 py-0 text-[10px] leading-4 text-foreground/50 hover:bg-foreground/[0.07] hover:text-foreground/80 transition-colors"
                  >
                    <ChevronRight
                      size={11}
                      className={cn('transition-transform duration-150', delegationSummary.expanded && 'rotate-90')}
                    />
                    <span className="tabular-nums">
                      {delegationSummary.completed}/{delegationSummary.total}
                    </span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 会话级运行状态呼吸灯（running=蓝 / blocked=橙 / completed=绿，无文字；completed 点击会话后消失） */}
          {(indicatorStatus === 'running' || indicatorStatus === 'blocked' || indicatorStatus === 'completed') && (
            <span
              className={cn(
                'sidebar-breathe-dot flex-shrink-0 w-1.5 h-1.5 bg-current',
                indicatorStatus === 'blocked'
                  ? 'sidebar-breathe-blocked text-orange-500'
                  : indicatorStatus === 'completed'
                    ? 'sidebar-breathe-completed text-green-500'
                    : 'sidebar-breathe-running text-blue-500'
              )}
              aria-hidden="true"
            />
          )}

          {/* 三点菜单按钮（hover 时可见，始终占位避免跳动） */}
          {!editing && (
            <div
              className="flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className={cn(
                      'p-1 rounded-md text-foreground/30 hover:bg-foreground/[0.08] hover:text-foreground/60 transition-colors',
                      'opacity-0 pointer-events-none',
                      'group-hover:opacity-100 group-hover:pointer-events-auto',
                      'data-[state=open]:bg-foreground/[0.08] data-[state=open]:text-foreground/60 data-[state=open]:opacity-100 data-[state=open]:pointer-events-auto',
                    )}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40 z-[9999] min-w-0 p-0.5">
                  {menuItems(DropdownMenuItem, DropdownMenuSeparator)}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40 z-[9999] min-w-0 p-0.5">
        {menuItems(ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>
    </ContextMenu>
  )
})

// ===== Collaboration 协作子会话树 =====

/** 识别协作子会话（由父会话委派创建、可追踪的真实会话节点） */
function isDelegatedChildSession(session: AgentSessionMeta): boolean {
  return !!session.parentSessionId && !!session.sourceDelegationId
}

interface AgentSessionTreeItem {
  session: AgentSessionMeta
  childSessions: AgentSessionMeta[]
}

/** 把平铺会话列表按父子关系构建为树（子会话挂到其父会话下） */
function buildAgentSessionTrees(sessions: AgentSessionMeta[]): AgentSessionTreeItem[] {
  const sessionIds = new Set(sessions.map((s) => s.id))
  const childrenByParentId = new Map<string, AgentSessionMeta[]>()
  const roots: AgentSessionMeta[] = []

  for (const session of sessions) {
    if (isDelegatedChildSession(session) && session.parentSessionId && sessionIds.has(session.parentSessionId)) {
      const children = childrenByParentId.get(session.parentSessionId) ?? []
      children.push(session)
      childrenByParentId.set(session.parentSessionId, children)
      continue
    }
    roots.push(session)
  }

  return roots.map((session) => ({
    session,
    childSessions: childrenByParentId.get(session.id) ?? [],
  }))
}

/** 获取协作子会话状态（优先 indicatorMap，其次 delegationStatus=running） */
function getDelegatedChildStatus(
  session: AgentSessionMeta,
  agentIndicatorMap: Map<string, SessionIndicatorStatus>,
): SessionIndicatorStatus {
  const status = agentIndicatorMap.get(session.id)
  if (status) return status
  return session.delegationStatus === 'running' ? 'running' : 'idle'
}

/** 聚合父会话 + 其子会话整体状态（blocked > running > completed > idle） */
function getSessionTreeStatus(
  item: AgentSessionTreeItem,
  agentIndicatorMap: Map<string, SessionIndicatorStatus>,
): SessionIndicatorStatus {
  const statuses = [
    agentIndicatorMap.get(item.session.id) ?? 'idle',
    ...item.childSessions.map((s) => getDelegatedChildStatus(s, agentIndicatorMap)),
  ]
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.includes('running')) return 'running'
  if (statuses.includes('completed')) return 'completed'
  return 'idle'
}

/** 统计已完成子会话数量 */
function countCompletedDelegatedChildren(childSessions: AgentSessionMeta[]): number {
  return childSessions.filter((s) => s.delegationStatus === 'completed').length
}

/** 判断某会话是否出现在树的父/子节点中 */
function treeContainsSessionId(item: AgentSessionTreeItem, sessionId: string | null): boolean {
  if (!sessionId) return false
  return item.session.id === sessionId || item.childSessions.some((s) => s.id === sessionId)
}

/** 协作子会话行：复用 AgentSessionItem，通过 delegation 状态与缩进区分 */
const DelegatedChildSessionItem = React.memo(function DelegatedChildSessionItem({
  session,
  activeSessionId,
  agentIndicatorMap,
  workspaceName,
  onSelect,
  onOpenPermanent,
  onRequestDelete,
  onRequestMove,
  onRename,
  onTogglePin,
  onToggleManualWorking,
  onToggleArchive,
}: {
  session: AgentSessionMeta
  activeSessionId: string | null
  agentIndicatorMap: Map<string, SessionIndicatorStatus>
  workspaceName?: string
  onSelect: (id: string, title: string) => void
  onOpenPermanent: (id: string, title: string) => void
  onRequestDelete: (id: string) => void
  onRequestMove: (id: string) => void
  onRename: (id: string, newTitle: string) => Promise<void>
  onTogglePin: (id: string) => Promise<void>
  onToggleManualWorking: (id: string) => Promise<void>
  onToggleArchive: (id: string) => Promise<void>
}): React.ReactElement {
  return (
    <AgentSessionItem
      session={session}
      active={session.id === activeSessionId}
      indicatorStatus={getDelegatedChildStatus(session, agentIndicatorMap)}
      leftAccent="blue"
      workspaceName={workspaceName}
      onSelect={onSelect}
      onOpenPermanent={onOpenPermanent}
      onRequestDelete={onRequestDelete}
      onRequestMove={onRequestMove}
      onRename={onRename}
      onTogglePin={onTogglePin}
      onToggleManualWorking={onToggleManualWorking}
      onToggleArchive={onToggleArchive}
    />
  )
})

/**
 * SubscribedCapabilities — 已订阅领域能力包导航区
 *
 * 在 core 工作模块下方展示已订阅的领域包（influencer/paid-media），
 * 点击切换视图；末尾提供「能力中心」入口打开订阅面板。
 */
function SubscribedCapabilities(): React.ReactElement {
  const [enabled] = useAtom(enabledCapabilitiesAtom)
  const activeView = useAtomValue(activeViewAtom)
  const setActiveView = useSetAtom(activeViewAtom)

  const subscribedBusiness = CAPABILITY_MANIFEST.filter(
    (c) => c.kind === 'business' && isCapabilityEnabled(enabled, c.id as CapabilityId)
  )

  const iconFor = (id: string): React.ReactNode => {
    if (id === 'paid-media') return <Megaphone size={16} className="text-foreground/40" />
    return <Users size={16} className="text-foreground/40" />
  }

  return (
    <>
      {subscribedBusiness.length > 0 && (
        <div className="mt-1 px-2 pt-1.5 text-[11px] font-medium text-foreground/40 select-none">领域能力包</div>
      )}
      {subscribedBusiness.map((cap) => {
        const capabilityId = cap.id as CapabilityId
        const active = activeView === capabilityId
        return (
          <button
            key={cap.id}
            onClick={() => setActiveView(capabilityId)}
            className={cn(
              'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-colors titlebar-no-drag',
              active
                ? 'bg-primary text-primary-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
                : 'text-foreground/55 hover:bg-foreground/[0.04] hover:text-foreground/80'
            )}
          >
            {iconFor(cap.id)}
            <span className="flex-1 text-left">{cap.label}</span>
          </button>
        )
      })}
    </>
  )
}
