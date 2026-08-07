/**
 * AgentTeamPanel — 项目管理「团队」Tab
 *
 * AI 员工管理：列表 / 新建 / 编辑 / 启停 / 删除，以及员工执行记录概览。
 * 由 ProjectView 的「团队」Tab 渲染（替代原 SettingsPlaceholder）。
 */

import * as React from 'react'
import { Bot, Plus, Pencil, Trash2, Play, Square, CheckCircle2, XCircle, Clock3, Loader2, Users, RefreshCw } from 'lucide-react'
import type { AgentEmployeeResult, AgentExecutionResult, Channel, WorkflowDefinition, MemberResult, MemberSyncAllResult } from '@gravitas/shared'
import { cn } from '@/lib/utils'
import { FileEventPanel } from './FileEventPanel'
import { TodoEventPanel } from './TodoEventPanel'

const RUNTIME_LABEL: Record<string, string> = {
  proma: 'Gravitas',
  'ai-sdk': 'AI SDK',
  pi: 'Pi',
  claude: 'Claude',
}

const EXEC_STATUS_META: Record<string, { label: string; className: string }> = {
  queued: { label: '排队中', className: 'bg-foreground/[0.06] text-foreground/60' },
  running: { label: '运行中', className: 'bg-blue-500/10 text-blue-500' },
  completed: { label: '已完成', className: 'bg-green-500/10 text-green-600' },
  failed: { label: '失败', className: 'bg-red-500/10 text-red-600' },
  cancelled: { label: '已取消', className: 'bg-foreground/[0.06] text-foreground/60' },
  stale: { label: '失联', className: 'bg-amber-500/10 text-amber-600' },
}

