import * as React from 'react'
import { LoaderCircle, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { ProactiveApproval, ProactiveRecommendation } from '@gravitas/shared'

interface CapabilityEvaluationAction {
  type: 'run_employee_capability_evaluation'
  agentId: string
  scope: 'role' | 'workspace'
  workspaceId?: string
}

function parseAction(recommendation: ProactiveRecommendation): CapabilityEvaluationAction | null {
  if (!recommendation.scope.startsWith('employee-capability:')) return null
  const action = recommendation.action
  if (typeof action !== 'object' || action === null) return null
  const value = action as Record<string, unknown>
  if (value.type !== 'run_employee_capability_evaluation' || typeof value.agentId !== 'string' || (value.scope !== 'role' && value.scope !== 'workspace')) return null
  return { type: 'run_employee_capability_evaluation', agentId: value.agentId, scope: value.scope, workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : undefined }
}

/**
 * 员工能力评测建议卡。
 *
 * 建议本身不运行模型：只有用户点击并确认后才调用受控评测，评测结果也只会生成待审批候选。
 */
export function EmployeeCapabilityRecommendationCard({ recommendation, channelId, modelId, judgeChannelId, judgeModelId, onResolved }: {
  recommendation: ProactiveRecommendation
  channelId: string
  modelId: string
  judgeChannelId: string
  judgeModelId?: string
  onResolved: (updated: ProactiveRecommendation | null) => void
}): React.ReactElement | null {
  const [running, setRunning] = React.useState(false)
  const [result, setResult] = React.useState<{ approvalId?: string; status: string; message: string } | null>(null)
  const action = parseAction(recommendation)
  if (!action) return null

  const start = async (): Promise<void> => {
    if (!modelId.trim()) { toast.error('请先显式填写本次评测使用的模型'); return }
    if (!confirm('本次评测会真实调用模型并产生费用；结果只生成待审批候选，不会激活生产版本。确认开始？')) return
    setRunning(true)
    try {
      const evaluation = await window.electronAPI.paa.agentEmployees.runCapabilityEvaluation({
        agentId: action.agentId,
        scope: action.scope,
        workspaceId: action.workspaceId,
        channelId,
        modelId: modelId.trim(),
        judgeChannelId: judgeChannelId.trim() || undefined,
        judgeModelId: judgeModelId?.trim() || undefined,
      })
      setResult({ approvalId: evaluation.approvalId, status: evaluation.status, message: evaluation.message })
      if (evaluation.approvalId) {
        const updated = await window.electronAPI.proactive?.acceptRecommendation?.(recommendation.id)
        onResolved(updated ?? null)
        toast.success('评测完成并已创建待审批候选')
      } else {
        toast.message(`评测完成：${evaluation.status}`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '受控评测失败')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/[0.04] p-3">
      <p className="flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4 text-primary" />{recommendation.title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{recommendation.reason}</p>
      <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">{recommendation.evidence.map((item) => <li key={`${item.label}-${item.detail}`}>{item.label}：{item.detail}</li>)}</ul>
      <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">本建议只表示“值得人工触发一次评测”；评测通过后仍需在审批页确认，不会自动改变生产版本。</p>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" className="h-7 text-xs" disabled={running} onClick={() => void start()}>{running ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}开始受控评测</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={running} onClick={() => onResolved(null)}>暂不处理</Button>
      </div>
      {result && <p className="mt-2 text-[11px] text-muted-foreground">{result.status} · {result.message}{result.approvalId ? ` · 待审批 ${result.approvalId}` : ''}</p>}
    </div>
  )
}

/** 供审批页复用：判断某审批是否来自员工能力候选。 */
export function isEmployeeCapabilityApproval(approval: ProactiveApproval): boolean {
  return approval.sourceType === 'employee_capability'
}
