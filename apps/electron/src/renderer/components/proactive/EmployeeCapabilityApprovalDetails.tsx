import * as React from 'react'
import type { ProactiveApproval } from '@gravitas/shared'

interface CapabilityChange {
  type: 'employee_capability_adopt'
  agentId: string
  scope: 'role' | 'workspace'
  workspaceId?: string
  parentVersionId?: string
  versionNumber: number
  content: string
  contentHash: string
  trainingScore?: number
  heldOutScore?: number
  evidenceSampleIds?: string[]
  judgeKind?: 'rule' | 'llm' | 'injected'
  judgeIndependent?: boolean
  nonEvolvableConstraints?: string[]
}

function parseCapabilityChange(approval: ProactiveApproval): CapabilityChange | null {
  const value = approval.proposedChange
  if (approval.sourceType !== 'employee_capability' || !value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (item.type !== 'employee_capability_adopt' || typeof item.agentId !== 'string' || (item.scope !== 'role' && item.scope !== 'workspace') || typeof item.versionNumber !== 'number' || typeof item.content !== 'string' || typeof item.contentHash !== 'string') return null
  return {
    type: 'employee_capability_adopt', agentId: item.agentId, scope: item.scope, workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : undefined,
    parentVersionId: typeof item.parentVersionId === 'string' ? item.parentVersionId : undefined, versionNumber: item.versionNumber, content: item.content, contentHash: item.contentHash,
    trainingScore: typeof item.trainingScore === 'number' ? item.trainingScore : undefined, heldOutScore: typeof item.heldOutScore === 'number' ? item.heldOutScore : undefined,
    evidenceSampleIds: Array.isArray(item.evidenceSampleIds) ? item.evidenceSampleIds.filter((id): id is string => typeof id === 'string') : [],
    judgeKind: item.judgeKind === 'rule' || item.judgeKind === 'llm' || item.judgeKind === 'injected' ? item.judgeKind : undefined,
    judgeIndependent: typeof item.judgeIndependent === 'boolean' ? item.judgeIndependent : undefined,
    nonEvolvableConstraints: Array.isArray(item.nonEvolvableConstraints) ? item.nonEvolvableConstraints.filter((entry): entry is string => typeof entry === 'string') : [],
  }
}

export function EmployeeCapabilityApprovalDetails({ approval }: { approval: ProactiveApproval }): React.ReactElement | null {
  const change = parseCapabilityChange(approval)
  if (!change) return null
  return <details className="mt-2 rounded-md border border-primary/20 bg-primary/[0.03] p-2 text-[11px]"><summary className="cursor-pointer font-medium text-primary">查看 AI 员工能力候选</summary><dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground"><dt>范围</dt><dd>{change.scope === 'role' ? '角色级（跨工作区）' : `工作区级 · ${change.workspaceId ?? '未指定'}`}</dd><dt>版本</dt><dd>{change.parentVersionId ? `${change.parentVersionId.slice(0, 12)} → ` : '基线 → '}v{change.versionNumber}</dd><dt>训练 / held-out</dt><dd>{change.trainingScore?.toFixed(1) ?? '—'} / {change.heldOutScore?.toFixed(1) ?? '—'}</dd><dt>已脱敏样本</dt><dd>{change.evidenceSampleIds?.length ?? 0} 条</dd><dt>内容 hash</dt><dd className="break-all font-mono">{change.contentHash}</dd><dt>评判者</dt><dd>{change.judgeKind ?? '未记录'} · 独立性：{change.judgeIndependent === undefined ? '未记录' : change.judgeIndependent ? '独立' : '不独立'}</dd></dl>{change.judgeIndependent === false && <p className="mt-2 text-amber-700 dark:text-amber-300">评判者与被评方未解耦，存在自我确认风险，本候选不应直接批准。</p>}{change.nonEvolvableConstraints && change.nonEvolvableConstraints.length > 0 && <details className="mt-2"><summary className="cursor-pointer font-medium">不可演化约束（候选不得绕过）</summary><ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">{change.nonEvolvableConstraints.map((item) => <li key={item}>{item}</li>)}</ul></details>}<p className="mt-2 text-amber-700 dark:text-amber-300">held-out 已作为后端推广门禁。批准后会激活此版本，影响后续任务；已冻结的历史执行不会改变。</p><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-sans text-foreground">{change.content}</pre></details>
}
