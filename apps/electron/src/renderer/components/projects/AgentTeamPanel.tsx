/**
 * AgentTeamPanel — 项目管理「团队」Tab
 *
 * AI 员工管理：列表 / 新建 / 编辑 / 启停 / 删除，以及员工执行记录概览。
 * 由 ProjectView 的「团队」Tab 渲染（替代原 SettingsPlaceholder）。
 */

import * as React from 'react'
import { Bot, Plus, Pencil, Trash2, Play, Square, CheckCircle2, XCircle, Clock3, Loader2 } from 'lucide-react'
import type { AgentEmployeeResult, AgentExecutionResult, Channel } from '@proma/shared'
import { cn } from '@/lib/utils'

const RUNTIME_LABEL: Record<string, string> = {
  proma: 'Proma',
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
    systemPrompt: '',
  })
  const [saving, setSaving] = React.useState(false)

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const [emps, chs] = await Promise.all([
        window.electronAPI.paa.agentEmployees.list(),
        window.electronAPI.listChannels(),
      ])
      setEmployees(emps)
      setChannels(chs.filter((c) => c.enabled))
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
    setForm({ name: '', role: '', description: '', runtime: 'proma', channelId: channels[0]?.id ?? '', modelId: '', systemPrompt: '' })
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
