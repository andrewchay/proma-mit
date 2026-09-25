/**
 * TaskReviewPanel — 研发任务统一 Review（M2 / W05）
 *
 * 单一页面展示：执行记录、冻结快照文件清单（复用 DiffView 展示冻结内容而非
 * live worktree）、交付版本历史、验证状态与逐项 DoD。
 * 操作：验收通过（证据必填）、退回（原因必填）、返工（意见驱动幂等派发）。
 * 本机操作人为 local-user；登记的其他人类验收人需对应身份操作，面板会明确提示。
 */
import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import type { DevelopmentApplyStatusInfo, DevelopmentValidationResult, TaskReviewSummary } from '@gravitas/shared'
import { DiffView } from '@/components/diff/DiffView'
import { activeViewAtom } from '@/atoms/active-view'
import { appModeAtom } from '@/atoms/app-mode'
import { agentSessionsAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { activeTabIdAtom, openTab, tabsAtom } from '@/atoms/tab-atoms'

type AgentApi = {
  getTaskReview: (taskId: string) => Promise<TaskReviewSummary>
  getSnapshotDiff: (executionId: string, filePath: string) => Promise<{ oldContent: string | null; newContent: string | null }>
  acceptDelivery: (taskId: string, deliveryId: string, input: { evidence: string; completedCriteria?: string[] }) => Promise<unknown>
  rejectDelivery: (taskId: string, deliveryId: string, comment: string) => Promise<unknown>
  requestChanges: (taskId: string, comment: string) => Promise<{ taskId: string } | null>
  runValidation: (taskId: string, command: string) => Promise<DevelopmentValidationResult>
  listValidations: (taskId: string) => Promise<DevelopmentValidationResult[]>
  prepareApply: (taskId: string) => Promise<{ operationId: string; files: Array<{ path: string; changeType: string }>; expiresAt: number }>
  confirmApply: (operationId: string) => Promise<{ status: string; taskCompleted: boolean; taskError?: string }>
  getApplyStatus: (taskId: string) => Promise<DevelopmentApplyStatusInfo>
}

function agentApi(): AgentApi {
  const api = (window as unknown as { electronAPI?: { paa?: { agentEmployees?: AgentApi } } }).electronAPI?.paa?.agentEmployees
  if (!api) throw new Error('Agent Employee API 未初始化')
  return api
}

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', stale: '已失效',
}
const DELIVERY_STATUS_LABELS: Record<string, { label: string; className: string }> = {
  draft: { label: '草稿', className: 'bg-muted text-muted-foreground' },
  submitted: { label: '待验收', className: 'bg-amber-500/10 text-amber-600' },
  accepted: { label: '已验收', className: 'bg-green-500/10 text-green-600' },
  changes_requested: { label: '已退回', className: 'bg-red-500/10 text-red-600' },
  needs_review: { label: '需复核', className: 'bg-amber-500/10 text-amber-600' },
}

