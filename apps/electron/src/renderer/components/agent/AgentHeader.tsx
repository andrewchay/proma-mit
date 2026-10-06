/**
 * AgentHeader — Agent 会话头部
 *
 * 显示会话标题（可点击编辑）。
 * 参照 ChatHeader 的编辑模式。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Pencil, Check, X, PanelRight, Globe2, Square, Target } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agentSessionsAtom, agentSidePanelOpenAtom, workspaceFilesVersionAtom } from '@/atoms/agent-atoms'
import { tabsAtom, updateTabTitle } from '@/atoms/tab-atoms'
import { registerShortcut } from '@/lib/shortcut-registry'
import type { AgentSessionMeta, Goal } from '@gravitas/shared'
import { SpanWaterfallPanel } from './SpanWaterfallPanel'

/** AgentHeader 属性接口 */
interface AgentHeaderProps {
  sessionId: string
}

interface WebBridgeStatus {
  active: boolean
  mode?: 'managed' | 'chrome-cdp'
  url?: string
  accessibilityAvailable: boolean
}

export function AgentHeader({ sessionId }: AgentHeaderProps): React.ReactElement | null {
  const sessions = useAtomValue(agentSessionsAtom)
  const session = sessions.find((s) => s.id === sessionId) ?? null
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const [editing, setEditing] = React.useState(false)
  const [webBridgeStatus, setWebBridgeStatus] = React.useState<WebBridgeStatus>({ active: false, accessibilityAvailable: false })
  const [stoppingWebBridge, setStoppingWebBridge] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // 文件面板切换状态（全局共享）
  const [isPanelOpen, setSidePanelOpen] = useAtom(agentSidePanelOpenAtom)
  const filesVersion = useAtomValue(workspaceFilesVersionAtom)
  const hasFileChanges = filesVersion > 0

  const togglePanel = React.useCallback(() => {
    setSidePanelOpen((v) => !v)
  }, [setSidePanelOpen])

  React.useEffect(() => {
    return registerShortcut('toggle-right-panel', togglePanel)
  }, [togglePanel])

  React.useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      window.electronAPI.getWebBridgeStatus(sessionId)
        .then((status) => { if (!cancelled) setWebBridgeStatus(status) })
        .catch(() => { if (!cancelled) setWebBridgeStatus({ active: false, accessibilityAvailable: false }) })
    }
    refresh()
    const timer = window.setInterval(refresh, 2_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [sessionId])

  const stopWebBridge = async (): Promise<void> => {
    if (stoppingWebBridge) return
    setStoppingWebBridge(true)
    try {
      await window.electronAPI.stopWebBridge(sessionId)
      setWebBridgeStatus({ active: false, accessibilityAvailable: false })
    } catch (error) {
      console.error('[AgentHeader] 停止 Web Bridge 失败:', error)
    } finally {
      setStoppingWebBridge(false)
    }
  }

  if (!session) return null

  /** 进入编辑模式 */
  const startEdit = (): void => {
    setEditTitle(session.title)
    setEditing(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  /** 保存标题 */
  const saveTitle = async (): Promise<void> => {
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === session.title) {
      setEditing(false)
      return
    }

    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(session.id, trimmed)
      // 同步更新标签页标题
      setTabs((prev) => updateTabTitle(prev, updated.id, updated.title))
      // 同步更新侧边栏会话列表
      setAgentSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s))
      )
    } catch (error) {
      console.error('[AgentHeader] 更新标题失败:', error)
    }
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

  return (
    <div className="relative z-[51] flex items-center gap-2 px-4 h-[48px]">
      {/* 拖拽层仅覆盖左侧区域，避开右上角 WindowControls（Windows 上 ~126px）。
          否则 header 的 drag-region 会与按钮重叠，导致 OS hitmask 把单击当成标题栏点击。 */}
      <div className="absolute inset-0 right-[126px] titlebar-drag-region pointer-events-none" />
      {editing ? (
        <div className="flex items-center gap-1.5 flex-1 min-w-0 titlebar-no-drag">
          <input
            ref={inputRef}
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={saveTitle}
            className="flex-1 bg-transparent text-sm font-medium border-b border-primary/50 outline-none px-0 py-0.5 min-w-0"
            maxLength={100}
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={saveTitle}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Check className="size-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(false)}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <span className="truncate text-sm font-medium text-foreground">
              {session.title}
            </span>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={startEdit}
              className="titlebar-no-drag p-1 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="编辑标题"
            >
              <Pencil className="size-3.5" />
            </button>
          </div>
          <ProjectBindingControl session={session} setSessions={setAgentSessions} />
          <GoalBindingControl sessionId={sessionId} />
          <SpanWaterfallPanel sessionId={sessionId} />
          {webBridgeStatus.active && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="titlebar-no-drag flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300">
                  <Globe2 className="size-3" />
                  <span>{webBridgeStatus.mode === 'chrome-cdp' ? 'Chrome 已连接' : 'Web Bridge 运行中'}</span>
                  <Button type="button" variant="ghost" size="icon" className="ml-0.5 size-4 hover:bg-emerald-500/20" onClick={stopWebBridge} disabled={stoppingWebBridge} aria-label="停止 Web Bridge">
                    <Square className="size-2.5 fill-current" />
                  </Button>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom"><p>{webBridgeStatus.url || '当前 Bridge 页面'} · 点击方块立即停止</p></TooltipContent>
            </Tooltip>
          )}
          {/* 文件面板打开按钮（面板关闭时显示） */}
          {!isPanelOpen && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="relative titlebar-no-drag h-7 w-7 flex-shrink-0"
                  onClick={togglePanel}
                >
                  <PanelRight className="size-3.5" />
                  {hasFileChanges && (
                    <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary animate-pulse" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>打开文件面板 ({navigator.platform.includes('Mac') ? '⌘⇧B' : 'Ctrl+Shift+B'})</p>
              </TooltipContent>
            </Tooltip>
          )}
        </>
      )}
    </div>
  )
}

