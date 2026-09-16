/**
 * AgentTeamPanel — 项目管理「团队」Tab
 *
 * AI 员工管理：列表 / 新建 / 编辑 / 启停 / 删除，以及员工执行记录概览。
 * 由 ProjectView 的「团队」Tab 渲染（替代原 SettingsPlaceholder）。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { Bot, Plus, Pencil, Trash2, Play, Square, CheckCircle2, XCircle, Clock3, Loader2, Users, RefreshCw } from 'lucide-react'
import type { AgentEmployeeResult, AgentExecutionResult, Channel, WorkflowDefinition, MemberResult, MemberSyncAllResult } from '@gravitas/shared'
import { cn } from '@/lib/utils'
import { FileEventPanel } from './FileEventPanel'
import { TodoEventPanel } from './TodoEventPanel'
import { MailboxPanel } from './MailboxPanel'
import { EmployeeGovernancePanel } from './EmployeeGovernancePanel'

const RUNTIME_LABEL: Record<string, string> = {
  proma: 'Gravitas',
  'ai-sdk': 'AI SDK',
  pi: 'Pi',
  claude: 'Claude',
}

const EXEC_STATUS_META: Record<string, { label: string; className: string }> = {
  queued: { label: '排队中', className: 'bg-foreground/[0.06] text-foreground/60' },
  running: { label: '运行中', className: 'bg-blue-500/10 text-blue-500' },
  completed: { label: '执行完成·待验收', className: 'bg-green-500/10 text-green-600' },
  failed: { label: '失败', className: 'bg-red-500/10 text-red-600' },
  cancelled: { label: '已取消', className: 'bg-foreground/[0.06] text-foreground/60' },
  stale: { label: '失联', className: 'bg-amber-500/10 text-amber-600' },
}

export function AgentTeamPanel(): React.ReactElement {
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const { openSession } = useOpenSession()
  const [error, setError] = React.useState('')
  const [employees, setEmployees] = React.useState<AgentEmployeeResult[]>([])
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [loading, setLoading] = React.useState(true)
  const [showForm, setShowForm] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [executionsByAgent, setExecutionsByAgent] = React.useState<Record<string, AgentExecutionResult[]>>({})
  interface CapabilityPanelData {
    versions: Array<{ id: string; parentVersionId?: string; versionNumber: number; scope: string; workspaceId?: string; status: string; source: string; content: string; contentHash: string; createdAt: number; activatedAt?: number; retiredAt?: number }>
    samples: Array<{ id: string; executionId: string; outcome: string; privacyStatus: string; evidenceSummary: string; capabilityVersionIds: string[]; createdAt: number }>
    observations: import('@gravitas/shared').AgentEmployeeCapabilityObservationResult[]
    audits: import('@gravitas/shared').AgentEmployeeCapabilityRollbackAuditResult[]
    health: import('@gravitas/shared').AgentEmployeeCapabilityHealthResult[]
    alerts: import('@gravitas/shared').AgentEmployeeCapabilityAlertResult[]
  }
  const [capabilityData, setCapabilityData] = React.useState<Record<string, CapabilityPanelData>>({})
  const [reviewingSampleId, setReviewingSampleId] = React.useState<string | null>(null)
  const [sampleDrafts, setSampleDrafts] = React.useState<Record<string, string>>({})
  const [rollingBackVersionId, setRollingBackVersionId] = React.useState<string | null>(null)
  const [evaluatingAgentId, setEvaluatingAgentId] = React.useState<string | null>(null)
  const [evaluationResult, setEvaluationResult] = React.useState<Record<string, import('@gravitas/shared').AgentEmployeeCapabilityEvaluationResult>>({})
  const [evaluationForm, setEvaluationForm] = React.useState<Record<string, { scope: 'role' | 'workspace'; channelId: string; modelId: string; judgeChannelId: string; judgeModelId: string }>>({})
  const [sampleScans, setSampleScans] = React.useState<Record<string, import('@gravitas/shared').SampleSensitiveFindingResult[]>>({})

  // 表单状态
  const [form, setForm] = React.useState({
    name: '',
    role: '',
    description: '',
    runtime: 'proma' as string,
    channelId: '',
    modelId: '',
    workflowId: '',
    workspaceIds: [] as string[],
    executionProfile: 'general' as 'general' | 'development',
    permissionMode: 'safe' as 'safe' | 'auto',
    systemPrompt: '',
  })
  const [saving, setSaving] = React.useState(false)
  const [workflows, setWorkflows] = React.useState<WorkflowDefinition[]>([])

  const load = React.useCallback(async (): Promise<void> => {
    try {
      const [emps, chs, wfs, spaces] = await Promise.all([
        window.electronAPI.paa.agentEmployees.list(),
        window.electronAPI.listChannels(),
        window.electronAPI.listWorkflowDefinitions().catch(() => []),
        window.electronAPI.listAgentWorkspaces(),
      ])
      setWorkspaces(spaces)
      setError('')
      setEmployees(emps)
      setChannels(chs.filter((c) => c.enabled))
      setWorkflows(wfs.filter((w) => w.status === 'published'))
    } catch (err) {
      setError(err instanceof Error ? err.message : '员工加载失败')
      console.error('[AI员工] 加载失败:', err)
    } finally {
      setLoading(false)
    }
  }, [setWorkspaces])

  const loadCapabilities = React.useCallback(async (agentId: string): Promise<void> => {
    try {
      const [versions, samples, observations, audits, health, alerts] = await Promise.all([
        window.electronAPI.paa.agentEmployees.listCapabilityVersions(agentId),
        window.electronAPI.paa.agentEmployees.listLearningSamples(agentId),
        window.electronAPI.paa.agentEmployees.getCapabilityObservations(agentId),
        window.electronAPI.paa.agentEmployees.listCapabilityRollbackAudits(agentId),
        window.electronAPI.paa.agentEmployees.getCapabilityHealth(agentId, 30),
        window.electronAPI.paa.agentEmployees.getCapabilityAlerts(agentId, 30),
      ])
      setCapabilityData((current) => ({ ...current, [agentId]: { versions: versions as never[], samples: samples as never[], observations, audits, health, alerts } }))
    } catch (err) {
      setError(err instanceof Error ? err.message : '能力演化数据加载失败')
    }
  }, [])

  const scanSample = async (sampleId: string, text: string): Promise<void> => {
    const findings = await window.electronAPI.paa.agentEmployees.scanSampleContent(text)
    setSampleScans((current) => ({ ...current, [sampleId]: findings }))
  }

  const reviewSample = async (agentId: string, sampleId: string): Promise<void> => {
    const summary = sampleDrafts[sampleId]?.trim()
    if (!summary) return
    // 只在确实命中敏感内容时要求二次确认；判定仅供人工参考，不自动改写。
    const findings = await window.electronAPI.paa.agentEmployees.scanSampleContent(summary)
    setSampleScans((current) => ({ ...current, [sampleId]: findings }))
    if (findings.length > 0 && !confirm(`检测到 ${findings.length} 类疑似敏感内容：\n\n${findings.map((item) => `· ${item.message}（${item.excerpt}）`).join('\n')}\n\n确认已人工检查并删除后继续？`)) return
    setReviewingSampleId(sampleId)
    try {
      await window.electronAPI.paa.agentEmployees.reviewLearningSample(sampleId, summary)
      await loadCapabilities(agentId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '样本审核失败')
    } finally {
      setReviewingSampleId(null)
    }
  }

  const excludeSample = async (agentId: string, sampleId: string): Promise<void> => {
    if (!confirm('排除后该样本将不能进入能力候选输入，确认继续？')) return
    setReviewingSampleId(sampleId)
    try {
      await window.electronAPI.paa.agentEmployees.excludeLearningSample(sampleId)
      await loadCapabilities(agentId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '样本排除失败')
    } finally {
      setReviewingSampleId(null)
    }
  }

  const runCapabilityEvaluation = async (emp: AgentEmployeeResult): Promise<void> => {
    const form = evaluationForm[emp.id] ?? { scope: 'role' as const, channelId: emp.channelId, modelId: emp.modelId ?? '', judgeChannelId: '', judgeModelId: '' }
    if (!form.modelId.trim()) { setError('请显式填写用于本次评测的模型'); return }
    if (!confirm('本次只生成待审批候选，不会激活生产版本。确认开始受控评测？')) return
    setEvaluatingAgentId(emp.id)
    setError('')
    try {
      const result = await window.electronAPI.paa.agentEmployees.runCapabilityEvaluation({ agentId: emp.id, scope: form.scope, workspaceId: form.scope === 'workspace' ? emp.workspaceIds?.[0] : undefined, channelId: form.channelId, modelId: form.modelId.trim(), judgeChannelId: form.judgeChannelId.trim() || undefined, judgeModelId: form.judgeModelId.trim() || undefined })
      setEvaluationResult((current) => ({ ...current, [emp.id]: result }))
      await loadCapabilities(emp.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '受控评测失败')
    } finally {
      setEvaluatingAgentId(null)
    }
  }

  const rollbackCapability = async (agentId: string, versionId: string): Promise<void> => {
    try {
      const preview = await window.electronAPI.paa.agentEmployees.previewCapabilityRollback(agentId, versionId)
      const targetText = preview.targetIsBaseline ? '回到基线（不再附加能力文本）' : `回滚到父版本 v${preview.targetVersionNumber ?? '?'}`
      if (!confirm(`回滚影响预览：\n\n${targetText}\n进行中执行：${preview.activeExecutionCount} 个（保持已冻结版本）\n关联工作区版本：${preview.dependentWorkspaceVersionCount} 个\n历史执行：不受影响\n\n${preview.note}\n\n确认继续？`)) return
    } catch (err) {
      setError(err instanceof Error ? err.message : '回滚影响预览失败')
      return
    }
    const reason = prompt('请输入回滚原因。该原因将写入不可变审计记录：')?.trim()
    if (!reason) return
    setRollingBackVersionId(versionId)
    try {
      await window.electronAPI.paa.agentEmployees.rollbackCapabilityVersion(agentId, versionId, reason)
      await loadCapabilities(agentId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '能力版本回滚失败')
    } finally {
      setRollingBackVersionId(null)
    }
  }

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
    setError('')
    setForm({ name: '', role: '', description: '', runtime: 'proma', channelId: channels[0]?.id ?? '', modelId: '', workflowId: '', workspaceIds: [], executionProfile: 'general', permissionMode: 'safe', systemPrompt: '' })
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
      workspaceIds: emp.workspaceIds?.length ? emp.workspaceIds : emp.workspaceId ? [emp.workspaceId] : [],
      executionProfile: emp.executionProfile ?? 'general',
      permissionMode: emp.permissionMode ?? 'safe',
      systemPrompt: emp.systemPrompt ?? '',
    })
    setShowForm(true)
  }

  const handleSave = async (): Promise<void> => {
    if (!form.name.trim() || !form.channelId) return
    if (editingId && form.executionProfile === 'general' && employees.find((employee) => employee.id === editingId)?.executionProfile === 'development' && !confirm('切回普通员工将恢复旧版全自动权限，且不再隔离 worktree。确认切换？')) return
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
        workspaceIds: form.workspaceIds,
        workspaceId: form.workspaceIds[0] || undefined,
        executionProfile: form.executionProfile,
        permissionMode: form.permissionMode,
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
      setError(err instanceof Error ? err.message : '员工保存失败')
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
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {/* 通讯录成员同步（PH1-A） */}
      <MemberSyncPanel />

      {/* 文件共享事件流（PH2-A） */}
      <FileEventPanel />

      {/* Todo 事件流（PH2-A） */}
      <TodoEventPanel />

      {/* 团队收件箱（PH2-C） */}
      <MailboxPanel />

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

      {/* 能力演化治理策略（P4） */}
      <details className="rounded-lg border border-border/50 bg-foreground/[0.02] p-3">
        <summary className="cursor-pointer text-sm font-medium">能力演化治理策略</summary>
        <div className="mt-3"><EmployeeGovernancePanel /></div>
      </details>

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
                      {emp.executionProfile === 'development' && <span className="rounded-full bg-primary/10 px-2 text-[10px] text-primary">研发 · {emp.permissionMode === 'auto' ? '审批执行' : '只读诊断'}</span>}
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

                <div className="pl-11 flex gap-3"><button onClick={() => void loadExecutions(emp.id)} className="text-xs text-primary">刷新执行记录</button><button onClick={() => void loadCapabilities(emp.id)} className="text-xs text-primary">查看能力演化</button></div>
                {capabilityData[emp.id] && (() => { const capability = capabilityData[emp.id]!; return <details className="ml-11 rounded-md bg-primary/[0.03] p-3 text-xs"><summary className="cursor-pointer font-medium">能力版本与学习样本</summary><div className="mt-3 space-y-3"><div><p className="mb-1 text-foreground/55">能力版本</p>{capability.versions.length === 0 ? <p className="text-muted-foreground">尚无已激活能力版本。</p> : capability.versions.map((version) => <details key={version.id} className="rounded bg-background/70 p-2"><summary>v{version.versionNumber} · {version.scope} · {version.status} · {version.contentHash.slice(0, 12)}</summary>{(() => { const observation = capability.observations.find((item) => item.versionId === version.id); return <div className="mt-2 space-y-1 text-[11px] text-muted-foreground"><p>父版本：{version.parentVersionId?.slice(0, 12) ?? '基线'} · 激活：{version.activatedAt ? new Date(version.activatedAt).toLocaleString('zh-CN') : '—'}</p><p>冻结执行 {observation?.executionCount ?? 0} · 完成 {observation?.completedCount ?? 0} · 失败 {observation?.failedCount ?? 0} · 取消 {observation?.cancelledCount ?? 0}</p><p>验收样本 {observation?.acceptedSamples ?? 0} · 返工 {observation?.changesRequestedSamples ?? 0} · 已脱敏 {observation?.sanitizedSamples ?? 0} · 待审核 {observation?.pendingSamples ?? 0}</p>{(() => { const item = capability.health.find((entry) => entry.versionId === version.id); if (!item) return null; const percent = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(1)}%`; const alerts = capability.alerts.filter((alert) => alert.versionId === version.id); return <div className="space-y-1"><p className={item.sampleSufficient ? '' : 'text-amber-700 dark:text-amber-300'}>近 {item.windowDays} 天：返工率 {percent(item.reworkRate)} · 失败率 {percent(item.failureRate)} · 已判定样本 {item.decidedSampleCount}{item.sampleSufficient ? '' : '（样本量不足，暂不构成趋势结论）'}</p>{alerts.map((alert) => <p key={`${alert.versionId}-${alert.code}-${alert.message}`} className={alert.severity === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}>{alert.severity === 'warning' ? '⚠ ' : 'ⓘ '}{alert.message}（{alert.evidence}）</p>)}</div> })()}{version.status === 'active' && <button disabled={rollingBackVersionId === version.id} className="rounded px-2 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-50" onClick={() => void rollbackCapability(emp.id, version.id)}>回滚到{version.parentVersionId ? '父版本' : '基线'}</button>}</div> })()}<pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[11px]">{version.content || '（空基线）'}</pre></details>)}</div><div><p className="mb-1 text-foreground/55">学习样本</p>{capability.samples.length === 0 ? <p className="text-muted-foreground">暂无学习样本。</p> : capability.samples.map((sample) => <div key={sample.id} className="mb-2 rounded bg-background/70 p-2"><p><span className="font-medium">{sample.outcome}</span> · {sample.privacyStatus} · {new Date(sample.createdAt).toLocaleString('zh-CN')}</p><p className="mt-1 whitespace-pre-wrap break-words">{sample.evidenceSummary}</p>{sample.privacyStatus === 'pending' && <textarea className="mt-2 w-full rounded border bg-background p-2 text-[11px]" placeholder="人工审核后的脱敏摘要：删除路径、原始会话、敏感信息，只保留可评测结论" value={sampleDrafts[sample.id] ?? sample.evidenceSummary} onChange={(event) => { const value = event.target.value; setSampleDrafts((current) => ({ ...current, [sample.id]: value })); void scanSample(sample.id, value) }} />}{sample.privacyStatus === 'pending' && (sampleScans[sample.id]?.length ?? 0) > 0 && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">疑似敏感内容：{sampleScans[sample.id]!.map((item) => item.message).join('、')}（仅供人工确认）</p>}{sample.privacyStatus === 'pending' && <button disabled={reviewingSampleId === sample.id} className="mr-2 mt-2 rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground disabled:opacity-50" onClick={() => void reviewSample(emp.id, sample.id)}>标记可用于评测</button>}{sample.privacyStatus !== 'excluded' && <button disabled={reviewingSampleId === sample.id} className="mt-2 rounded px-2 py-1 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-50" onClick={() => void excludeSample(emp.id, sample.id)}>排除样本</button>}<p className="mt-1 text-[10px] text-muted-foreground">失败/取消样本不会自动被视为负向反馈，需人工判断。</p></div>)}</div></div></details> })()}
                {capabilityData[emp.id] && (() => {
                  const form = evaluationForm[emp.id] ?? { scope: 'role' as const, channelId: emp.channelId, modelId: emp.modelId ?? '', judgeChannelId: '', judgeModelId: '' }
                  const result = evaluationResult[emp.id]
                  const sanitizedCount = capabilityData[emp.id]!.samples.filter((sample) => sample.privacyStatus === 'sanitized').length
                  return <details className="ml-11 rounded-md bg-foreground/[0.02] p-3 text-xs"><summary className="cursor-pointer font-medium">受控评测并生成候选</summary><div className="mt-3 space-y-2"><p className="text-muted-foreground">已脱敏样本 {sanitizedCount} 条（至少 3 条，且需至少 1 条归入 held-out）。评测只产出待审批候选，不激活生产版本。</p><label className="block">能力范围<select className="mt-1 w-full rounded border bg-background p-2" value={form.scope} onChange={(event) => setEvaluationForm((current) => ({ ...current, [emp.id]: { ...form, scope: event.target.value as 'role' | 'workspace' } }))}><option value="role">角色级</option><option value="workspace">工作区级</option></select></label><label className="block">被测渠道<select className="mt-1 w-full rounded border bg-background p-2" value={form.channelId} onChange={(event) => setEvaluationForm((current) => ({ ...current, [emp.id]: { ...form, channelId: event.target.value, modelId: '' } }))}>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label><label className="block">被测模型（显式）<input className="mt-1 w-full rounded border bg-background p-2" value={form.modelId} onChange={(event) => setEvaluationForm((current) => ({ ...current, [emp.id]: { ...form, modelId: event.target.value } }))} placeholder="必须填写已启用的模型 id" /></label><label className="block">独立评判渠道（留空则视为不独立，仅出 baseline）<select className="mt-1 w-full rounded border bg-background p-2" value={form.judgeChannelId} onChange={(event) => setEvaluationForm((current) => ({ ...current, [emp.id]: { ...form, judgeChannelId: event.target.value, judgeModelId: '' } }))}><option value="">未配置</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>{form.judgeChannelId && <label className="block">评判模型（显式）<input className="mt-1 w-full rounded border bg-background p-2" value={form.judgeModelId} onChange={(event) => setEvaluationForm((current) => ({ ...current, [emp.id]: { ...form, judgeModelId: event.target.value } }))} placeholder="必须填写已启用的模型 id" /></label>}<p className="text-[11px] text-amber-700 dark:text-amber-300">评判者必须与被测渠道或模型不同源；否则不能生成可批准候选。评测会真实调用模型并产生费用。</p><button disabled={evaluatingAgentId === emp.id} className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50" onClick={() => void runCapabilityEvaluation(emp)}>{evaluatingAgentId === emp.id ? '评测中…' : '运行受控评测'}</button>{result && <div className="space-y-1 rounded bg-background p-2"><p>状态：{result.status} · 训练 {result.baselineScore.toFixed(1)} → {result.finalScore.toFixed(1)} · held-out {result.heldOutBaselineScore ?? '—'} → {result.heldOutFinalScore ?? '—'}</p><p>Judge：{result.judgeKind} · 独立：{result.judgeIndependent ? '是' : '否'} · 样本 {result.trainingSampleCount} 训练 / {result.heldOutSampleCount} held-out</p><p className="text-muted-foreground">{result.message}</p><p className="break-all text-[11px] text-muted-foreground">benchmark：{result.benchmarkId}{result.approvalId ? ` · 待审批：${result.approvalId}` : ''}</p></div>}</div></details>
                })()}

                {/* 执行记录概览 */}
                {execs.length > 0 ? (
                  <div className="pl-11 space-y-1">
                    {execs.map((exec) => {
                      const meta = EXEC_STATUS_META[exec.status] ?? { label: exec.status, className: 'bg-foreground/[0.06] text-foreground/60' }
                      return (
                        <details key={exec.id} className="rounded-md bg-muted/30 p-2 text-[11px] text-foreground/55">
                          <summary className="flex cursor-pointer items-center gap-2">
                          <span className={cn('shrink-0 px-1.5 py-[1px] rounded-full text-[10px]', meta.className)}>{meta.label}</span>
                          <span className="truncate flex-1">{exec.entityType === 'task' ? '任务' : '子任务'} · {exec.resultSummary?.slice(0, 60) ?? exec.error?.slice(0, 60) ?? '…'}</span>
                          <span className="shrink-0 text-foreground/30 tabular-nums">{new Date(exec.startedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                          </summary>
                          <p className="mt-2 whitespace-pre-wrap break-words">{exec.error}</p>
                          <p className="whitespace-pre-wrap break-words">{exec.resultSummary ?? '暂无交付结果'}</p>
                          {exec.outputFiles?.map((path) => <p key={path} className="mt-1 break-all font-mono">{path}</p>)}
                          {exec.sessionId && !exec.sessionId.startsWith('workflow:') && <button className="mt-2 text-primary" onClick={() => void openSession('agent', exec.sessionId, `${emp.name} · 任务执行`)}>打开执行会话 / 处理审批</button>}
                        </details>
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
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">{editingId ? '编辑 AI 员工' : '新建 AI 员工'}</h3>
            {!editingId && <button className="rounded-md bg-primary/10 px-3 py-1.5 text-xs text-primary" onClick={() => setForm((current) => ({ ...current, name: 'Gravitas 研发工程师', role: '软件开发与测试', description: '理解项目规则与现有架构，完成小范围开发、缺陷修复和回归测试，提交代码变更与验证证据供人工验收。', executionProfile: 'development', permissionMode: 'safe', workflowId: '' }))}>使用研发员工模板</button>}
          </div>
          <div className="rounded-lg bg-muted/40 p-3 space-y-3">
            <label className="block text-xs text-muted-foreground">执行配置
              <select value={form.executionProfile} onChange={(e) => setForm({ ...form, executionProfile: e.target.value as 'general' | 'development', workflowId: e.target.value === 'development' ? '' : form.workflowId })} className="mt-1 w-full rounded-md bg-background px-3 py-2 text-sm">
                <option value="general">普通员工（旧版全自动权限）</option>
                <option value="development">研发员工（隔离 worktree + 项目上下文）</option>
              </select>
            </label>
            <fieldset className="block text-xs text-muted-foreground">
              <legend>可用工作区（可多选）</legend>
              <div className="mt-1 max-h-36 space-y-1 overflow-y-auto rounded-md bg-background px-3 py-2">
                {workspaces.filter((space) => form.executionProfile !== 'development' || space.rootPath).map((space) => (
                  <label key={space.id} className="flex cursor-pointer items-start gap-2 py-1 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={form.workspaceIds.includes(space.id)}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        workspaceIds: event.target.checked
                          ? [...current.workspaceIds, space.id]
                          : current.workspaceIds.filter((workspaceId) => workspaceId !== space.id),
                      }))}
                    />
                    <span>{space.name}{space.rootPath ? ` · ${space.rootPath}` : ''}</span>
                  </label>
                ))}
                {workspaces.length === 0 && <p className="py-1 text-muted-foreground">暂无可用工作区</p>}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed">{form.executionProfile === 'development' ? '研发员工至少选择一个本地 Git 工作区。若选择多个，指派任务时必须明确选择其中一个。' : '角色可跨所选工作区服务；未绑定时沿用任务或全局工作区。'}</p>
            </fieldset>
            {form.executionProfile === 'development' && <>
              <label className="block text-xs text-muted-foreground">Runtime 权限
                <select value={form.permissionMode} onChange={(e) => setForm({ ...form, permissionMode: e.target.value as 'safe' | 'auto' })} className="mt-1 w-full rounded-md bg-background px-3 py-2 text-sm">
                  <option value="safe">只读诊断（默认，不修改代码）</option>
                  <option value="auto">审批执行（允许常规编辑，命令可能需要确认）</option>
                </select>
              </label>
              <p className="text-xs leading-relaxed text-muted-foreground">从干净仓库 HEAD 建立独立分支，不自动提交、合并或发布。先读取项目规则，复用当前工作区 Skills、MCP 与项目知识范围。worktree 不是系统沙箱；审批执行不代表所有操作免审批。成果暂停待人工验收，未真实验证的 Runtime 不保证无人值守可用。</p>
            </>}
          </div>
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
                onChange={(e) => { setForm({ ...form, channelId: e.target.value, modelId: '' }) }}
                className="w-full px-3 py-2 text-sm border rounded-md bg-background"
              >
                {channels.length === 0 && <option value="">无可用渠道</option>}
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.provider}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">模型</label>
              <input
                list="agent-employee-models"
                type="text"
                placeholder="从渠道拉取或手动输入"
                value={form.modelId}
                onChange={(e) => setForm({ ...form, modelId: e.target.value })}
                className="w-full px-3 py-2 text-sm border rounded-md bg-background"
              />
              <datalist id="agent-employee-models">
                {channels
                  .find((c) => c.id === form.channelId)
                  ?.models?.map((m) => <option key={m.id} value={m.id} />)}
              </datalist>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">绑定 Workflow SOP（可选）</label>
              <select
                value={form.workflowId}
                disabled={form.executionProfile === 'development'}
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
            <button onClick={() => void handleSave()} disabled={saving || !form.name.trim() || !form.channelId || (form.executionProfile === 'development' && (form.workspaceIds.length === 0 || !form.modelId.trim()))} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md disabled:opacity-50">
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
