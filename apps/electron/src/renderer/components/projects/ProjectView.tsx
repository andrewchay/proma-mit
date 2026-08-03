/**
 * ProjectView - 项目管理模块主视图（P1.1 版本）
 *
 * v0.1 → v0.2: 支持项目详情、会议纪要导入、Agent 任务提取、草稿确认
 */

import * as React from 'react'
import { useState, useEffect, useCallback } from "react"
import { useAtomValue } from "jotai"
import { userProfileAtom } from "@/atoms/user-profile"
import type { AgentEmployeeResult, AgentExecutionResult } from '@proma/shared'
import { AgentTeamPanel, AgentExecutionBadge } from './AgentTeamPanel'

/** by-task 权限申请选项（P1） */
const PERMISSION_OPTIONS: { value: string; label: string }[] = [
  { value: 'bash', label: '⚡ 执行命令 (Bash)' },
  { value: 'write', label: '✏️ 写文件 (Write)' },
  { value: 'web', label: '🌐 联网 (Web)' },
]

/** 外部通讯录联系人（飞书/钉钉）候选结果。 */
interface ExternalContact {
  platform: "feishu" | "dingtalk"
  userId: string
  unionId?: string
  name: string
}

interface ContactPickerProps {
  value: string
  onChange: (name: string) => void
  placeholder?: string
}

/**
 * 负责人选择器：输入关键字实时搜索飞书/钉钉通讯录，选中后自动写入用户映射。
 * assignee.userId 仍使用 paa-<name>，映射表在新选时写入平台真实 ID，
 * 保证任务同步(SYNC_TASK)无需再手工配置平台 ID。
 */