/** 会话当前 Project 绑定控件：只能选择已与当前工作空间正式绑定的项目。 */
function ProjectBindingControl({
  session,
  setSessions,
}: {
  session: AgentSessionMeta
  setSessions: React.Dispatch<React.SetStateAction<AgentSessionMeta[]>>
}): React.ReactElement {
  const [projects, setProjects] = React.useState<Array<{ id: string; title: string }>>([])
  const [bindingProjectIds, setBindingProjectIds] = React.useState<Set<string>>(new Set())
  const [error, setError] = React.useState<string | null>(null)
  const workspaceId = session.workspaceId

  React.useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setError(null)
      try {
        const projectList = await window.electronAPI.paa.project.listProjects()
        const safeProjects = Array.isArray(projectList)
          ? projectList
              .filter((item): item is { id: string; title: string } =>
                typeof item === 'object' && item !== null &&
                typeof (item as { id?: unknown }).id === 'string' &&
                typeof (item as { title?: unknown }).title === 'string')
          : []
        if (cancelled) return
        setProjects(safeProjects)

        if (!workspaceId) {
          setBindingProjectIds(new Set())
          return
        }
        const bindings = await window.electronAPI.paa.projectWorkspace.listByWorkspace(workspaceId)
        if (cancelled) return
        setBindingProjectIds(new Set((Array.isArray(bindings) ? bindings : []).map((binding) => binding.projectId)))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    return () => { cancelled = true }
  }, [workspaceId])

  const availableProjects = React.useMemo(
    () => projects.filter((project) => bindingProjectIds.has(project.id)),
    [projects, bindingProjectIds],
  )
  const currentProjectId = session.projectId
  const currentMissingBinding = Boolean(currentProjectId && !bindingProjectIds.has(currentProjectId))
  const currentProject = projects.find((project) => project.id === currentProjectId)

  const changeProject = async (value: string): Promise<void> => {
    setError(null)
    try {
      const updated = await window.electronAPI.updateAgentSessionProject({
        sessionId: session.id,
        projectId: value || null,
      })
      setSessions((previous) => previous.map((item) => (item.id === updated.id ? updated : item)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="titlebar-no-drag flex min-w-0 items-center gap-1.5" title={error ?? '当前项目决定项目记忆与项目知识库的可读范围'}>
      <span className="text-[11px] text-muted-foreground">项目</span>
      <select
        value={currentProjectId ?? ''}
        onChange={(event) => void changeProject(event.target.value)}
        disabled={!workspaceId}
        className="h-7 max-w-[180px] rounded-md border border-border/60 bg-background px-1.5 text-xs text-foreground outline-none disabled:opacity-50"
      >
        <option value="">无项目</option>
        {currentMissingBinding && currentProjectId && (
          <option value={currentProjectId}>{currentProject?.title ?? '未绑定项目'}（需重新绑定）</option>
        )}
        {availableProjects.map((project) => (
          <option key={project.id} value={project.id}>{project.title}</option>
        ))}
      </select>
      {!workspaceId && <span className="text-[11px] text-amber-600">无工作空间</span>}
      {error && <span className="max-w-[220px] truncate text-[11px] text-destructive">{error}</span>}
    </div>
  )
}

/** E2：Goal 快速绑定控件（会话头部下拉） */
function GoalBindingControl({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const [open, setOpen] = React.useState(false)
  const [goals, setGoals] = React.useState<Goal[]>([])
  const [currentGoal, setCurrentGoal] = React.useState<Goal | null>(null)
  const ref = React.useRef<HTMLDivElement>(null)

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const [list, cur] = await Promise.all([
        window.electronAPI.listGoals(),
        window.electronAPI.goalGetSessionGoal(sessionId),
      ])
      setGoals(list)
      setCurrentGoal(cur)
    } catch (_err) {
      setGoals([])
      setCurrentGoal(null)
    }
  }, [sessionId])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  // 点击外部关闭下拉
  React.useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const bind = async (goalId: string): Promise<void> => {
    try {
      await window.electronAPI.goalBindSession(sessionId, goalId)
      await refresh()
      setOpen(false)
    } catch (_err) {
      // 绑定失败静默
    }
  }

  const unbind = async (): Promise<void> => {
    try {
      await window.electronAPI.goalUnbindSession(sessionId)
      await refresh()
      setOpen(false)
    } catch (_err) { /* 静默 */ }
  }

  return (
    <div ref={ref} className="relative titlebar-no-drag">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void refresh().then(() => setOpen((v) => !v))}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors ${
          currentGoal
            ? 'bg-primary/10 text-primary hover:bg-primary/15'
            : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
        }`}
        title={currentGoal ? `绑定到：${currentGoal.title}` : '绑定目标'}
      >
        <Target className="size-3.5" />
        <span className="max-w-[120px] truncate">
          {currentGoal ? currentGoal.title : '绑定目标'}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-[60] w-64 rounded-lg border border-border/40 bg-popover shadow-lg p-1.5">
          {currentGoal && (
            <div className="px-2 py-1.5 mb-1 rounded-md bg-primary/5 text-xs text-primary flex items-center gap-1.5">
              <Target className="size-3" />
              <span className="truncate flex-1">{currentGoal.title}</span>
              <button type="button" onClick={() => void unbind()} className="text-muted-foreground hover:text-red-500">解绑</button>
            </div>
          )}
          <div className="px-2 py-1 text-[11px] text-muted-foreground">绑定到目标</div>
          <div className="max-h-52 overflow-y-auto flex flex-col">
            {goals
              .filter((g) => !['completed', 'archived'].includes(g.phase))
              .map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => void bind(g.id)}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs hover:bg-foreground/5 text-left"
                >
                  <span className="truncate flex-1">{g.title}</span>
                  {g.id === currentGoal?.id && <span className="text-primary">✓</span>}
                </button>
              ))}
            {goals.filter((g) => !['completed', 'archived'].includes(g.phase)).length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">暂无活跃目标</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