export function AgentTeamPanel(): React.ReactElement {
  const [employees, setEmployees] = React.useState<AgentEmployeeResult[]>([])
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [loading, setLoading] = React.useState(true)
  const [showForm, setShowForm] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [executionsByAgent, setExecutionsByAgent] = React.useState<Record<string, AgentExecutionResult[]>>({})

  // 表单状态
  const [form, setForm] = React.useState({
    name: '',
    role: '',
    description: '',
    runtime: 'proma' as string,
    channelId: '',
    modelId: '',
    workflowId: '',
    systemPrompt: '',
  })
  const [saving, setSaving] = React.useState(false)
  const [workflows, setWorkflows] = React.useState<WorkflowDefinition[]>([])

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const [emps, chs, wfs] = await Promise.all([
        window.electronAPI.paa.agentEmployees.list(),
        window.electronAPI.listChannels(),
        window.electronAPI.listWorkflowDefinitions().catch(() => []),
      ])
      setEmployees(emps)
      setChannels(chs.filter((c) => c.enabled))
      setWorkflows(wfs.filter((w) => w.status === 'published'))
    } catch (err) {
      console.error('[AI员工] 加载失败:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadExecutions = React.useCallback(async (agentId: string): Promise<void> => {
    try {
      const execs = await window.electronAPI.paa.agentEmployees.listExecutionsByAgent(agentId, 10)
      setExecutionsByAgent((prev) => ({ ...prev, [agentId]: execs }))
    } catch {
      // 忽略
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const openCreate = (): void => {
    setEditingId(null)
    setForm({ name: '', role: '', description: '', runtime: 'proma', channelId: channels[0]?.id ?? '', modelId: '', workflowId: '', systemPrompt: '' })
    setShowForm(true)
  }

  const openEdit = (emp: AgentEmployeeResult): void => {
    setEditingId(emp.id)
    setForm({
      name: emp.name,
      role: emp.role,
      description: emp.description,
      runtime: emp.runtime,
      channelId: emp.channelId,
      modelId: emp.modelId ?? '',
      workflowId: emp.workflowId ?? '',
      systemPrompt: emp.systemPrompt ?? '',
    })
    setShowForm(true)
  }

  const handleSave = async (): Promise<void> => {
    if (!form.name.trim() || !form.channelId) return
    setSaving(true)
    try {
      const input = {
        name: form.name.trim(),
        role: form.role.trim() || '通用',
        description: form.description.trim(),
        runtime: form.runtime as 'proma' | 'ai-sdk' | 'pi' | 'claude',
        channelId: form.channelId,
        modelId: form.modelId.trim() || undefined,
        workflowId: form.workflowId || undefined,
        systemPrompt: form.systemPrompt.trim() || undefined,
      }
      if (editingId) {
        await window.electronAPI.paa.agentEmployees.update(editingId, input)
      } else {
        await window.electronAPI.paa.agentEmployees.create(input)
      }
      setShowForm(false)
      await load()
    } catch (err) {
      console.error('[AI员工] 保存失败:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (emp: AgentEmployeeResult): Promise<void> => {
    await window.electronAPI.paa.agentEmployees.update(emp.id, { enabled: !emp.enabled })
    await load()
  }

  const handleDelete = async (emp: AgentEmployeeResult): Promise<void> => {
    if (!confirm(`确定删除 AI 员工「${emp.name}」？执行记录会保留。`)) return
    await window.electronAPI.paa.agentEmployees.delete(emp.id)
    await load()
  }

  return (
    <div className="space-y-4">
      {/* 通讯录成员同步（PH1-A） */}
      <MemberSyncPanel />

      {/* 文件共享事件流（PH2-A） */}
      <FileEventPanel />

      {/* Todo 事件流（PH2-A） */}
      <TodoEventPanel />

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">AI 员工</h2>
          <p className="text-sm text-muted-foreground mt-1">
            定义可被指派任务的 AI 员工。任务指派给 AI 员工后自动由 Agent 执行并回写结果。
          </p>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          <Plus size={14} /> 新建 AI 员工
        </button>
      </div>

      {/* AI 团队效能总览（P2） */}
      {!loading && employees.length > 0 && <AgentTeamOverview employees={employees} />}

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">加载中…</div>
      ) : employees.length === 0 && !showForm ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
          <Bot size={28} className="mx-auto mb-2 text-foreground/20" />
          <p>暂无 AI 员工。点击右上角「新建 AI 员工」创建第一个。</p>
        </div>
      ) : (
        <div className="space-y-3">
          {employees.map((emp) => {
            const execs = executionsByAgent[emp.id] ?? []
            const stats = emp.totalTasks > 0
              ? `累计 ${emp.totalTasks} 任务 · 完成 ${emp.completedTasks} · 失败 ${emp.failureCount}${emp.avgDurationMs ? ` · 平均 ${Math.round(emp.avgDurationMs / 60_000)}min` : ''}`
              : '暂无执行记录'
            return (
              <div key={emp.id} className="rounded-lg border border-border/50 bg-foreground/[0.02] p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 size-8 flex items-center justify-center rounded-lg bg-primary/10 text-primary/70">
                    <Bot size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{emp.name}</span>
                      <span className="px-1.5 py-[1px] rounded-full bg-foreground/[0.06] text-[10px] text-foreground/50">{emp.role}</span>
                      <span className="px-1.5 py-[1px] rounded-full bg-foreground/[0.06] text-[10px] text-foreground/50">{RUNTIME_LABEL[emp.runtime] ?? emp.runtime}</span>
                      {emp.workflowId && (
                        <span className="px-1.5 py-[1px] rounded-full bg-violet-500/10 text-violet-600 text-[10px]" title="绑定 Workflow SOP，任务用 Workflow 执行">SOP</span>
                      )}
                      <span className={cn('px-1.5 py-[1px] rounded-full text-[10px]', emp.enabled ? 'bg-green-500/10 text-green-600' : 'bg-foreground/[0.06] text-foreground/50')}>
                        {emp.enabled ? '启用' : '停用'}
                      </span>
                    </div>
                    {emp.description && <p className="text-xs text-foreground/55 mt-1 line-clamp-2">{emp.description}</p>}
                    <p className="text-[11px] text-foreground/35 mt-1">{stats}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => void handleToggle(emp)} className="p-1.5 rounded hover:bg-foreground/[0.06] text-foreground/40 hover:text-foreground/70" title={emp.enabled ? '停用' : '启用'}>
                      {emp.enabled ? <Square size={13} /> : <Play size={13} />}
                    </button>
                    <button onClick={() => openEdit(emp)} className="p-1.5 rounded hover:bg-foreground/[0.06] text-foreground/40 hover:text-foreground/70" title="编辑">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => void handleDelete(emp)} className="p-1.5 rounded hover:bg-destructive/10 text-foreground/40 hover:text-destructive" title="删除">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {/* 执行记录概览 */}
                {execs.length > 0 ? (
                  <div className="pl-11 space-y-1">
                    {execs.map((exec) => {
                      const meta = EXEC_STATUS_META[exec.status] ?? { label: exec.status, className: 'bg-foreground/[0.06] text-foreground/60' }
                      return (
                        <div key={exec.id} className="flex items-center gap-2 text-[11px] text-foreground/55">
                          <span className={cn('shrink-0 px-1.5 py-[1px] rounded-full text-[10px]', meta.className)}>{meta.label}</span>
                          <span className="truncate flex-1">{exec.entityId === 'task' ? '任务' : '子任务'} · {exec.resultSummary?.slice(0, 60) ?? exec.error?.slice(0, 60) ?? '…'}</span>
                          <span className="shrink-0 text-foreground/30 tabular-nums">{new Date(exec.startedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <button
                    onClick={() => void loadExecutions(emp.id)}
                    className="pl-11 text-[11px] text-foreground/35 hover:text-foreground/60"
                  >
                    查看执行记录
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {showForm && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <h3 className="text-sm font-medium">{editingId ? '编辑 AI 员工' : '新建 AI 员工'}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="名称（如：前端工程师 · Nova）"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="px-3 py-2 text-sm border rounded-md bg-background"
            />
            <input
              type="text"
              placeholder="角色（如：前端 / 后端 / 测试 / 数据分析）"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="px-3 py-2 text-sm border rounded-md bg-background"
            />
          </div>
          <textarea
            placeholder="能力描述（会注入到执行指令中，例如：擅长 React 组件开发、TypeScript 重构、单元测试编写）"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full px-3 py-2 text-sm border rounded-md bg-background resize-none h-20"
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Runtime</label>
              <select
                value={form.runtime}
                onChange={(e) => setForm({ ...form, runtime: e.target.value })}
                className="w-full px-3 py-2 text-sm border rounded-md bg-background"
              >
                {Object.entries(RUNTIME_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">渠道</label>
              <select
                value={form.channelId}
                onChange={(e) => setForm({ ...form, channelId: e.target.value })}
                className="w-full px-3 py-2 text-sm border rounded-md bg-background"
              >
                {channels.length === 0 && <option value="">无可用渠道</option>}
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.provider}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">模型（可选）</label>
              <input
                type="text"
                placeholder="默认渠道首个启用模型"
                value={form.modelId}
                onChange={(e) => setForm({ ...form, modelId: e.target.value })}
                className="w-full px-3 py-2 text-sm border rounded-md bg-background"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">绑定 Workflow SOP（可选）</label>
              <select
                value={form.workflowId}
                onChange={(e) => setForm({ ...form, workflowId: e.target.value })}
                className="w-full px-3 py-2 text-sm border rounded-md bg-background"
              >
                <option value="">不绑定（headless 执行）</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>{w.name} · v{w.publication?.version ?? '?'}</option>
                ))}
              </select>
              {workflows.length === 0 && (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">暂无已发布的 Workflow，请在「工作流」工作台先发布一个 SOP。</p>
              )}
            </div>
          </div>
          <textarea
            placeholder="自定义 system prompt（可选，覆盖自动生成的角色指令）"
            value={form.systemPrompt}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            className="w-full px-3 py-2 text-sm border rounded-md bg-background resize-none h-16"
          />
          <div className="flex gap-2">
            <button onClick={() => void handleSave()} disabled={saving || !form.name.trim() || !form.channelId} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md disabled:opacity-50">
              {saving && <Loader2 size={14} className="animate-spin" />}
              {editingId ? '保存' : '创建'}
            </button>
            <button onClick={() => setShowForm(false)} className="px-3 py-1.5 text-sm border rounded-md">取消</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** AI 团队效能总览（P2）：聚合员工统计字段 */
/** 统一成员视图 + 通讯录同步（PH1-A/B） */
function MemberSyncPanel(): React.ReactElement {
  const [result, setResult] = React.useState<MemberSyncAllResult | null>(null)
  const [members, setMembers] = React.useState<MemberResult[]>([])
  const [syncing, setSyncing] = React.useState(false)
  const [error, setError] = React.useState('')

  const loadMembers = React.useCallback(async (): Promise<void> => {
    try {
      // 统一成员视图：真人 + AI 员工 + bot
      const list = await window.electronAPI.paa.project.listMemberDirectory({ activeOnly: true })
      setMembers(list)
    } catch {
      // 旧通道回退：仅真人
      try {
        const list = await window.electronAPI.paa.project.listMembers({ activeOnly: true })
        setMembers(list)
      } catch {
        setMembers([])
      }
    }
  }, [])

  React.useEffect(() => {
    void loadMembers()
  }, [loadMembers])

  const handleSync = async (): Promise<void> => {
    if (syncing) return
    setSyncing(true)
    setError('')
    setResult(null)
    try {
      const res = await window.electronAPI.paa.project.syncMembersAll()
      setResult(res)
      await loadMembers()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncing(false)
    }
  }

  const humans = members.filter((m) => m.kind === 'human')
  const agents = members.filter((m) => m.kind === 'agent')
  const bots = members.filter((m) => m.kind === 'bot')
  const row = (r?: { pulled: number; inserted: number; merged: number; failed: number }): string | null => {
    if (!r) return null
    return `拉取 ${r.pulled} · 新增 ${r.inserted} · 合并 ${r.merged} · 失败 ${r.failed}`
  }

  return (
    <div className="rounded-lg border border-border/50 bg-foreground/[0.02] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-muted-foreground" />
          <div>
            <h3 className="text-sm font-medium">团队 / 通讯录成员</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              真人 {humans.length} · AI 员工 {agents.length} · Bot {bots.length}
            </p>
          </div>
        </div>
        <button
          onClick={() => void handleSync()}
          disabled={syncing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          {syncing ? '同步中…' : '同步通讯录'}
        </button>
      </div>

      {/* 统一成员列表（真人 / AI 员工 / Bot） */}
      {members.length > 0 && (
        <div className="max-h-40 overflow-auto space-y-1">
          {members.map((m) => (
            <div key={m.memberId} className="flex items-center gap-2 text-xs">
              <span className={
                m.kind === 'human'
                  ? 'px-1.5 py-[1px] rounded bg-foreground/[0.06] text-foreground/50'
                  : m.kind === 'agent'
                    ? 'px-1.5 py-[1px] rounded bg-primary/10 text-primary'
                    : 'px-1.5 py-[1px] rounded bg-amber-500/15 text-amber-600'
              }>
                {m.kind === 'human' ? '真人' : m.kind === 'agent' ? 'AI' : 'Bot'}
              </span>
              <span className="truncate">{m.displayName}</span>
              {m.role && <span className="ml-auto shrink-0 text-muted-foreground">{m.role}</span>}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-md bg-destructive/10 text-destructive px-3 py-2 text-xs whitespace-pre-wrap">{error}</div>
      )}

      {result && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md bg-foreground/[0.04] px-3 py-2">
            <div className="font-medium mb-0.5">飞书 {result.feishu.error ? '失败' : '完成'}</div>
            {result.feishu.error ? <div className="text-destructive whitespace-pre-wrap">{result.feishu.error}</div> : <div className="text-muted-foreground">{row(result.feishu)}</div>}
          </div>
          <div className="rounded-md bg-foreground/[0.04] px-3 py-2">
            <div className="font-medium mb-0.5">钉钉 {result.dingtalk.error ? '失败' : '完成'}</div>
            {result.dingtalk.error ? <div className="text-destructive whitespace-pre-wrap">{result.dingtalk.error}</div> : <div className="text-muted-foreground">{row(result.dingtalk)}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

function AgentTeamOverview({ employees }: { employees: AgentEmployeeResult[] }): React.ReactElement {
  const totalTasks = employees.reduce((sum, e) => sum + e.totalTasks, 0)
  const completedTasks = employees.reduce((sum, e) => sum + e.completedTasks, 0)
  const failedTasks = employees.reduce((sum, e) => sum + e.failureCount, 0)
  const activeCount = employees.filter((e) => e.enabled).length
  const avgDurations = employees.map((e) => e.avgDurationMs).filter((d): d is number => !!d)
  const avgDuration = avgDurations.length > 0 ? Math.round(avgDurations.reduce((a, b) => a + b, 0) / avgDurations.length / 60_000) : 0
  const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

  const ranked = [...employees].sort((a, b) => (b.completedTasks - a.completedTasks) || ((a.avgDurationMs ?? 0) - (b.avgDurationMs ?? 0)))

  return (
    <div className="rounded-lg border border-border/50 bg-gradient-to-br from-foreground/[0.03] to-transparent p-4">
      <div className="flex items-center gap-2 mb-3">
        <Bot size={14} className="text-primary/70" />
        <span className="text-sm font-medium">AI 团队效能</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg bg-background/60 p-3">
          <div className="text-[11px] text-foreground/40">累计任务</div>
          <div className="text-lg font-semibold mt-0.5">{totalTasks}<span className="text-xs font-normal text-foreground/40"> · {activeCount} 名启用</span></div>
        </div>
        <div className="rounded-lg bg-background/60 p-3">
          <div className="text-[11px] text-foreground/40">完成率</div>
          <div className="text-lg font-semibold mt-0.5">{totalTasks > 0 ? `${completionRate}%` : '—'}</div>
        </div>
        <div className="rounded-lg bg-background/60 p-3">
          <div className="text-[11px] text-foreground/40">失败 / 失联</div>
          <div className="text-lg font-semibold mt-0.5">{failedTasks}</div>
        </div>
        <div className="rounded-lg bg-background/60 p-3">
          <div className="text-[11px] text-foreground/40">平均执行时长</div>
          <div className="text-lg font-semibold mt-0.5">{avgDuration > 0 ? `${avgDuration}min` : '—'}</div>
        </div>
      </div>
      {ranked.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-foreground/45">
          <span className="text-foreground/35">员工排行（按完成任务）：</span>
          {ranked.slice(0, 5).map((e, i) => (
            <span key={e.id}>{i + 1}. {e.name} <span className="text-foreground/30">({e.completedTasks})</span></span>
          ))}
        </div>
      )}
    </div>
  )
}

/** 任务行 / 详情中的 AI 执行状态徽标 */
export function AgentExecutionBadge({ status }: { status: AgentExecutionResult['status'] }): React.ReactElement | null {
  const meta = EXEC_STATUS_META[status]
  if (!meta) return null
  const icon = status === 'running' ? <Loader2 size={10} className="animate-spin" />
    : status === 'completed' ? <CheckCircle2 size={10} />
    : status === 'failed' || status === 'stale' ? <XCircle size={10} />
    : <Clock3 size={10} />
  return (
    <span className={cn('inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full text-[10px]', meta.className)}>
      {icon}
      {meta.label}
    </span>
  )
}