function ContactPicker({ value, onChange, placeholder }: ContactPickerProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [feishuUsers, setFeishuUsers] = useState<ExternalContact[]>([])
  const [dingtalkUsers, setDingtalkUsers] = useState<ExternalContact[]>([])
  const [feishuError, setFeishuError] = useState("")
  const [dingtalkError, setDingtalkError] = useState("")
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)

  const runSearch = useCallback(async (kw: string) => {
    setLoading(true)
    setSearching(true)
    try {
      const res: { feishu: { ok: boolean; users: ExternalContact[]; error?: string }; dingtalk: { ok: boolean; users: ExternalContact[]; error?: string } } =
        await callProjectAPI("searchContactsAll", kw)
      setFeishuUsers(res.feishu.ok ? res.feishu.users : [])
      setDingtalkUsers(res.dingtalk.ok ? res.dingtalk.users : [])
      setFeishuError(res.feishu.ok ? "" : (res.feishu.error ?? "飞书通讯录不可用"))
      setDingtalkError(res.dingtalk.ok ? "" : (res.dingtalk.error ?? "钉钉通讯录不可用"))
    } catch (err) {
      setFeishuUsers([])
      setDingtalkUsers([])
      setFeishuError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setSearching(false)
    }
  }, [])

  // 关闭下拉：点击外部
  useEffect(() => {
    function onDocClick(ev: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [])

  const pick = async (c: ExternalContact) => {
    const name = c.name
    const paaUserId = `paa-${name}`
    try {
      // 合并写入用户映射：若已有另一平台映射，保持原字段，仅覆盖当前平台 ID
      const existing = await callProjectAPI<any>("getUserMapping", paaUserId)
      const base = existing && typeof existing === "object" ? existing : {}
      const mapping = {
        paaUserId,
        displayName: name,
        feishuUserId: c.platform === "feishu" ? c.userId : (base.feishuUserId ?? undefined),
        dingtalkUserId: c.platform === "dingtalk" ? c.userId : (base.dingtalkUserId ?? undefined),
        dingTalkUnionId: c.platform === "dingtalk" ? (c.unionId ?? base.dingTalkUnionId ?? undefined) : (base.dingTalkUnionId ?? undefined),
      }
      await callProjectAPI("saveUserMapping", mapping)
    } catch (err) {
      console.error("写入用户映射失败:", err)
    }
    onChange(name)
    setOpen(false)
  }

  // 展开首搜：聚焦且无关键字时列出前若干成员
  const handleFocus = () => {
    setOpen(true)
    if (!value.trim()) runSearch("")
  }

  const hasAny = feishuUsers.length > 0 || dingtalkUsers.length > 0

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); runSearch(e.target.value) }}
        onFocus={handleFocus}
        placeholder={placeholder ?? "搜索通讯录负责人（飞书/钉钉）"}
        className="w-full px-3 py-2 text-sm border rounded-md bg-background"
      />
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-64 overflow-auto rounded-md border bg-card shadow-lg">
          {loading && <div className="px-3 py-2 text-xs text-muted-foreground">搜索通讯录中…</div>}
          {!loading && !hasAny && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              未找到匹配成员。{feishuError && <div>飞书：{feishuError}</div>}{dingtalkError && <div>钉钉：{dingtalkError}</div>}
            </div>
          )}
          {!loading && (
            <>
              {feishuUsers.length > 0 && (
                <div className="px-3 py-1 text-[10px] font-medium text-muted-foreground bg-accent/50">飞书</div>
              )}
              {feishuUsers.map((c) => (
                <button key={`fs-${c.userId}`} onClick={() => pick(c)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent">
                  <span className="inline-block h-5 w-5 shrink-0 rounded-full bg-[#3370FF] text-center text-[10px] leading-5 text-white">{c.name.slice(0, 1)}</span>
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
              {dingtalkUsers.length > 0 && (
                <div className="px-3 py-1 text-[10px] font-medium text-muted-foreground bg-accent/50">钉钉</div>
              )}
              {dingtalkUsers.map((c) => (
                <button key={`dd-${c.userId}`} onClick={() => pick(c)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent">
                  <span className="inline-block h-5 w-5 shrink-0 rounded-full bg-[#0089FF] text-center text-[10px] leading-5 text-white">{c.name.slice(0, 1)}</span>
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ===== 类型定义（与主进程服务层对应） =====

interface Project {
  id: string
  title: string
  description: string
  status: 'planning' | 'active' | 'completed' | 'cancelled'
  createdAt: number
  updatedAt: number
}

interface SubTask {
  id: string
  title: string
  status: 'pending' | 'completed'
  createdAt: number
}

/** 独立执行 subTask：归属 Task，但不属于 WBS 层级。 */
interface ExecutionSubTask {
  entityType: 'subTask'
  id: string
  taskId: string
  projectId: string
  title: string
  status: 'draft' | 'pending' | 'in_progress' | 'paused' | 'completed'
  assignee?: { userId: string; displayName: string }
  startDate?: number
  dueDate?: number
  completedAt?: number
  completionNotes?: string
  externalSync?: Record<string, { taskId: string; status: string; syncedAt?: number }>
  createdAt: number
  updatedAt: number
}

interface Task {
  id: string
  projectId: string
  /** 父任务 ID，存在时该任务为子任务 */
  parentId?: string
  title: string
  description: string
  status: 'draft' | 'pending' | 'in_progress' | 'paused' | 'completed'
  priority: 'low' | 'medium' | 'high' | 'critical'
  assignee?: { userId: string; displayName: string }
  startDate?: number
  dueDate?: number
  completedAt?: number
  externalSync?: Record<string, { taskId: string; status: string; syncedAt: number }>
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  completionNotes?: string
  permissionRequests?: string[]
  /** @deprecated 子任务已升级为独立 Task，请使用 parentId 关联 */
  subTasks?: SubTask[]
  createdAt: number
  updatedAt: number
}

interface MeetingNote {
  id: string
  projectId: string
  title: string
  rawContent: string
  extractedTaskIds: string[]
  createdAt: number
}

interface KanbanBoard {
  draft: Task[]
  pending: Task[]
  in_progress: Task[]
  completed: Task[]
}

interface ProjectProgress {
  total: number
  completed: number
  percentage: number
}

interface TodoRetryEvent {
  id: string
  entityType: 'task' | 'subTask'
  entityId: string
  retryCount: number
  status: 'pending' | 'processing' | 'failed' | 'completed'
  eventType: 'dingtalk.create_todo' | 'dingtalk.update_todo_status'
  errorMessage?: string
}

interface TaskDependency {
  id: string
  taskId: string
  dependsOnTaskId: string
  type: 'finish_to_start' | 'start_to_start' | 'finish_to_finish' | 'start_to_finish'
}

interface TaskBlocker {
  taskId: string
  dependsOnTaskId: string
  dependsOnTitle: string
  type: TaskDependency['type']
  reason: string
}

interface MyWorkItem {
  entityType: 'task' | 'subTask'
  id: string
  title: string
  status: 'draft' | 'pending' | 'in_progress' | 'paused' | 'completed'
  dueDate?: number
  projectTitle: string
  parentTaskTitle?: string
  isOverdue: boolean
}

interface ProjectAlert {
  id: string
  type: 'overdue' | 'blocked' | 'high_risk'
  severity: 'warning' | 'critical'
  title: string
  description: string
}

interface ProjectActivity {
  id: string
  entityType: 'task' | 'subTask'
  entityId: string
  action: string
  summary: string
  actor?: string
  createdAt: number
}

interface ProjectSummary {
  markdown: string
  completed: number
  total: number
  overdueCount: number
  blockedCount: number
  highRiskCount: number
  todoRetryCount: number
}

// ===== 主进程 API 调用 =====

async function callProjectAPI<T>(method: string, ...args: unknown[]): Promise<T> {
  const api = (window as unknown as { electronAPI?: { paa?: { project?: Record<string, (...args: unknown[]) => Promise<unknown>> } } }).electronAPI?.paa?.project
  if (!api) throw new Error('Project API 未初始化')
  const fn = api[method]
  if (!fn) throw new Error(`Project API 方法不存在: ${method}`)
  return fn(...args) as Promise<T>
}

// ===== UI 组件 =====

export function ProjectView(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<'projects' | 'my-work' | 'board' | 'team'>('projects')
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const userProfile = useAtomValue(userProfileAtom)

  const loadProjects = useCallback(async () => {
    try {
      const data = await callProjectAPI<Project[]>('listProjects')
      setProjects(data)
    } catch (err) {
      console.error('加载项目失败:', err)
    }
  }, [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  // 返回项目列表
  if (!selectedProject) {
    return (
      <div className="flex flex-col h-full bg-background">
        <ProjectHeader
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onRefresh={loadProjects}
        />
        <div className="flex-1 overflow-auto p-6">
          {activeTab === 'projects' && (
            <ProjectList
              projects={projects}
              isLoading={isLoading}
              onSelectProject={setSelectedProject}
              onProjectsChange={setProjects}
            />
          )}
          {activeTab === 'my-work' && <MyWorkPanel assigneeUserId={`paa-${userProfile.userName}`} />}
          {activeTab === 'board' && <BoardOverview projects={projects} />}
          {activeTab === 'team' && <AgentTeamPanel />}
        </div>
      </div>
    )
  }

  // 项目详情
  return (
    <ProjectDetail
      project={selectedProject}
      onBack={() => setSelectedProject(null)}
      onRefresh={loadProjects}
    />
  )
}

// ===== 头部 =====

function ProjectHeader({
  activeTab,
  onTabChange,
  onRefresh,
}: {
  activeTab: string
  onTabChange: (tab: 'projects' | 'my-work' | 'board' | 'team') => void
  onRefresh: () => void
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b">
      <div>
        <h1 className="text-xl font-semibold">项目管理</h1>
        <p className="text-sm text-muted-foreground mt-1">
          AI 驱动的智能项目协同 — 会议纪要自动拆任务，IM Todo 双向同步
        </p>
      </div>
      <div className="flex items-center gap-2">
        {([
          { key: 'projects', label: '项目' },
          { key: 'my-work', label: '我的工作' },
          { key: 'board', label: '看板' },
          { key: 'team', label: '团队' },
        ] as const).map((tab) => (
          <button key={tab.key} onClick={() => onTabChange(tab.key)} className={`rounded px-2 py-1 text-xs titlebar-no-drag ${activeTab === tab.key ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>{tab.label}</button>
        ))}
        <button
          onClick={onRefresh}
          className="px-3 py-1.5 text-sm border rounded-md hover:bg-muted transition-colors titlebar-no-drag"
        >
          刷新
        </button>
        <span className="px-2 py-1 text-xs bg-amber-100 text-amber-700 rounded-full">
          v0.2
        </span>
      </div>
    </div>
  )
}

function MyWorkPanel({ assigneeUserId }: { assigneeUserId: string }): React.ReactElement {
  const [items, setItems] = useState<MyWorkItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [status, setStatus] = useState<'all' | MyWorkItem['status']>('all')

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      setItems(await callProjectAPI<MyWorkItem[]>('listMyWork', assigneeUserId))
    } catch (error) {
      console.error('加载我的工作失败:', error)
    } finally {
      setIsLoading(false)
    }
  }, [assigneeUserId])

  useEffect(() => { void load() }, [load])
  const visible = status === 'all' ? items : items.filter((item) => item.status === status)
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div><h2 className="text-lg font-medium">我的工作</h2><p className="text-sm text-muted-foreground">按负责人聚合 Task 与执行 subTask，逾期项优先显示。</p></div>
        <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="rounded border bg-background px-2 py-1 text-sm">
          <option value="all">全部状态</option><option value="pending">待处理</option><option value="in_progress">进行中</option><option value="paused">已暂停</option><option value="completed">已完成</option>
        </select>
      </div>
      {isLoading ? <p className="text-sm text-muted-foreground">加载中...</p> : visible.length === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">当前没有分配给你的工作项</p> : (
        <div className="space-y-2">{visible.map((item) => (
          <div key={`${item.entityType}-${item.id}`} className={`flex items-center gap-3 rounded-lg border p-3 ${item.isOverdue ? 'border-red-200 bg-red-50/40' : 'bg-card'}`}>
            <span className={`rounded px-1.5 py-0.5 text-xs ${item.entityType === 'task' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>{item.entityType === 'task' ? 'Task' : 'subTask'}</span>
            <div className="min-w-0 flex-1"><div className={`truncate text-sm font-medium ${item.status === 'completed' ? 'line-through text-muted-foreground' : ''}`}>{item.title}</div><div className="text-xs text-muted-foreground">{item.projectTitle}{item.parentTaskTitle ? ` · ${item.parentTaskTitle}` : ''}{item.dueDate ? ` · 截止 ${new Date(item.dueDate).toLocaleDateString()}` : ''}</div></div>
            {item.isOverdue && <span className="text-xs text-red-600">已逾期</span>}
            <span className="text-xs text-muted-foreground">{item.status}</span>
          </div>
        ))}</div>
      )}
    </div>
  )
}

// ===== 项目列表 =====

function ProjectList({
  projects,
  isLoading,
  onSelectProject,
  onProjectsChange,
}: {
  projects: Project[]
  isLoading: boolean
  onSelectProject: (p: Project) => void
  onProjectsChange: (p: Project[]) => void
}): React.ReactElement {
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')

  const handleCreate = async () => {
    if (!newTitle.trim()) return
    try {
      const project = await callProjectAPI<Project>('createProject', {
        title: newTitle,
        description: newDesc,
      })
      onProjectsChange([...projects, project])
      setNewTitle('')
      setNewDesc('')
      setShowCreate(false)
    } catch (err) {
      console.error('创建项目失败:', err)
      alert('创建项目失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此项目？项目内所有任务将被一并删除。')) return
    try {
      await callProjectAPI<boolean>('deleteProject', id)
      onProjectsChange(projects.filter((p) => p.id !== id))
    } catch (err) {
      console.error('删除项目失败:', err)
      alert('删除项目失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">
          项目列表 ({projects.length})
        </h2>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          + 新建项目
        </button>
      </div>

      {showCreate && (
        <div className="p-4 bg-card rounded-lg border space-y-3">
          <h3 className="text-sm font-medium">新建项目</h3>
          <input
            type="text"
            placeholder="项目名称"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            className="w-full px-3 py-2 text-sm border rounded-md bg-background"
          />
          <textarea
            placeholder="项目描述（可选）"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            className="w-full px-3 py-2 text-sm border rounded-md bg-background resize-none h-20"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md"
            >
              创建
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="px-3 py-1.5 text-sm border rounded-md"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">加载中...</div>
      ) : projects.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>暂无项目</p>
          <p className="text-sm mt-2">点击上方「新建项目」开始</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onClick={() => onSelectProject(project)}
              onDelete={() => handleDelete(project.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectCard({
  project,
  onClick,
  onDelete,
}: {
  project: Project
  onClick: () => void
  onDelete: () => void
}): React.ReactElement {
  const [progress, setProgress] = useState<ProjectProgress | null>(null)

  useEffect(() => {
    callProjectAPI<ProjectProgress>('getProjectProgress', project.id)
      .then(setProgress)
      .catch(() => setProgress({ total: 0, completed: 0, percentage: 0 }))
  }, [project.id])

  const statusColors = {
    active: 'bg-green-100 text-green-700',
    planning: 'bg-blue-100 text-blue-700',
    completed: 'bg-gray-100 text-gray-700',
    cancelled: 'bg-red-100 text-red-700',
  }

  const statusLabels = {
    active: '进行中',
    planning: '规划中',
    completed: '已完成',
    cancelled: '已取消',
  }

  return (
    <div
      className="p-4 bg-card rounded-lg border shadow-sm hover:shadow-md transition-shadow relative group cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-start justify-between mb-3">
        <h3 className="font-medium text-sm hover:text-primary">
          {project.title}
        </h3>
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 text-xs rounded-full ${statusColors[project.status]}`}>
            {statusLabels[project.status]}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className="opacity-0 group-hover:opacity-100 text-xs text-red-500 hover:text-red-700 transition-opacity"
          >
            删除
          </button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-4">{project.description}</p>

      {progress && (
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>进度</span>
            <span>{progress.percentage}%</span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${progress.percentage}%` }}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            任务 {progress.completed}/{progress.total}
          </div>
        </div>
      )}
    </div>
  )
}

// ===== 项目详情 =====

function ProjectDetail({
  project,
  onBack,
  onRefresh,
}: {
  project: Project
  onBack: () => void
  onRefresh: () => void
}): React.ReactElement {
  const [detailTab, setDetailTab] = useState<'tasks' | 'notes' | 'board' | 'gantt' | 'dependencies' | 'activity' | 'risk' | 'brief'>('tasks')
  const [isEditingProject, setIsEditingProject] = useState(false)
  const [editTitle, setEditTitle] = useState(project.title)
  const [editDesc, setEditDesc] = useState(project.description)
  const [tasks, setTasks] = useState<Task[]>([])
  const [notes, setNotes] = useState<MeetingNote[]>([])
  const [board, setBoard] = useState<KanbanBoard | null>(null)
  const [pollingStatus, setPollingStatus] = useState<Record<string, boolean>>({})
  const [isPollingLoading, setIsPollingLoading] = useState<Record<string, boolean>>({})
  const [riskReport, setRiskReport] = useState<{
    overallRiskLevel: string
    summary: string
    highRiskTasks: string[]
    suggestions: string[]
    progress: string
  } | null>(null)
  const [isGeneratingReport, setIsGeneratingReport] = useState(false)
  const [todoRetries, setTodoRetries] = useState<TodoRetryEvent[]>([])
  const [retryingEventIds, setRetryingEventIds] = useState<Set<string>>(new Set())
  const [dependencies, setDependencies] = useState<TaskDependency[]>([])
  const [blockers, setBlockers] = useState<TaskBlocker[]>([])
  const [dependencyTasks, setDependencyTasks] = useState<Task[]>([])
  const [projectAlerts, setProjectAlerts] = useState<ProjectAlert[]>([])
  const [activities, setActivities] = useState<ProjectActivity[]>([])
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false)
  const [isSendingSummary, setIsSendingSummary] = useState(false)
  const [isSendingFeishuSummary, setIsSendingFeishuSummary] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const [taskList, noteList, boardData, retryEvents, dependencyTaskList, dependencyList, blockerList, alerts, activityItems] = await Promise.all([
        callProjectAPI<Task[]>('listTasks', project.id),
        callProjectAPI<MeetingNote[]>('listMeetingNotes', project.id),
        callProjectAPI<KanbanBoard>('getKanbanBoard', project.id),
        callProjectAPI<TodoRetryEvent[]>('listDingTalkTodoRetries', project.id),
        callProjectAPI<Task[]>('listTasks', project.id, { includeSubTasks: true, includeDrafts: true }),
        callProjectAPI<TaskDependency[]>('listTaskDependencies', project.id),
        callProjectAPI<TaskBlocker[]>('listTaskBlockers', project.id),
        callProjectAPI<ProjectAlert[]>('listProjectAlerts', project.id),
        callProjectAPI<ProjectActivity[]>('listProjectActivities', project.id),
      ])
      setTasks(taskList)
      setNotes(noteList)
      setBoard(boardData)
      setTodoRetries(retryEvents)
      setDependencyTasks(dependencyTaskList)
      setDependencies(dependencyList)
      setBlockers(blockerList)
      setProjectAlerts(alerts)
      setActivities(activityItems)
    } catch (err) {
      console.error('加载项目详情失败:', err)
    }
  }, [project.id])

  const handleSaveProject = async () => {
    if (!editTitle.trim()) return
    try {
      await callProjectAPI<Project>('updateProject', project.id, {
        title: editTitle,
        description: editDesc,
      })
      setIsEditingProject(false)
      onRefresh()
    } catch (err) {
      console.error('保存项目失败:', err)
      alert('保存失败')
    }
  }

  const handleCreateTemplate = async () => {
    const name = prompt('模板名称', `${project.title} 模板`)
    if (!name?.trim()) return
    try {
      await callProjectAPI('createProjectTemplate', project.id, name.trim(), project.description)
      alert('项目模板已保存，可在项目管理设置中应用。')
    } catch (error) {
      alert('保存模板失败: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  const handleGenerateSummary = async () => {
    setIsGeneratingSummary(true)
    try {
      setSummary(await callProjectAPI<ProjectSummary>('generateProjectSummary', project.id))
    } catch (error) {
      alert('生成项目摘要失败: ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setIsGeneratingSummary(false)
    }
  }

  const handleSendSummaryToDingTalk = async () => {
    if (!confirm('确认将当前项目摘要发送到已配置的钉钉机器人？')) return
    setIsSendingSummary(true)
    try {
      const sent = await callProjectAPI<ProjectSummary>('sendProjectSummaryToDingTalk', project.id)
      setSummary(sent)
      alert('项目摘要已发送到钉钉')
    } catch (error) {
      alert('发送失败: ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setIsSendingSummary(false)
    }
  }

  const handleSendSummaryToFeishu = async () => {
    const chatId = prompt('输入已在飞书设置中绑定的 chatId')
    if (!chatId?.trim()) return
    setIsSendingFeishuSummary(true)
    try {
      const sent = await callProjectAPI<ProjectSummary>('sendProjectSummaryToFeishu', project.id, chatId.trim())
      setSummary(sent)
      alert('项目摘要已发送到飞书')
    } catch (error) {
      alert('发送失败: ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setIsSendingFeishuSummary(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleStartPolling = async (platform: 'feishu' | 'dingtalk') => {
    const key = `${platform}`
    setIsPollingLoading((prev) => ({ ...prev, [key]: true }))
    try {
      await callProjectAPI('startPolling', project.id, platform, 30000)
      setPollingStatus((prev) => ({ ...prev, [key]: true }))
    } catch (err) {
      console.error(`启动 ${platform} 轮询失败:`, err)
      alert(`启动轮询失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsPollingLoading((prev) => ({ ...prev, [key]: false }))
    }
  }

  const handleStopPolling = async (platform: 'feishu' | 'dingtalk') => {
    const key = `${platform}`
    setIsPollingLoading((prev) => ({ ...prev, [key]: true }))
    try {
      await callProjectAPI('stopPolling', project.id, platform)
      setPollingStatus((prev) => ({ ...prev, [key]: false }))
    } catch (err) {
      console.error(`停止 ${platform} 轮询失败:`, err)
    } finally {
      setIsPollingLoading((prev) => ({ ...prev, [key]: false }))
    }
  }

  const handleGenerateRiskReport = async () => {
    setIsGeneratingReport(true)
    try {
      const report = await callProjectAPI<{
        overallRiskLevel: string
        summary: string
        highRiskTasks: string[]
        suggestions: string[]
        progress: string
      }>('generateRiskReport', project.id)
      setRiskReport(report)
      setDetailTab('risk')
    } catch (err) {
      console.error('生成风险报告失败:', err)
      alert('生成风险报告失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsGeneratingReport(false)
    }
  }

  const handleRetryTodo = async (eventId: string) => {
    setRetryingEventIds((previous) => new Set(previous).add(eventId))
    try {
      const success = await callProjectAPI<boolean>('retryDingTalkTodo', eventId)
      if (!success) throw new Error('钉钉待办重试未成功')
      await loadData()
    } catch (err) {
      alert('重试失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setRetryingEventIds((previous) => {
        const next = new Set(previous)
        next.delete(eventId)
        return next
      })
    }
  }

  const hasExternalCompletedTasks = tasks.some(
    (t) =>
      t.status !== 'completed' &&
      (t.externalSync?.feishu?.status === 'completed' || t.externalSync?.dingtalk?.status === 'completed')
  )

  const riskLevelColor = (level: string): string => {
    const map: { low: string; medium: string; high: string; critical: string } = {
      low: 'bg-gray-100 text-gray-700',
      medium: 'bg-yellow-100 text-yellow-700',
      high: 'bg-orange-100 text-orange-700',
      critical: 'bg-red-100 text-red-700',
    }
    const key = level as keyof typeof map
    return map[key] ?? map.medium
  }

  const riskLevelLabel = (level: string): string => {
    const map: { low: string; medium: string; high: string; critical: string } = {
      low: '低风险',
      medium: '中风险',
      high: '高风险',
      critical: '严重风险',
    }
    const key = level as keyof typeof map
    return map[key] ?? '未知'
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 详情头部 */}
      <div className="flex items-center gap-4 px-6 py-4 border-b">
        <button
          onClick={onBack}
          className="text-sm text-muted-foreground hover:text-foreground titlebar-no-drag"
        >
          ← 返回
        </button>
        <div className="flex-1">
          {isEditingProject ? (
            <div className="space-y-2">
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full px-2 py-1 text-sm border rounded-md bg-background"
                placeholder="项目名称"
              />
              <input
                type="text"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                className="w-full px-2 py-1 text-sm border rounded-md bg-background"
                placeholder="项目描述"
              />
            </div>
          ) : (
            <>
              <h1 className="text-lg font-semibold">{project.title}</h1>
              <p className="text-sm text-muted-foreground">{project.description}</p>
            </>
          )}
          <button onClick={() => void handleCreateTemplate()} className="text-xs px-3 py-1.5 rounded border hover:bg-muted transition-colors" title="将当前项目结构保存为模板">存为模板</button>
        </div>
        <div className="flex items-center gap-2">
          {/* 编辑项目按钮 */}
          {isEditingProject ? (
            <>
              <button
                onClick={handleSaveProject}
                className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                保存
              </button>
              <button
                onClick={() => {
                  setIsEditingProject(false)
                  setEditTitle(project.title)
                  setEditDesc(project.description)
                }}
                className="text-xs px-3 py-1.5 rounded border hover:bg-muted transition-colors"
              >
                取消
              </button>
            </>
          ) : (
            <button
              onClick={() => setIsEditingProject(true)}
              className="text-xs px-3 py-1.5 rounded border hover:bg-muted transition-colors"
              title="编辑项目"
            >
              编辑
            </button>
          )}
          {/* 外部状态变化提示 */}
          {hasExternalCompletedTasks && (
            <span className="text-xs px-2 py-1 rounded bg-amber-50 text-amber-700" title="有外部 Todo 已完成，但本地任务未标记完成">
              ⚠️ 外部有更新
            </span>
          )}
          {/* 刷新 */}
          <button
            onClick={() => loadData()}
            className="text-xs px-3 py-1.5 rounded border hover:bg-muted transition-colors"
            title="刷新数据"
          >
            刷新
          </button>
          {/* 风险报告按钮 */}
          <button
            onClick={() => void handleGenerateSummary()}
            disabled={isGeneratingSummary}
            className="text-xs px-3 py-1.5 rounded bg-teal-50 text-teal-700 hover:bg-teal-100 transition-colors disabled:opacity-50"
            title="生成可复制的项目摘要"
          >
            {isGeneratingSummary ? '...' : '项目摘要'}
          </button>
          <button
            onClick={handleGenerateRiskReport}
            disabled={isGeneratingReport}
            className="text-xs px-3 py-1.5 rounded bg-purple-50 text-purple-600 hover:bg-purple-100 transition-colors disabled:opacity-50"
            title="生成项目风险报告"
          >
            {isGeneratingReport ? '...' : '📊 风险报告'}
          </button>
          {/* 轮询控制 */}
          {(['feishu', 'dingtalk'] as const).map((platform) => {
            const key = `${platform}`
            const isRunning = pollingStatus[key]
            const isLoading = isPollingLoading[key]
            return (
              <button
                key={platform}
                onClick={() => (isRunning ? handleStopPolling(platform) : handleStartPolling(platform))}
                disabled={isLoading}
                className={`text-xs px-3 py-1.5 rounded transition-colors disabled:opacity-50 ${
                  isRunning
                    ? 'bg-red-50 text-red-600 hover:bg-red-100'
                    : platform === 'feishu'
                    ? 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                    : 'bg-orange-50 text-orange-600 hover:bg-orange-100'
                }`}
                title={isRunning ? `停止 ${platform === 'feishu' ? '飞书' : '钉钉'} 轮询` : `启动 ${platform === 'feishu' ? '飞书' : '钉钉'} 轮询`}
              >
                {isLoading ? '...' : isRunning ? `停止${platform === 'feishu' ? '飞书' : '钉钉'}` : `${platform === 'feishu' ? '飞书' : '钉钉'}轮询`}
              </button>
            )
          })}
        </div>
      </div>

      {/* 详情标签 */}
      <div className="flex gap-1 px-6 pt-3 border-b">
        {([
          { key: 'tasks', label: '任务' },
          { key: 'notes', label: '会议纪要' },
          { key: 'board', label: '看板' },
          { key: 'gantt', label: '甘特' },
          { key: 'dependencies', label: `依赖${blockers.length > 0 ? ` · ${blockers.length} 阻塞` : ''}` },
          { key: 'activity', label: '活动' },
          { key: 'risk', label: '风险报告' },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setDetailTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              detailTab === tab.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
            {tab.key === 'risk' && riskReport && (
              <span className={`ml-1.5 inline-block w-2 h-2 rounded-full ${
                riskReport.overallRiskLevel === 'low' ? 'bg-green-500' :
                riskReport.overallRiskLevel === 'medium' ? 'bg-yellow-500' :
                riskReport.overallRiskLevel === 'high' ? 'bg-orange-500' : 'bg-red-500'
              }`} />
            )}
          </button>
        ))}
      </div>

      {todoRetries.length > 0 && (
        <div className="mx-6 mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          <div className="mb-2 font-medium">钉钉 Todo 有 {todoRetries.length} 条待重试同步</div>
          <div className="space-y-1">
            {todoRetries.map((event) => (
              <div key={event.id} className="flex items-center gap-2 text-xs">
                <span className="flex-1">{event.entityType === 'task' ? 'Task' : 'subTask'} #{event.entityId} · {event.eventType === 'dingtalk.create_todo' ? '创建 Todo' : '更新 Todo 状态'} · 已尝试 {event.retryCount} 次{event.errorMessage ? ` · ${event.errorMessage}` : ''}</span>
                <button
                  onClick={() => void handleRetryTodo(event.id)}
                  disabled={retryingEventIds.has(event.id)}
                  className="rounded bg-amber-600 px-2 py-1 text-white disabled:opacity-50"
                >{retryingEventIds.has(event.id) ? '重试中...' : '重试'}</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {projectAlerts.length > 0 && (
        <div className="mx-6 mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          <div className="mb-2 font-medium">项目告警（{projectAlerts.length}）</div>
          <div className="space-y-1">
            {projectAlerts.slice(0, 5).map((alert) => <div key={alert.id} className="text-xs"><span className={alert.severity === 'critical' ? 'font-semibold text-red-700' : 'font-medium'}>{alert.title}</span> · {alert.description}</div>)}
            {projectAlerts.length > 5 && <div className="text-xs text-muted-foreground">另有 {projectAlerts.length - 5} 条告警，请前往依赖与风险报告查看。</div>}
          </div>
        </div>
      )}

      {summary && (
        <div className="mx-6 mt-3 rounded-lg border bg-card p-3 text-sm">
          <div className="mb-2 flex items-center justify-between"><span className="font-medium">项目摘要</span><div className="flex gap-2"><button onClick={() => void navigator.clipboard?.writeText(summary.markdown)} className="rounded border px-2 py-1 text-xs">复制 Markdown</button><button onClick={() => void handleSendSummaryToFeishu()} disabled={isSendingFeishuSummary} className="rounded bg-blue-600 px-2 py-1 text-xs text-white disabled:opacity-50">{isSendingFeishuSummary ? '发送中...' : '发飞书'}</button><button onClick={() => void handleSendSummaryToDingTalk()} disabled={isSendingSummary} className="rounded bg-orange-600 px-2 py-1 text-xs text-white disabled:opacity-50">{isSendingSummary ? '发送中...' : '发钉钉'}</button></div></div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{summary.markdown}</pre>
        </div>
      )}

      {/* 详情内容 */}
      <div className="flex-1 overflow-auto p-6">
        {detailTab === 'tasks' && (
          <TaskList
            projectId={project.id}
            tasks={tasks}
            onTasksChange={setTasks}
          />
        )}
        {detailTab === 'notes' && (
          <MeetingNotesPanel
            projectId={project.id}
            notes={notes}
            onNotesChange={setNotes}
            onTasksChange={setTasks}
          />
        )}
        {detailTab === 'board' && board && (
          <KanbanView board={board} />
        )}
        {detailTab === 'gantt' && (
          <GanttView tasks={dependencyTasks} dependencies={dependencies} blockers={blockers} />
        )}
        {detailTab === 'dependencies' && (
          <DependencyPanel
            tasks={dependencyTasks}
            dependencies={dependencies}
            blockers={blockers}
            onChanged={() => void loadData()}
          />
        )}
        {detailTab === 'activity' && (
          <ActivityPanel activities={activities} />
        )}
        {detailTab === 'brief' && (
          <BriefPanel projectId={project.id} tasks={tasks} />
        )}
        {detailTab === 'risk' && (
          <div className="space-y-6">
            {riskReport ? (
              <>
                {/* 风险等级卡片 */}
                <div className={`p-6 rounded-lg border ${riskLevelColor(riskReport.overallRiskLevel)}`}>
                  <div className="flex items-center gap-3">
                    <div className="text-2xl font-bold">
                      {riskLevelLabel(riskReport.overallRiskLevel)}
                    </div>
                    <div className="text-sm opacity-80">
                      {riskReport.progress}
                    </div>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed">{riskReport.summary}</p>
                </div>

                {/* 高风险任务 */}
                {riskReport.highRiskTasks.length > 0 && (
                  <div className="p-4 rounded-lg border bg-card">
                    <h3 className="text-sm font-semibold mb-3">⚠️ 高风险任务</h3>
                    <div className="space-y-2">
                      {riskReport.highRiskTasks.map((task, i) => (
                        <div key={i} className="flex items-start gap-2 text-sm">
                          <span className="text-red-500 mt-0.5">•</span>
                          <span>{task}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 建议措施 */}
                {riskReport.suggestions.length > 0 && (
                  <div className="p-4 rounded-lg border bg-card">
                    <h3 className="text-sm font-semibold mb-3">💡 建议措施</h3>
                    <div className="space-y-2">
                      {riskReport.suggestions.map((suggestion, i) => (
                        <div key={i} className="flex items-start gap-2 text-sm">
                          <span className="text-blue-500 mt-0.5">{i + 1}.</span>
                          <span className="text-muted-foreground">{suggestion}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                <p>暂无风险报告</p>
                <p className="text-sm mt-2">点击上方「📊 风险报告」按钮生成</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}


function ActivityPanel({ activities }: { activities: ProjectActivity[] }): React.ReactElement {
  if (activities.length === 0) return <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">暂无活动记录。后续的任务创建、状态、负责人、日期和 Todo 同步变化会出现在这里。</div>
  return <div className="space-y-3">{activities.map((activity) => (
    <div key={activity.id} className="flex gap-3 rounded-lg border bg-card p-3">
      <span className={`mt-0.5 rounded px-1.5 py-0.5 text-xs ${activity.entityType === 'task' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>{activity.entityType === 'task' ? 'Task' : 'subTask'}</span>
      <div className="min-w-0 flex-1"><p className="text-sm">{activity.summary}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(activity.createdAt).toLocaleString('zh-CN')}{activity.actor ? ` · ${activity.actor}` : ''}</p></div>
    </div>
  ))}</div>
}

function GanttView({ tasks, dependencies, blockers }: { tasks: Task[]; dependencies: TaskDependency[]; blockers: TaskBlocker[] }): React.ReactElement {
  const datedTasks = tasks.filter((task) => task.startDate || task.dueDate)
  if (datedTasks.length === 0) {
    return <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">为 Task 设置开始日期或截止日期后，将在这里显示甘特计划。</div>
  }
  const day = 86_400_000
  const starts = datedTasks.map((task) => task.startDate ?? task.createdAt)
  const ends = datedTasks.map((task) => task.dueDate ?? task.startDate ?? task.createdAt + day)
  const rangeStart = Math.min(...starts)
  const rangeEnd = Math.max(...ends, rangeStart + day)
  const range = Math.max(rangeEnd - rangeStart, day)
  const blockerIds = new Set(blockers.map((blocker) => blocker.taskId))
  return (
    <div className="space-y-3 overflow-x-auto">
      <div className="flex items-center justify-between"><div><h3 className="text-sm font-semibold">Task 甘特图</h3><p className="text-xs text-muted-foreground">WBS 任务按层级显示；执行 subTask 在任务详情中展开。</p></div><span className="text-xs text-muted-foreground">{dependencies.length} 条依赖 · {blockers.length} 项阻塞</span></div>
      <div className="min-w-[760px] rounded-lg border bg-card p-3">
        <div className="mb-2 ml-[220px] flex justify-between text-xs text-muted-foreground"><span>{new Date(rangeStart).toLocaleDateString()}</span><span>{new Date(rangeEnd).toLocaleDateString()}</span></div>
        <div className="space-y-2">{tasks.map((task) => {
          const start = task.startDate ?? task.createdAt
          const end = Math.max(task.dueDate ?? start + day, start + day)
          const left = Math.max(0, ((start - rangeStart) / range) * 100)
          const width = Math.max(1.5, ((end - start) / range) * 100)
          return <div key={task.id} className="flex items-center gap-3"><div className={`w-[205px] truncate text-xs ${task.parentId ? 'pl-4' : ''}`} title={task.title}>{blockerIds.has(task.id) && <span className="mr-1 text-amber-600">●</span>}{task.title}</div><div className="relative h-6 flex-1 rounded bg-muted/50"><div className={`absolute top-1 h-4 rounded ${task.status === 'completed' ? 'bg-emerald-500' : blockerIds.has(task.id) ? 'bg-amber-500' : 'bg-primary'}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${task.startDate ? new Date(task.startDate).toLocaleDateString() : '创建日'} → ${task.dueDate ? new Date(task.dueDate).toLocaleDateString() : '未设截止日期'}`} /></div></div>
        })}</div>
      </div>
    </div>
  )
}

function DependencyPanel({
  tasks,
  dependencies,
  blockers,
  onChanged,
}: {
  tasks: Task[]
  dependencies: TaskDependency[]
  blockers: TaskBlocker[]
  onChanged: () => void
}): React.ReactElement {
  const [taskId, setTaskId] = useState('')
  const [dependsOnTaskId, setDependsOnTaskId] = useState('')
  const [type, setType] = useState<TaskDependency['type']>('finish_to_start')
  const [isSaving, setIsSaving] = useState(false)
  const titles = new Map(tasks.map((task) => [task.id, task.title]))

  const createDependency = async () => {
    if (!taskId || !dependsOnTaskId || taskId === dependsOnTaskId) return
    setIsSaving(true)
    try {
      await callProjectAPI('createTaskDependency', taskId, dependsOnTaskId, type)
      setDependsOnTaskId('')
      onChanged()
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSaving(false)
    }
  }

  const removeDependency = async (id: string) => {
    try {
      await callProjectAPI('deleteTaskDependency', id)
      onChanged()
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="space-y-5">
      {blockers.length > 0 && (
        <section className="rounded-lg bg-amber-50 p-4 text-amber-950">
          <h3 className="mb-2 text-sm font-semibold">当前阻塞（{blockers.length}）</h3>
          <div className="space-y-1 text-sm">
            {blockers.map((blocker) => (
              <div key={`${blocker.taskId}-${blocker.dependsOnTaskId}`}>“{titles.get(blocker.taskId) ?? blocker.taskId}”：{blocker.reason}</div>
            ))}
          </div>
        </section>
      )}
      <section className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">添加前置依赖</h3>
        <div className="grid gap-2 md:grid-cols-4">
          <select value={taskId} onChange={(event) => setTaskId(event.target.value)} className="rounded border bg-background px-2 py-1.5 text-sm">
            <option value="">选择当前任务</option>
            {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select>
          <select value={dependsOnTaskId} onChange={(event) => setDependsOnTaskId(event.target.value)} className="rounded border bg-background px-2 py-1.5 text-sm">
            <option value="">选择前置任务</option>
            {tasks.filter((task) => task.id !== taskId).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select>
          <select value={type} onChange={(event) => setType(event.target.value as TaskDependency['type'])} className="rounded border bg-background px-2 py-1.5 text-sm">
            <option value="finish_to_start">完成后开始</option>
            <option value="start_to_start">开始后开始</option>
            <option value="finish_to_finish">完成后完成</option>
            <option value="start_to_finish">开始后完成</option>
          </select>
          <button onClick={() => void createDependency()} disabled={isSaving || !taskId || !dependsOnTaskId || taskId === dependsOnTaskId} className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">{isSaving ? '保存中...' : '添加依赖'}</button>
        </div>
      </section>
      <section className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">依赖关系</h3>
        {dependencies.length === 0 ? <p className="text-sm text-muted-foreground">暂无依赖关系</p> : (
          <div className="space-y-2">
            {dependencies.map((dependency) => (
              <div key={dependency.id} className="flex items-center gap-2 rounded bg-muted/50 px-3 py-2 text-sm">
                <span className="flex-1">{titles.get(dependency.taskId) ?? dependency.taskId} ← {titles.get(dependency.dependsOnTaskId) ?? dependency.dependsOnTaskId}</span>
                <span className="text-xs text-muted-foreground">{dependency.type}</span>
                <button onClick={() => void removeDependency(dependency.id)} className="text-xs text-red-600 hover:text-red-800">移除</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ===== 任务列表 =====

function TaskList({
  projectId,
  tasks,
  onTasksChange,
}: {
  projectId: string
  tasks: Task[]
  onTasksChange: (tasks: Task[]) => void
}): React.ReactElement {
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newPriority, setNewPriority] = useState<Task['priority']>('medium')
  const [newAssigneeName, setNewAssigneeName] = useState('')
  const [newAgentId, setNewAgentId] = useState('')
  const [newPermissions, setNewPermissions] = useState<string[]>([])
  const [agentEmployees, setAgentEmployees] = useState<AgentEmployeeResult[]>([])
  const [newDueDate, setNewDueDate] = useState('')
  const [syncingTaskIds, setSyncingTaskIds] = useState<Set<string>>(new Set())

  React.useEffect(() => {
    window.electronAPI.paa.agentEmployees.list()
      .then((emps) => setAgentEmployees(emps.filter((e) => e.enabled)))
      .catch(() => setAgentEmployees([]))
  }, [])

  const handleCreate = async () => {
    if (!newTitle.trim()) return
    try {
      const input: {
        title: string
        description: string
        priority?: Task['priority']
        assignee?: { userId: string; displayName: string }
        dueDate?: number
        permissionRequests?: string[]
      } = {
        title: newTitle.trim(),
        description: newDesc.trim(),
        priority: newPriority,
      }
      if (newAgentId) {
        const emp = agentEmployees.find((e) => e.id === newAgentId)
        input.assignee = { userId: `agent-${newAgentId}`, displayName: emp ? `🤖 ${emp.name}` : 'AI 员工' }
      } else if (newAssigneeName.trim()) {
        input.assignee = {
          userId: `paa-${newAssigneeName.trim()}`,
          displayName: newAssigneeName.trim(),
        }
      }
      if (newDueDate) {
        input.dueDate = new Date(`${newDueDate}T00:00:00`).getTime()
      }
      if (newPermissions.length > 0) {
        input.permissionRequests = newPermissions
      }
      const task = await callProjectAPI<Task>('createTask', projectId, input)
      onTasksChange([...tasks, task])
      setNewTitle('')
      setNewDesc('')
      setNewPriority('medium')
      setNewAssigneeName('')
      setNewAgentId('')
      setNewPermissions([])
      setNewDueDate('')
      setShowCreate(false)
    } catch (err) {
      console.error('创建任务失败:', err)
    }
  }

  const handleStatusChange = async (taskId: string, status: Task['status']) => {
    try {
      await callProjectAPI<Task>('updateTask', taskId, { status })
      onTasksChange(tasks.map((t) => (t.id === taskId ? { ...t, status } : t)))
    } catch (err) {
      console.error('更新任务状态失败:', err)
    }
  }

  const handleDelete = async (taskId: string) => {
    if (!confirm('确定删除此任务？')) return
    try {
      await callProjectAPI<boolean>('deleteTask', taskId)
      onTasksChange(tasks.filter((t) => t.id !== taskId))
    } catch (err) {
      console.error('删除任务失败:', err)
    }
  }

  const handleSync = async (taskId: string, platform: 'feishu' | 'dingtalk') => {
    setSyncingTaskIds((prev) => new Set(prev).add(taskId))
    try {
      const result = await callProjectAPI<{ success: boolean; error?: string }>('syncTask', taskId, platform)
      if (result.success) {
        alert(`${platform === 'feishu' ? '飞书' : '钉钉'} Todo 同步成功`)
        // 刷新任务数据以获取 externalSync 更新
        const updatedTask = await callProjectAPI<Task>('getTask', taskId)
        if (updatedTask) {
          onTasksChange(tasks.map((t) => (t.id === taskId ? updatedTask : t)))
        }
      } else {
        alert(`同步失败: ${result.error || '未知错误'}`)
      }
    } catch (err) {
      console.error('同步失败:', err)
      alert('同步失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSyncingTaskIds((prev) => {
        const next = new Set(prev)
        next.delete(taskId)
        return next
      })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">任务列表 ({tasks.length})</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          + 新建任务
        </button>
      </div>

      {showCreate && (
        <div className="p-4 bg-card rounded-lg border space-y-3">
          <h3 className="text-sm font-medium">新建任务</h3>
          <input
            type="text"
            placeholder="任务标题"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            className="w-full px-3 py-2 text-sm border rounded-md bg-background"
          />
          <textarea
            placeholder="任务描述"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            className="w-full px-3 py-2 text-sm border rounded-md bg-background resize-none h-20"
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">优先级</label>
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value as Task['priority'])}
                className="w-full px-3 py-2 text-sm border rounded-md bg-background"
              >
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
                <option value="critical">严重</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">负责人</label>
              <ContactPicker value={newAssigneeName} onChange={setNewAssigneeName} placeholder="搜索通讯录负责人（飞书/钉钉）" />
            </div>
            {agentEmployees.length > 0 && (
              <div>
                <label className="text-xs text-muted-foreground">AI 员工（可选，优先于真人负责人）</label>
                <select
                  value={newAgentId}
                  onChange={(e) => { setNewAgentId(e.target.value); if (e.target.value) setNewAssigneeName('') }}
                  className="w-full px-3 py-2 text-sm border rounded-md bg-background"
                >
                  <option value="">不指派 AI 员工</option>
                  {agentEmployees.map((emp) => (
                    <option key={emp.id} value={emp.id}>🤖 {emp.name} · {emp.role}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="text-xs text-muted-foreground">截止日期</label>
              <input
                type="date"
                value={newDueDate}
                onChange={(e) => setNewDueDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md bg-background"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">权限申请（AI 员工执行时生效；默认只读安全模式）</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {PERMISSION_OPTIONS.map((perm) => (
                <label key={perm.value} className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border cursor-pointer hover:bg-muted/40">
                  <input
                    type="checkbox"
                    checked={newPermissions.includes(perm.value)}
                    onChange={(e) => setNewPermissions((prev) => e.target.checked ? [...prev, perm.value] : prev.filter((p) => p !== perm.value))}
                  />
                  {perm.label}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md">创建</button>
            <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-sm border rounded-md">取消</button>
          </div>
        </div>
      )}

      {tasks.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>暂无任务</p>
          <p className="text-sm mt-2">点击上方「新建任务」或导入会议纪要自动提取</p>
        </div>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              isSyncing={syncingTaskIds.has(task.id)}
              onStatusChange={handleStatusChange}
              onDelete={handleDelete}
              onSync={handleSync}
              onTaskUpdate={(updatedTask) => onTasksChange(tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t)))}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TaskItem({
  task,
  isSyncing,
  onStatusChange,
  onDelete,
  onSync,
  onTaskUpdate,
}: {
  task: Task
  isSyncing: boolean
  onStatusChange: (taskId: string, status: Task['status']) => void
  onDelete: (taskId: string) => void
  onSync: (taskId: string, platform: 'feishu' | 'dingtalk') => void
  onTaskUpdate: (task: Task) => void
}): React.ReactElement {
  const [showRiskModal, setShowRiskModal] = useState(false)
  const [showCompletionModal, setShowCompletionModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [riskResult, setRiskResult] = useState<{
    riskLevel: string
    requiresCompletionNotes: boolean
    summary: string
  } | null>(null)
  const [isAssessing, setIsAssessing] = useState(false)
  const [completionNotes, setCompletionNotes] = useState('')
  const [isSavingNotes, setIsSavingNotes] = useState(false)
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const [editForm, setEditForm] = useState({
    title: task.title,
    description: task.description,
    priority: task.priority,
    assigneeName: task.assignee?.displayName ?? '',
    agentAssigneeId: task.assignee?.userId?.startsWith('agent-') ? task.assignee.userId.slice('agent-'.length) : '',
    permissions: task.permissionRequests ?? [],
    startDate: task.startDate ? new Date(task.startDate).toISOString().split('T')[0] : '',
    dueDate: task.dueDate ? new Date(task.dueDate).toISOString().split('T')[0] : '',
  })
  const [subTasksExpanded, setSubTasksExpanded] = useState(false)
  const [subTasks, setSubTasks] = useState<Task[]>([])
  const [subTasksLoading, setSubTasksLoading] = useState(false)
  const [newSubTaskTitle, setNewSubTaskTitle] = useState('')
  const [executionSubTasksExpanded, setExecutionSubTasksExpanded] = useState(false)
  const [executionSubTasks, setExecutionSubTasks] = useState<ExecutionSubTask[]>([])
  const [executionSubTasksLoading, setExecutionSubTasksLoading] = useState(false)
  const [newExecutionSubTaskTitle, setNewExecutionSubTaskTitle] = useState('')
  const [editingExecutionSubTask, setEditingExecutionSubTask] = useState<ExecutionSubTask | null>(null)
  const [executionSubTaskEdit, setExecutionSubTaskEdit] = useState({ title: '', assigneeName: '', startDate: '', dueDate: '', completionNotes: '' })
  const [isSavingExecutionSubTask, setIsSavingExecutionSubTask] = useState(false)

  // AI 员工任务：查询最新执行状态（P0）
  const isAgentTask = task.assignee?.userId?.startsWith('agent-') ?? false
  const [agentExecStatus, setAgentExecStatus] = useState<AgentExecutionResult['status'] | null>(null)
  const [agentEmployees, setAgentEmployees] = useState<AgentEmployeeResult[]>([])
  useEffect(() => {
    window.electronAPI.paa.agentEmployees.list()
      .then((emps) => setAgentEmployees(emps.filter((e) => e.enabled)))
      .catch(() => setAgentEmployees([]))
  }, [])
  useEffect(() => {
    if (!isAgentTask) return
    let cancelled = false
    window.electronAPI.paa.agentEmployees.listExecutionsByEntity('task', task.id)
      .then((execs) => { if (!cancelled && execs.length > 0) setAgentExecStatus(execs[0]?.status ?? null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [isAgentTask, task.id])

  // 展开时异步加载子任务
  useEffect(() => {
    if (!subTasksExpanded) return
    let cancelled = false
    setSubTasksLoading(true)
    callProjectAPI<Task[]>('listSubTasks', task.id)
      .then((items) => {
        if (!cancelled) setSubTasks(items)
      })
      .catch((err) => console.error('加载子任务失败:', err))
      .finally(() => setSubTasksLoading(false))
    return () => { cancelled = true }
  }, [subTasksExpanded, task.id])

  useEffect(() => {
    if (!executionSubTasksExpanded) return
    let cancelled = false
    setExecutionSubTasksLoading(true)
    callProjectAPI<ExecutionSubTask[]>('listExecutionSubTasks', task.id)
      .then((items) => {
        if (!cancelled) setExecutionSubTasks(items)
      })
      .catch((err) => console.error('加载执行 subTask 失败:', err))
      .finally(() => setExecutionSubTasksLoading(false))
    return () => { cancelled = true }
  }, [executionSubTasksExpanded, task.id])

  const hasFeishu = task.externalSync?.feishu
  const hasDingtalk = task.externalSync?.dingtalk
  const hasRisk = task.riskLevel
  const needsCompletionNotes = task.riskLevel === 'high' || task.riskLevel === 'critical'

  const handleAssessRisk = async () => {
    setIsAssessing(true)
    try {
      const result = await callProjectAPI<{
        riskLevel: string
        requiresCompletionNotes: boolean
        summary: string
      }>('assessTaskRisk', task.id)
      setRiskResult(result)
      setShowRiskModal(true)
      // 更新任务数据
      const updatedTask = await callProjectAPI<Task>('getTask', task.id)
      if (updatedTask) {
        onTaskUpdate(updatedTask)
      }
    } catch (err) {
      console.error('风险评估失败:', err)
      alert('风险评估失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsAssessing(false)
    }
  }

  const handleSaveCompletionNotes = async () => {
    if (!completionNotes.trim()) return
    setIsSavingNotes(true)
    try {
      await callProjectAPI('saveCompletionNotes', task.id, completionNotes)
      setShowCompletionModal(false)
      setCompletionNotes('')
      // 刷新任务
      const updatedTask = await callProjectAPI<Task>('getTask', task.id)
      if (updatedTask) {
        onTaskUpdate(updatedTask)
      }
    } catch (err) {
      console.error('保存完成纪要失败:', err)
      alert('保存失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsSavingNotes(false)
    }
  }

  const handleSaveEdit = async () => {
    if (!editForm.title.trim()) return
    setIsSavingEdit(true)
    try {
      const updates: Partial<Task> = {
        title: editForm.title,
        description: editForm.description,
        priority: editForm.priority,
        permissionRequests: editForm.permissions,
      }
      // assignee：AI 员工优先；否则真人（或清空）
      if (editForm.agentAssigneeId) {
        const emp = agentEmployees.find((e) => e.id === editForm.agentAssigneeId)
        updates.assignee = { userId: `agent-${editForm.agentAssigneeId}`, displayName: emp ? `🤖 ${emp.name}` : 'AI 员工' }
      } else if (editForm.assigneeName.trim()) {
        updates.assignee = {
          userId: `paa-${editForm.assigneeName.trim()}`,
          displayName: editForm.assigneeName.trim(),
        }
      } else {
        updates.assignee = undefined
      }
      if (editForm.dueDate) {
        updates.dueDate = new Date(editForm.dueDate + 'T00:00:00').getTime()
      } else {
        updates.dueDate = undefined
      }
      if (editForm.startDate) {
        updates.startDate = new Date(editForm.startDate + 'T00:00:00').getTime()
      }
      await callProjectAPI<Task>('updateTask', task.id, updates)
      setShowEditModal(false)
      const updatedTask = await callProjectAPI<Task>('getTask', task.id)
      if (updatedTask) {
        onTaskUpdate(updatedTask)
      }
    } catch (err) {
      console.error('保存任务失败:', err)
      alert('保存失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsSavingEdit(false)
    }
  }

  const completedSubCount = subTasks.filter((s) => s.status === 'completed').length
  const totalSubCount = subTasks.length

  const handleAddSubTask = async () => {
    const title = newSubTaskTitle.trim()
    if (!title) return
    try {
      await callProjectAPI<Task>('createSubTask', task.id, { title, description: '' })
      setNewSubTaskTitle('')
      const items = await callProjectAPI<Task[]>('listSubTasks', task.id)
      setSubTasks(items)
    } catch (err) {
      console.error('添加子任务失败:', err)
      alert('添加子任务失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const handleToggleSubTask = async (subId: string) => {
    try {
      const sub = subTasks.find((s) => s.id === subId)
      if (!sub) return
      const nextStatus = sub.status === 'completed' ? 'pending' : 'completed'
      await callProjectAPI<Task>('updateTask', subId, { status: nextStatus })
      const items = await callProjectAPI<Task[]>('listSubTasks', task.id)
      setSubTasks(items)
    } catch (err) {
      console.error('更新子任务失败:', err)
    }
  }

  const handleDeleteSubTask = async (subId: string) => {
    try {
      await callProjectAPI<boolean>('deleteTask', subId)
      const items = await callProjectAPI<Task[]>('listSubTasks', task.id)
      setSubTasks(items)
    } catch (err) {
      console.error('删除子任务失败:', err)
    }
  }

  const refreshExecutionSubTasks = async () => {
    setExecutionSubTasks(await callProjectAPI<ExecutionSubTask[]>('listExecutionSubTasks', task.id))
  }

  const handleAddExecutionSubTask = async () => {
    const title = newExecutionSubTaskTitle.trim()
    if (!title) return
    try {
      await callProjectAPI<ExecutionSubTask>('createExecutionSubTask', task.id, { title })
      setNewExecutionSubTaskTitle('')
      await refreshExecutionSubTasks()
    } catch (err) {
      console.error('添加执行 subTask 失败:', err)
      alert('添加执行 subTask 失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const handleExecutionSubTaskStatus = async (subTaskId: string, status: ExecutionSubTask['status']) => {
    try {
      await callProjectAPI<ExecutionSubTask>('updateExecutionSubTask', subTaskId, { status })
      await refreshExecutionSubTasks()
    } catch (err) {
      console.error('更新执行 subTask 失败:', err)
    }
  }

  const handleDeleteExecutionSubTask = async (subTaskId: string) => {
    try {
      await callProjectAPI<boolean>('deleteExecutionSubTask', subTaskId)
      await refreshExecutionSubTasks()
    } catch (err) {
      console.error('删除执行 subTask 失败:', err)
    }
  }

  const openExecutionSubTaskEdit = (subTask: ExecutionSubTask) => {
    setEditingExecutionSubTask(subTask)
    setExecutionSubTaskEdit({
      title: subTask.title,
      assigneeName: subTask.assignee?.displayName ?? '',
      startDate: subTask.startDate ? new Date(subTask.startDate).toISOString().slice(0, 10) : '',
      dueDate: subTask.dueDate ? new Date(subTask.dueDate).toISOString().slice(0, 10) : '',
      completionNotes: subTask.completionNotes ?? '',
    })
  }

  const saveExecutionSubTaskEdit = async () => {
    if (!editingExecutionSubTask || !executionSubTaskEdit.title.trim()) return
    setIsSavingExecutionSubTask(true)
    try {
      const updates: Partial<ExecutionSubTask> = {
        title: executionSubTaskEdit.title.trim(),
        completionNotes: executionSubTaskEdit.completionNotes.trim() || undefined,
        startDate: executionSubTaskEdit.startDate ? new Date(`${executionSubTaskEdit.startDate}T00:00:00`).getTime() : undefined,
        dueDate: executionSubTaskEdit.dueDate ? new Date(`${executionSubTaskEdit.dueDate}T00:00:00`).getTime() : undefined,
      }
      if (executionSubTaskEdit.assigneeName.trim()) {
        updates.assignee = {
          userId: `paa-${executionSubTaskEdit.assigneeName.trim()}`,
          displayName: executionSubTaskEdit.assigneeName.trim(),
        }
      }
      await callProjectAPI<ExecutionSubTask>('updateExecutionSubTask', editingExecutionSubTask.id, updates)
      setEditingExecutionSubTask(null)
      await refreshExecutionSubTasks()
    } catch (err) {
      console.error('保存执行 subTask 失败:', err)
      alert('保存执行 subTask 失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsSavingExecutionSubTask(false)
    }
  }

  return (
    <>
      <div
        className={`p-3 rounded-lg border flex items-center justify-between ${
          task.status === 'completed' ? 'bg-muted/50' : 'bg-card'
        }`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded-full ${priorityColor(task.priority)}`}>
              {priorityLabel(task.priority)}
            </span>
            <span className={`font-medium text-sm truncate ${task.status === 'completed' ? 'line-through text-muted-foreground' : ''}`}>
              {task.title}
            </span>
            {/* AI 员工执行状态（P0） */}
            {isAgentTask && agentExecStatus && (
              <AgentExecutionBadge status={agentExecStatus} />
            )}
            {/* 风险等级指示器 */}
            {hasRisk && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${riskLevelBadge(task.riskLevel!)}`}
                title={riskResult?.summary || ''}
              >
                风险: {riskLabel(task.riskLevel!)}
              </span>
            )}
            {/* 同步状态指示器 */}
            {hasFeishu && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600" title={`飞书: ${task.externalSync?.feishu?.status ?? 'unknown'}`}>
                飞书
              </span>
            )}
            {hasDingtalk && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-orange-50 text-orange-600" title={`钉钉: ${task.externalSync?.dingtalk?.status ?? 'unknown'}`}>
                钉钉
              </span>
            )}
            {/* 完成纪要标记 */}
            {task.completionNotes && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-600" title="已完成纪要">
                已纪要
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{task.description}</p>
          {task.assignee && (
            <p className="text-xs text-muted-foreground">负责人: {task.assignee.displayName}</p>
          )}
          {needsCompletionNotes && !task.completionNotes && task.status === 'completed' && (
            <p className="text-xs text-amber-600 mt-1">⚠️ 高风险任务，请填写完成纪要</p>
          )}
        </div>
        <div className="flex items-center gap-2 ml-2 shrink-0">
          {/* 编辑任务按钮 */}
          <button
            onClick={() => setShowEditModal(true)}
            className="text-xs px-2 py-1 rounded border hover:bg-muted transition-colors"
            title="编辑任务"
          >
            编辑
          </button>
          {/* 风险评估按钮 */}
          <button
            onClick={handleAssessRisk}
            disabled={isAssessing}
            className="text-xs px-2 py-1 rounded bg-purple-50 text-purple-600 hover:bg-purple-100 transition-colors disabled:opacity-50"
            title="评估任务风险"
          >
            {isAssessing ? '评估中...' : '评估风险'}
          </button>
          {/* 完成纪要按钮（高风险任务） */}
          {needsCompletionNotes && !task.completionNotes && (
            <button
              onClick={() => setShowCompletionModal(true)}
              className="text-xs px-2 py-1 rounded bg-green-50 text-green-600 hover:bg-green-100 transition-colors"
              title="填写完成纪要"
            >
              写纪要
            </button>
          )}
          {/* 同步按钮 */}
          {task.assignee && !isSyncing && (
            <>
              <button
                onClick={() => onSync(task.id, 'feishu')}
                className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
                title="同步到飞书 Todo"
              >
                飞书
              </button>
              <button
                onClick={() => onSync(task.id, 'dingtalk')}
                className="text-xs px-2 py-1 rounded bg-orange-50 text-orange-600 hover:bg-orange-100 transition-colors"
                title="同步到钉钉 Todo"
              >
                钉钉
              </button>
            </>
          )}
          {isSyncing && (
            <span className="text-xs text-muted-foreground">同步中...</span>
          )}
          {/* 子任务入口按钮 */}
          <button
            onClick={() => setSubTasksExpanded((v) => !v)}
            className="text-xs px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            title="拆解子任务"
          >
            {subTasksExpanded ? '▼' : '▶'} 子任务{totalSubCount > 0 ? ` (${completedSubCount}/${totalSubCount})` : ''}
          </button>
          <button
            onClick={() => setExecutionSubTasksExpanded((v) => !v)}
            className="text-xs px-2 py-1 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors"
            title="管理可执行 subTask"
          >
            {executionSubTasksExpanded ? '▼' : '▶'} 执行项{executionSubTasks.length > 0 ? ` (${executionSubTasks.filter((item) => item.status === 'completed').length}/${executionSubTasks.length})` : ''}
          </button>
          <select
            value={task.status}
            onChange={(e) => onStatusChange(task.id, e.target.value as Task['status'])}
            className="text-xs px-2 py-1 border rounded-md bg-background"
          >
            <option value="pending">待处理</option>
            <option value="in_progress">进行中</option>
            <option value="paused">已暂停</option>
            <option value="completed">已完成</option>
          </select>
          <button
            onClick={() => onDelete(task.id)}
            className="text-xs text-red-500 hover:text-red-700"
          >
            删除
          </button>
        </div>
      </div>

      {/* 独立执行 subTask：不会写入 Task.parentId。 */}
      {executionSubTasksExpanded && (
        <div className="mt-2 ml-4 pl-4 border-l-2 border-emerald-200 space-y-2">
          <p className="text-xs font-medium text-emerald-700">执行 subTask（独立 Todo 与完成回调）</p>
          {executionSubTasksLoading && <div className="text-xs text-muted-foreground">加载中...</div>}
          {!executionSubTasksLoading && executionSubTasks.map((subTask) => (
            <div key={subTask.id} className="flex items-center gap-2 rounded bg-emerald-50/50 px-2 py-1">
              <span className={`flex-1 text-xs ${subTask.status === 'completed' ? 'line-through text-muted-foreground' : ''}`}>
                {subTask.title}
                {subTask.externalSync?.dingtalk && <span className="ml-2 text-orange-600">钉钉 {subTask.externalSync.dingtalk.status}</span>}
              </span>
              <select
                value={subTask.status}
                onChange={(event) => handleExecutionSubTaskStatus(subTask.id, event.target.value as ExecutionSubTask['status'])}
                className="text-xs px-1 py-0.5 border rounded bg-background"
              >
                <option value="pending">待处理</option>
                <option value="in_progress">进行中</option>
                <option value="paused">已暂停</option>
                <option value="completed">已完成</option>
              </select>
              <button onClick={() => openExecutionSubTaskEdit(subTask)} className="text-xs text-emerald-700 hover:text-emerald-900">编辑</button>
              <button onClick={() => handleDeleteExecutionSubTask(subTask.id)} className="text-xs text-red-500 hover:text-red-700">删除</button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newExecutionSubTaskTitle}
              onChange={(event) => setNewExecutionSubTaskTitle(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void handleAddExecutionSubTask() }}
              placeholder="输入可执行 subTask，按回车添加"
              className="flex-1 px-2 py-1 text-xs border rounded-md bg-background"
            />
            <button
              onClick={() => void handleAddExecutionSubTask()}
              disabled={!newExecutionSubTaskTitle.trim()}
              className="px-2 py-1 text-xs bg-emerald-600 text-white rounded-md disabled:opacity-50"
            >添加</button>
          </div>
        </div>
      )}

      {/* 子任务拆解区域 */}
      <div className="mt-2 pl-4 border-l-2 border-muted">
        {subTasksExpanded && (
          <div className="mt-2 space-y-2">
            {subTasksLoading && (
              <div className="text-xs text-muted-foreground">加载中...</div>
            )}
            {!subTasksLoading && subTasks.map((sub) => (
              <div key={sub.id} className="flex items-center gap-2 group">
                <input
                  type="checkbox"
                  checked={sub.status === 'completed'}
                  onChange={() => handleToggleSubTask(sub.id)}
                  className="h-4 w-4 rounded border"
                />
                <span
                  className={`flex-1 text-xs ${
                    sub.status === 'completed' ? 'line-through text-muted-foreground' : ''
                  }`}
                >
                  {sub.title}
                </span>
                <button
                  onClick={() => handleDeleteSubTask(sub.id)}
                  className="text-xs text-red-500 opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-700"
                >
                  删除
                </button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newSubTaskTitle}
                onChange={(e) => setNewSubTaskTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddSubTask()
                }}
                placeholder="输入子任务，按回车添加"
                className="flex-1 px-2 py-1 text-xs border rounded-md bg-background"
              />
              <button
                onClick={handleAddSubTask}
                disabled={!newSubTaskTitle.trim()}
                className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded-md disabled:opacity-50"
              >
                添加
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 风险评估结果弹窗 */}
      {showRiskModal && riskResult && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowRiskModal(false)}>
          <div className="bg-card p-6 rounded-lg border shadow-lg max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4">风险评估结果</h3>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">风险等级:</span>
                <span className={`text-sm font-medium px-2 py-0.5 rounded ${riskLevelBadge(riskResult.riskLevel as Task['riskLevel'])}`}>
                  {riskLabel(riskResult.riskLevel as Task['riskLevel'])}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">需要完成纪要:</span>
                <span className="text-sm font-medium">
                  {riskResult.requiresCompletionNotes ? '是' : '否'}
                </span>
              </div>
              <div>
                <span className="text-sm text-muted-foreground">分析摘要:</span>
                <p className="text-sm mt-1 bg-muted p-3 rounded">{riskResult.summary}</p>
              </div>
            </div>
            <div className="flex justify-end mt-4">
              <button
                onClick={() => setShowRiskModal(false)}
                className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 完成纪要弹窗 */}
      {showCompletionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowCompletionModal(false)}>
          <div className="bg-card p-6 rounded-lg border shadow-lg max-w-lg w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-2">填写完成纪要</h3>
            <p className="text-sm text-muted-foreground mb-4">
              任务: {task.title}
              {task.riskLevel && (
                <span className={`ml-2 px-1.5 py-0.5 rounded text-xs ${riskLevelBadge(task.riskLevel)}`}>
                  风险: {riskLabel(task.riskLevel)}
                </span>
              )}
            </p>
            <textarea
              value={completionNotes}
              onChange={(e) => setCompletionNotes(e.target.value)}
              placeholder="请描述完成过程中的关键决策、遇到的问题、测试结果等..."
              className="w-full px-3 py-2 text-sm border rounded-md bg-background resize-none h-32"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowCompletionModal(false)}
                className="px-4 py-2 text-sm border rounded-md"
              >
                取消
              </button>
              <button
                onClick={handleSaveCompletionNotes}
                disabled={isSavingNotes || !completionNotes.trim()}
                className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md disabled:opacity-50"
              >
                {isSavingNotes ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑任务弹窗 */}
      {showEditModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowEditModal(false)}>
          <div className="bg-card p-6 rounded-lg border shadow-lg max-w-lg w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-4">编辑任务</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">标题</label>
                <input
                  type="text"
                  value={editForm.title}
                  onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border rounded-md bg-background"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">描述</label>
                <textarea
                  value={editForm.description}
                  onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border rounded-md bg-background resize-none h-20"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground">优先级</label>
                  <select
                    value={editForm.priority}
                    onChange={(e) => setEditForm((f) => ({ ...f, priority: e.target.value as Task['priority'] }))}
                    className="w-full px-3 py-2 text-sm border rounded-md bg-background"
                  >
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                    <option value="critical">严重</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">开始日期</label>
                  <input
                    type="date"
                    value={editForm.startDate}
                    onChange={(e) => setEditForm((f) => ({ ...f, startDate: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border rounded-md bg-background"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">开始日期</label>
                  <input type="date" value={executionSubTaskEdit.startDate} onChange={(event) => setExecutionSubTaskEdit((value) => ({ ...value, startDate: event.target.value }))} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">截止日期</label>
                  <input
                    type="date"
                    value={editForm.dueDate}
                    onChange={(e) => setEditForm((f) => ({ ...f, dueDate: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border rounded-md bg-background"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">负责人</label>
                <ContactPicker value={editForm.assigneeName} onChange={(name) => setEditForm((f) => ({ ...f, assigneeName: name, agentAssigneeId: '' }))} />
                {agentEmployees.length > 0 && (
                  <div className="mt-2">
                    <select
                      value={editForm.agentAssigneeId}
                      onChange={(e) => setEditForm((f) => ({ ...f, agentAssigneeId: e.target.value, assigneeName: '' }))}
                      className="w-full px-3 py-2 text-sm border rounded-md bg-background"
                    >
                      <option value="">不指派 AI 员工</option>
                      {agentEmployees.map((emp) => (
                        <option key={emp.id} value={emp.id}>🤖 {emp.name} · {emp.role}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div>
                <label className="text-xs text-muted-foreground">权限申请（AI 员工执行时生效）</label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {PERMISSION_OPTIONS.map((perm) => (
                    <label key={perm.value} className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border cursor-pointer hover:bg-muted/40">
                      <input
                        type="checkbox"
                        checked={editForm.permissions.includes(perm.value)}
                        onChange={(e) => setEditForm((f) => ({ ...f, permissions: e.target.checked ? [...f.permissions, perm.value] : f.permissions.filter((p) => p !== perm.value) }))}
                      />
                      {perm.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowEditModal(false)}
                className="px-4 py-2 text-sm border rounded-md"
              >
                取消
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={isSavingEdit || !editForm.title.trim()}
                className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md disabled:opacity-50"
              >
                {isSavingEdit ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingExecutionSubTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditingExecutionSubTask(null)}>
          <div className="mx-4 w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg" onClick={(event) => event.stopPropagation()}>
            <h3 className="mb-4 text-lg font-semibold">编辑执行 subTask</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">标题</label>
                <input value={executionSubTaskEdit.title} onChange={(event) => setExecutionSubTaskEdit((value) => ({ ...value, title: event.target.value }))} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground">负责人</label>
                  <ContactPicker value={executionSubTaskEdit.assigneeName} onChange={(name) => setExecutionSubTaskEdit((value) => ({ ...value, assigneeName: name }))} />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">截止日期</label>
                  <input type="date" value={executionSubTaskEdit.dueDate} onChange={(event) => setExecutionSubTaskEdit((value) => ({ ...value, dueDate: event.target.value }))} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">完成说明</label>
                <textarea value={executionSubTaskEdit.completionNotes} onChange={(event) => setExecutionSubTaskEdit((value) => ({ ...value, completionNotes: event.target.value }))} className="h-24 w-full resize-none rounded-md border bg-background px-3 py-2 text-sm" placeholder="记录完成过程、结果或阻塞原因" />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setEditingExecutionSubTask(null)} className="rounded-md border px-4 py-2 text-sm">取消</button>
              <button onClick={() => void saveExecutionSubTaskEdit()} disabled={isSavingExecutionSubTask || !executionSubTaskEdit.title.trim()} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{isSavingExecutionSubTask ? '保存中...' : '保存'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function riskLevelBadge(level: Task['riskLevel']): string {
  const map: { low: string; medium: string; high: string; critical: string } = {
    low: 'bg-gray-100 text-gray-700',
    medium: 'bg-yellow-100 text-yellow-700',
    high: 'bg-orange-100 text-orange-700',
    critical: 'bg-red-100 text-red-700',
  }
  const key = level ?? 'medium'
  return map[key as keyof typeof map] ?? map.medium
}

function riskLabel(level: Task['riskLevel']): string {
  const map: { low: string; medium: string; high: string; critical: string } = {
    low: '低',
    medium: '中',
    high: '高',
    critical: '严重',
  }
  const key = level ?? 'medium'
  return map[key as keyof typeof map] ?? '中'
}

function priorityColor(p: Task['priority']): string {
  const map = {
    critical: 'bg-red-100 text-red-700',
    high: 'bg-orange-100 text-orange-700',
    medium: 'bg-blue-100 text-blue-700',
    low: 'bg-gray-100 text-gray-700',
  } as const
  return map[p] ?? map.medium
}

function priorityLabel(p: Task['priority']): string {
  const map: Record<string, string> = {
    critical: '严重',
    high: '高',
    medium: '中',
    low: '低',
  }
  return map[p] || '中'
}

// ===== 会议纪要面板 =====

function MeetingNotesPanel({
  projectId,
  notes,
  onNotesChange,
  onTasksChange,
}: {
  projectId: string
  notes: MeetingNote[]
  onNotesChange: (notes: MeetingNote[]) => void
  onTasksChange: (tasks: Task[]) => void
}): React.ReactElement {
  const [showImport, setShowImport] = useState(false)
  const [showFetchDoc, setShowFetchDoc] = useState(false)
  const [noteTitle, setNoteTitle] = useState('')
  const [noteContent, setNoteContent] = useState('')
  const [docUrl, setDocUrl] = useState('')
  const [isExtracting, setIsExtracting] = useState(false)
  const [isFetchingDoc, setIsFetchingDoc] = useState(false)
  const [drafts, setDrafts] = useState<Task[]>([])

  const handleFetchDoc = async () => {
    if (!docUrl.trim()) return
    setIsFetchingDoc(true)
    try {
      const result = await callProjectAPI<{ note: MeetingNote; drafts: Task[] }>(
        'fetchDingTalkDoc',
        projectId,
        docUrl.trim()
      )
      onNotesChange([...notes, result.note])
      setDrafts(result.drafts)
      setDocUrl('')
      setShowFetchDoc(false)
    } catch (err) {
      console.error('拉取钉钉文档失败:', err)
      alert('拉取失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsFetchingDoc(false)
    }
  }

  const handleImport = async () => {
    if (!noteTitle.trim() || !noteContent.trim()) return
    setIsExtracting(true)
    try {
      const result = await callProjectAPI<{ note: MeetingNote; drafts: Task[] }>(
        'importAndExtract',
        projectId,
        noteTitle,
        noteContent
      )
      onNotesChange([...notes, result.note])
      setDrafts(result.drafts)
      setNoteTitle('')
      setNoteContent('')
      setShowImport(false)
    } catch (err) {
      console.error('导入并提取失败:', err)
      alert('导入失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsExtracting(false)
    }
  }

  const handleConfirmDraft = async (draftId: string) => {
    try {
      const confirmed = await callProjectAPI<Task>('confirmTaskDraft', draftId)
      if (confirmed) {
        setDrafts(drafts.filter((d) => d.id !== draftId))
        // 刷新任务列表（通过重新加载项目详情）
        onTasksChange([])
      }
    } catch (err) {
      console.error('确认草稿失败:', err)
    }
  }

  const handleRejectDraft = async (draftId: string) => {
    try {
      await callProjectAPI<boolean>('rejectTaskDraft', draftId)
      setDrafts(drafts.filter((d) => d.id !== draftId))
    } catch (err) {
      console.error('拒绝草稿失败:', err)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">会议纪要 ({notes.length})</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowFetchDoc(true)}
            className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 transition-colors"
          >
            + 钉钉文档拉取
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            + 导入并提取
          </button>
        </div>
      </div>

      {/* 钉钉文档拉取表单 */}
      {showFetchDoc && (
        <div className="p-4 bg-card rounded-lg border space-y-3">
          <h3 className="text-sm font-medium">从钉钉文档拉取并提取任务</h3>
          <p className="text-xs text-muted-foreground">
            粘贴钉钉在线文档链接（如 https://alidocs.dingtalk.com/i/nodes/xxx），Agent 将自动拉取内容并提取 Action Items 为任务草稿。
          </p>
          <input
            type="text"
            placeholder="钉钉在线文档链接"
            value={docUrl}
            onChange={(e) => setDocUrl(e.target.value)}
            className="w-full px-3 py-2 text-sm border rounded-md bg-background"
          />
          <div className="flex gap-2">
            <button
              onClick={handleFetchDoc}
              disabled={isFetchingDoc || !docUrl.trim()}
              className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50"
            >
              {isFetchingDoc ? '拉取中...' : '拉取并提取'}
            </button>
            <button
              onClick={() => setShowFetchDoc(false)}
              className="px-4 py-2 text-sm border rounded-md hover:bg-muted"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 导入表单 */}
      {showImport && (
        <div className="p-4 bg-card rounded-lg border space-y-3">
          <h3 className="text-sm font-medium">导入会议纪要</h3>
          <input
            type="text"
            placeholder="纪要标题（如：周会 2026-01-15）"
            value={noteTitle}
            onChange={(e) => setNoteTitle(e.target.value)}
            className="w-full px-3 py-2 text-sm border rounded-md bg-background"
          />
          <textarea
            placeholder="粘贴会议纪要内容，Agent 将自动提取 Action Items..."
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            className="w-full px-3 py-2 text-sm border rounded-md bg-background resize-none h-40"
          />
          <div className="flex gap-2">
            <button
              onClick={handleImport}
              disabled={isExtracting}
              className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md disabled:opacity-50"
            >
              {isExtracting ? '提取中...' : '导入并提取任务'}
            </button>
            <button
              onClick={() => setShowImport(false)}
              className="px-3 py-1.5 text-sm border rounded-md"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 提取的草稿任务 */}
      {drafts.length > 0 && (
        <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
          <h3 className="text-sm font-medium text-amber-800 mb-3">
            Agent 提取了 {drafts.length} 个任务草稿，请确认是否加入项目
          </h3>
          <div className="space-y-2">
            {drafts.map((draft) => (
              <div key={draft.id} className="p-3 bg-white rounded-lg border flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{draft.title}</p>
                  <p className="text-xs text-muted-foreground">{draft.description}</p>
                  {draft.assignee && (
                    <p className="text-xs text-muted-foreground">负责人: {draft.assignee.displayName}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleConfirmDraft(draft.id)}
                    className="px-3 py-1 text-xs bg-green-100 text-green-700 rounded-md hover:bg-green-200"
                  >
                    确认
                  </button>
                  <button
                    onClick={() => handleRejectDraft(draft.id)}
                    className="px-3 py-1 text-xs bg-red-100 text-red-700 rounded-md hover:bg-red-200"
                  >
                    拒绝
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 纪要列表 */}
      <div className="space-y-2">
        {notes.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <p>暂无会议纪要</p>
          </div>
        ) : (
          notes.map((note) => (
            <div key={note.id} className="p-4 bg-card rounded-lg border">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium">{note.title}</h3>
                <span className="text-xs text-muted-foreground">
                  {new Date(note.createdAt).toLocaleDateString()}
                </span>
              </div>
              <div className="text-sm text-muted-foreground whitespace-pre-wrap max-h-40 overflow-y-auto">
                {note.rawContent}
              </div>
              {note.extractedTaskIds.length > 0 && (
                <p className="text-xs text-muted-foreground mt-2">
                  已提取 {note.extractedTaskIds.length} 个任务
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ===== 看板 =====

function KanbanView({ board }: { board: KanbanBoard }): React.ReactElement {
  const columns = [
    { title: '待处理', tasks: board.pending, color: 'bg-gray-50' },
    { title: '进行中', tasks: board.in_progress, color: 'bg-blue-50' },
    { title: '已完成', tasks: board.completed, color: 'bg-green-50' },
  ]

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">任务看板</h2>
      <div className="grid grid-cols-3 gap-4">
        {columns.map((col) => (
          <div key={col.title} className={`${col.color} rounded-lg p-4 border`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium">{col.title}</h3>
              <span className="text-xs text-muted-foreground">{col.tasks.length}</span>
            </div>
            <div className="space-y-2 min-h-[200px]">
              {col.tasks.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">暂无任务</div>
              ) : (
                col.tasks.map((task) => (
                  <div key={task.id} className="p-3 bg-white rounded-lg border shadow-sm">
                    <p className="text-sm font-medium">{task.title}</p>
                    <p className="text-xs text-muted-foreground mt-1">{task.description}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ===== 看板总览 =====

function BoardOverview({ projects }: { projects: Project[] }): React.ReactElement {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium">项目看板总览</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => (
          <ProjectCardOverview key={project.id} project={project} />
        ))}
      </div>
    </div>
  )
}

function ProjectCardOverview({ project }: { project: Project }): React.ReactElement {
  const [board, setBoard] = useState<KanbanBoard | null>(null)

  useEffect(() => {
    callProjectAPI<KanbanBoard>('getKanbanBoard', project.id)
      .then(setBoard)
      .catch(() => setBoard(null))
  }, [project.id])

  if (!board) return <div className="p-4 border rounded-lg animate-pulse">加载中...</div>

  return (
    <div className="p-4 bg-card rounded-lg border">
      <h3 className="font-medium text-sm mb-3">{project.title}</h3>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="p-2 bg-gray-50 rounded">
          <div className="text-lg font-semibold">{board.pending.length}</div>
          <div className="text-xs text-muted-foreground">待处理</div>
        </div>
        <div className="p-2 bg-blue-50 rounded">
          <div className="text-lg font-semibold">{board.in_progress.length}</div>
          <div className="text-xs text-muted-foreground">进行中</div>
        </div>
        <div className="p-2 bg-green-50 rounded">
          <div className="text-lg font-semibold">{board.completed.length}</div>
          <div className="text-xs text-muted-foreground">已完成</div>
        </div>
      </div>
    </div>
  )
}

// ===== 设置 =====

// ===== Brief 回执面板 =====

interface BriefReceiptItem {
  id: string
  taskId: string
  projectId: string
  unionId: string
  brief: string
  status: 'pending' | 'responded' | 'skipped'
  content?: string
  formUrl?: string
  createdAt: number
  respondedAt?: number
}

function BriefPanel({ projectId, tasks }: { projectId: string; tasks: Task[] }): React.ReactElement {
  const [receipts, setReceipts] = useState<BriefReceiptItem[]>([])
  const [isSending, setIsSending] = useState<string | null>(null)

  const loadReceipts = useCallback(async () => {
    try {
      const data = await callProjectAPI<BriefReceiptItem[]>('listBriefReceipts', projectId)
      setReceipts(data)
    } catch (err) {
      console.error('加载 Brief 回执失败:', err)
    }
  }, [projectId])

  React.useEffect(() => {
    loadReceipts()
  }, [loadReceipts])

  const taskTitleById = new Map(tasks.map((t) => [t.id, t.title]))

  const handleSendBrief = async (taskId: string) => {
    setIsSending(taskId)
    try {
      const receipt = await callProjectAPI<BriefReceiptItem | null>('sendBrief', taskId)
      if (receipt) {
        await loadReceipts()
      } else {
        alert('该任务不是核心任务或未分配负责人（含钉钉 unionId）')
      }
    } catch (err) {
      console.error('发送 Brief 失败:', err)
      alert('发送失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsSending(null)
    }
  }

  const formatTime = (ts?: number) => ts ? new Date(ts).toLocaleString('zh-CN') : '-'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Brief 回执 ({receipts.length})</h2>
        <p className="text-xs text-muted-foreground">
          核心任务（高优先级/高风险）创建后自动发送 Brief，同学填写回执后自动回写。
        </p>
      </div>

      {receipts.length === 0 && (
        <div className="p-8 text-center text-muted-foreground border rounded-lg">
          <p>暂无 Brief 回执</p>
          <p className="text-sm mt-1">在下方为任意核心任务手动发送 Brief，或创建高优先级任务自动触发</p>
        </div>
      )}

      <div className="space-y-2">
        {receipts.map((receipt) => (
          <div key={receipt.id} className="p-4 rounded-lg border bg-card space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">
                {taskTitleById.get(receipt.taskId) ?? `任务 ${receipt.taskId}`}
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                receipt.status === 'responded'
                  ? 'bg-green-500/15 text-green-700'
                  : receipt.status === 'skipped'
                    ? 'bg-gray-500/15 text-gray-600'
                    : 'bg-amber-500/15 text-amber-700'
              }`}>
                {receipt.status === 'responded' ? '已回执' : receipt.status === 'skipped' ? '已跳过' : '待回执'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground whitespace-pre-wrap">{receipt.brief}</p>
            {receipt.status === 'responded' && (
              <div className="text-sm bg-green-500/5 rounded-md p-2 border border-green-500/20">
                <div className="text-xs text-green-700 mb-1">✅ 同学回执（{formatTime(receipt.respondedAt)}）：</div>
                {receipt.content}
              </div>
            )}
            <div className="text-xs text-muted-foreground">发送于 {formatTime(receipt.createdAt)}</div>
          </div>
        ))}
      </div>

      {/* 手动发送 Brief */}
      <div className="p-4 rounded-lg border border-dashed space-y-3">
        <div className="text-sm font-medium">手动发送/补发 Brief</div>
        <div className="flex flex-wrap gap-2">
          {tasks
            .filter((t) => t.status !== 'draft' && t.assignee)
            .slice(0, 20)
            .map((task) => (
              <button
                key={task.id}
                onClick={() => handleSendBrief(task.id)}
                disabled={isSending === task.id}
                className="px-3 py-1.5 text-xs border rounded-md hover:bg-muted disabled:opacity-50"
              >
                {isSending === task.id ? '发送中...' : task.title}
              </button>
            ))}
          {tasks.filter((t) => t.status !== 'draft' && t.assignee).length === 0 && (
            <p className="text-xs text-muted-foreground">当前没有已分配负责人的任务</p>
          )}
        </div>
      </div>
    </div>
  )
}