export function TaskReviewPanel({ taskId }: { taskId: string }): React.ReactElement {
  const [summary, setSummary] = React.useState<TaskReviewSummary | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [selectedExecutionId, setSelectedExecutionId] = React.useState<string | null>(null)
  const [selectedFile, setSelectedFile] = React.useState<string | null>(null)
  const [diff, setDiff] = React.useState<{ oldContent: string | null; newContent: string | null } | null>(null)
  const [viewMode, setViewMode] = React.useState<'split' | 'unified'>('unified')
  const [evidence, setEvidence] = React.useState('')
  const [comment, setComment] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [validations, setValidations] = React.useState<DevelopmentValidationResult[]>([])
  const [applyStatus, setApplyStatus] = React.useState<DevelopmentApplyStatusInfo | null>(null)
  const [applyManifest, setApplyManifest] = React.useState<{ operationId: string; files: Array<{ path: string; changeType: string }> } | null>(null)
  const store = useStore()

  /** 打开某次执行的 Agent 会话（实时输出或历史上下文/审批） */
  const openSession = React.useCallback(async (sessionId: string): Promise<void> => {
    if (sessionId.startsWith('workflow:')) return
    const sessions = await window.electronAPI.listAgentSessions()
    const session = sessions.find((item) => item.id === sessionId)
    if (!session) throw new Error('该 Agent 会话暂不可用')
    store.set(agentSessionsAtom, sessions)
    const result = openTab(store.get(tabsAtom), { type: 'agent', sessionId, title: session.title })
    store.set(tabsAtom, result.tabs)
    store.set(activeTabIdAtom, result.activeTabId)
    store.set(currentAgentSessionIdAtom, sessionId)
    store.set(appModeAtom, 'agent')
    store.set(activeViewAtom, 'conversations')
  }, [store])

  const load = React.useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const api = await agentApi()
      const result = await api.getTaskReview(taskId) as TaskReviewSummary
      setSummary(result)
      setValidations(await api.listValidations(taskId))
      setApplyStatus(await api.getApplyStatus(taskId))
      const latestSnapshot = result.snapshots[0]
      setSelectedExecutionId((current) => current ?? latestSnapshot?.executionId ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [taskId])

  React.useEffect(() => { void load() }, [load])

  const activeSnapshot = summary?.snapshots.find((item) => item.executionId === selectedExecutionId) ?? summary?.snapshots[0]

  const openDiff = async (filePath: string): Promise<void> => {
    if (!activeSnapshot) return
    setSelectedFile(filePath); setDiff(null); setError(null)
    try {
      const api = await agentApi()
      const result = await api.getSnapshotDiff(activeSnapshot.executionId, filePath) as { oldContent: string | null; newContent: string | null }
      setDiff({ oldContent: result.oldContent, newContent: result.newContent })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError(null)
    try {
      await action()
      setEvidence(''); setComment('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!summary && loading) return <p className="text-xs text-muted-foreground">加载 Review…</p>
  if (!summary) return <p className="text-xs text-muted-foreground">{error ?? '暂无 Review 数据。'}</p>
  if (!summary.scope) return <p className="text-xs text-muted-foreground">该任务未配置研发执行范围，走普通任务链路。</p>

  const latestDelivery = summary.deliveries[0]
  const isLocalReviewer = latestDelivery?.responsibilities?.reviewerId !== undefined
    ? latestDelivery.responsibilities.reviewerId === 'local-user'
    : summary.reviewerId === 'local-user'
  const canAccept = latestDelivery?.status === 'submitted' && isLocalReviewer
  const latestExecution = summary.executions[0]

  return (
    <div className="space-y-3" data-testid="task-review-panel">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">研发 Review</div>
        <button className="rounded border px-2 py-0.5 text-xs text-muted-foreground" disabled={loading} onClick={() => void load()}>刷新</button>
      </div>

      <div className="rounded-lg bg-muted/50 p-2 text-xs space-y-1">
        <p>范围：<span className="font-mono">{summary.scope.targetPaths.join('、')}</span>（允许：{summary.scope.allowedPaths.join('、')}）</p>
        <p>验收人：{isLocalReviewer ? 'local-user（本机）' : `${summary.reviewerId}（本机不能代为验收）`}</p>
        {summary.scope.verificationCommands?.length ? <p>验证命令：<span className="font-mono">{summary.scope.verificationCommands.join('；')}</span></p> : null}
        {latestExecution?.resultSummary ? <p className="whitespace-pre-wrap break-words">结果摘要：{latestExecution.resultSummary.slice(0, 400)}</p> : null}
      </div>

      {/* 交付版本 */}
      {summary.deliveries.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium">交付版本</div>
          {summary.deliveries.map((delivery) => {
            const badge = DELIVERY_STATUS_LABELS[delivery.status] ?? { label: delivery.status, className: 'bg-muted text-muted-foreground' }
            return (
              <div key={`${delivery.id}:${delivery.version}`} className="rounded-lg bg-muted/40 p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${badge.className}`}>{badge.label}</span>
                  <span>v{delivery.version}</span>
                  <span className="text-muted-foreground">{new Date(delivery.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{delivery.content.slice(0, 300)}</p>
                {delivery.dodCheckResults?.length ? (
                  <ul className="mt-1 list-disc pl-4">
                    {delivery.dodCheckResults.map((result) => (
                      <li key={result.criterion}>{result.status === 'passed' ? '✓' : '✗'} {result.criterion}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {/* 冻结快照文件 */}
      {activeSnapshot ? (
        <div className="space-y-1">
          <div className="text-xs font-medium">变更文件（冻结快照 {activeSnapshot.executionId.slice(0, 8)}…，基线 {activeSnapshot.baseCommit.slice(0, 7)}）</div>
          <div className="flex flex-wrap gap-1">
            {activeSnapshot.files.map((file) => (
              <button
                key={file.path}
                className={`rounded px-2 py-0.5 font-mono text-[11px] ${selectedFile === file.path ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-accent'}`}
                onClick={() => void openDiff(file.path)}
              >
                {file.changeType === 'add' ? '+ ' : file.changeType === 'delete' ? '− ' : '~ '}{file.path}
              </button>
            ))}
          </div>
          {selectedFile && (
            <div>
              <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                <button className={viewMode === 'unified' ? 'font-medium text-foreground' : ''} onClick={() => setViewMode('unified')}>单栏</button>
                <button className={viewMode === 'split' ? 'font-medium text-foreground' : ''} onClick={() => setViewMode('split')}>双栏</button>
                <span>审阅的是冻结内容，不含快照之后的工作目录变化</span>
              </div>
              {diff ? (
                <div className="max-h-80 overflow-y-auto rounded-lg border p-1">
                  <DiffView oldContent={diff.oldContent ?? ''} newContent={diff.newContent ?? ''} filePath={selectedFile} viewMode={viewMode} />
                </div>
              ) : <p className="text-[11px] text-muted-foreground">加载差异…</p>}
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">暂无冻结快照（执行完成并交付后在此显示差异）。</p>
      )}

      {/* 操作区 */}
      <div className="space-y-2 rounded-lg border p-2">
        <textarea
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          rows={2}
          placeholder={canAccept ? '验收依据（通过时必填）：测试记录、核对记录或定位引用' : '验收意见'}
          disabled={busy || !latestDelivery || latestDelivery.status !== 'submitted'}
          className="w-full rounded-md bg-background p-2 text-xs"
        />
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded bg-green-600 px-3 py-1 text-xs text-white disabled:opacity-50"
            disabled={busy || !canAccept || !evidence.trim()}
            onClick={() => void act(async () => { const api = agentApi(); await api.acceptDelivery(taskId, latestDelivery!.id, { evidence: evidence.trim() }) })}
          >验收通过</button>
          <button
            className="rounded bg-destructive px-3 py-1 text-xs text-white disabled:opacity-50"
            disabled={busy || !latestDelivery || latestDelivery.status !== 'submitted' || !isLocalReviewer || !evidence.trim()}
            onClick={() => void act(async () => { const api = agentApi(); await api.rejectDelivery(taskId, latestDelivery!.id, evidence.trim()) })}
          >退回（以验收依据为退回原因）</button>
          <button
            className="rounded border px-3 py-1 text-xs disabled:opacity-50"
            disabled={busy || !comment.trim()}
            onClick={() => void act(async () => { const api = agentApi(); await api.requestChanges(taskId, comment.trim()) })}
          >返工</button>
        </div>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          placeholder="返工意见（会写回任务并沿用原会话/工作目录继续修改）"
          disabled={busy}
          className="w-full rounded-md bg-background p-2 text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          执行完成 ≠ 业务验收；测试结果由员工报告，需核验。验收通过后文件仍在独立工作目录，应用回原仓库为后续阶段。
        </p>
      </div>

      {/* 验证证据 */}
      {summary.scope.verificationCommands?.length ? (
        <div className="space-y-1 rounded-lg bg-muted/40 p-2 text-xs">
          <div className="font-medium">验证证据（真实退出码，与模型自述无关）</div>
          {validations.length === 0 ? <p className="text-muted-foreground">尚未运行验证。</p> : validations.slice(0, 5).map((validation) => (
            <div key={validation.id} className="flex items-center gap-2">
              <span className={
                validation.status === 'passed' ? 'text-green-600'
                : validation.status === 'stale' ? 'text-amber-600'
                : 'text-destructive'
              }>{validation.status === 'passed' ? '✓ passed' : validation.status === 'stale' ? '⚠ stale' : `✗ ${validation.status}`}</span>
              <span className="font-mono">{validation.command}</span>
              <span className="text-muted-foreground">exit={validation.exitCode ?? '—'} · {new Date(validation.finishedAt).toLocaleTimeString()}</span>
            </div>
          ))}
          <div className="flex flex-wrap gap-1 pt-1">
            {summary.scope.verificationCommands.map((command) => (
              <button
                key={command}
                className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] hover:bg-accent disabled:opacity-50"
                disabled={busy}
                onClick={() => void act(async () => { const api = await agentApi(); await api.runValidation(taskId, command) })}
              >▶ {command}</button>
            ))}
          </div>
        </div>
      ) : null}

      {/* 确认应用（验收通过后可用） */}
      {latestDelivery?.status === 'accepted' ? (
        <div className="space-y-1 rounded-lg border p-2 text-xs">
          <div className="font-medium">应用到原仓库</div>
          {applyStatus?.latest?.status === 'recovery_required' ? (
            <div className="text-destructive">
              上次应用中断且文件状态混合，需人工恢复：
              <ul className="mt-1 list-disc pl-4">
                {(applyStatus.recoveryFiles ?? []).map((item) => <li key={item.path} className="font-mono">{item.path} — {item.issue}</li>)}
              </ul>
            </div>
          ) : applyManifest ? (
            <div className="space-y-1">
              <p>将写入 {applyManifest.files.length} 个文件到原仓库（保留为未提交改动，无自动 commit）：</p>
              <p className="font-mono text-muted-foreground">{applyManifest.files.map((f) => `${f.changeType === 'add' ? '+' : f.changeType === 'delete' ? '−' : '~'} ${f.path}`).join('；')}</p>
              <div className="flex gap-2">
                <button className="rounded bg-primary px-2 py-1 text-white disabled:opacity-50" disabled={busy}
                  onClick={() => void act(async () => { const api = await agentApi(); const result = await api.confirmApply(applyManifest.operationId); setApplyManifest(null); setApplyStatus(await api.getApplyStatus(taskId)); if (!result.taskCompleted) setError('文件已应用，但任务完成被 DoD 闸门阻止：' + (result.taskError ?? '需逐项验收')) })}
                >确认写入</button>
                <button className="rounded border px-2 py-1" onClick={() => setApplyManifest(null)}>取消</button>
              </div>
            </div>
          ) : applyStatus?.latest?.status === 'applied' ? (
            <p className="text-green-600">已应用到原仓库（未提交改动）。任务完成状态：{applyStatus.taskCompleted ? '已完成' : '未完成（走 DoD 闸门）'}。</p>
          ) : applyStatus?.latest?.status === 'blocked' ? (
            <p className="text-amber-600">上次确认未通过：{applyStatus.latest.error ?? '仓库状态已变化'}。请重新预检。</p>
          ) : (
            <div className="space-y-1">
              <p className="text-muted-foreground">预检通过后需二次确认；源仓库 HEAD 必须仍在交付基线上且目录干净。</p>
              <button className="rounded border px-2 py-1 disabled:opacity-50" disabled={busy}
                onClick={() => void act(async () => { const api = await agentApi(); setApplyManifest(await api.prepareApply(taskId)) })}
              >预检并准备应用</button>
            </div>
          )}
        </div>
      ) : null}

      {/* 执行记录 */}
      {summary.executions.length > 0 && (
        <details className="rounded-lg bg-muted/40 p-2 text-xs">
          <summary className="cursor-pointer">执行记录（{summary.executions.length}）</summary>
          {summary.executions.map((execution) => (
            <div key={execution.id} className="mt-1 border-t pt-1 first:border-t-0">
              <span>{STATUS_LABELS[execution.status] ?? execution.status}</span> · {new Date(execution.startedAt).toLocaleString()}
              {!execution.sessionId.startsWith('workflow:') && (
                <button
                  className="ml-2 text-primary hover:underline"
                  onClick={() => void openSession(execution.sessionId).catch((err) => setError(String(err)))}
                >
                  {execution.status === 'running' ? '查看实时输出' : '查看执行会话'}
                </button>
              )}
              {execution.error ? <p className="text-destructive">{execution.error}</p> : null}
            </div>
          ))}
        </details>
      )}

      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
    </div>
  )
}
