import type { OwnerPlanningLink, ProjectOwnerPlanDraft, ProjectOwnerRunView } from '@gravitas/shared'

interface LatestOwnerRunCurrentInput {
  link: Pick<OwnerPlanningLink, 'goalRevision' | 'planRevision' | 'bindingRevision' | 'contextFingerprint'>
  executionId?: string
  outcome?: Pick<ProjectOwnerRunView['outcomes'][number], 'state' | 'receiptId' | 'planRevision'>
  goalRevision?: number
  plan?: Pick<ProjectOwnerPlanDraft, 'revision' | 'state' | 'origin' | 'sourceRun' | 'contextFingerprint' | 'goalRevision'> | null
  bindingRevision?: number
  contextFingerprint?: string
}

export function isLatestOwnerRunCurrent(input: LatestOwnerRunCurrentInput): boolean {
  const { link, executionId, outcome, goalRevision, plan, bindingRevision, contextFingerprint } = input
  if (goalRevision !== link.goalRevision || bindingRevision !== link.bindingRevision || contextFingerprint !== link.contextFingerprint) return false
  const proposalFromThisRun = outcome?.state === 'proposed'
    && executionId !== undefined
    && outcome.planRevision !== undefined
    && plan?.origin === 'generated'
    && plan.state !== 'stale'
    && plan.sourceRun?.executionId === executionId
    && plan.sourceRun.receiptId === outcome.receiptId
    && plan.goalRevision === link.goalRevision
    && plan.contextFingerprint === link.contextFingerprint
    && plan.revision >= outcome.planRevision
  return (plan?.revision ?? 0) === link.planRevision || proposalFromThisRun
}

export const outcomeLabels = {
  replied: 'Owner已回应',
  proposed: '已生成待审提案',
  needs_clarification: '需要补充信息',
  stale: '来源已变化，需重新核对',
  failed: '规划失败，未补发',
  unknown: '终态未知，未补发',
  stopped: '已请求停止，费用仍需核对',
} as const
export const executionLabels = {
  queued: '已排队，尚不代表模型已发送',
  running: '正在处理',
  completed: '已完成，内容仍需审阅',
  failed: '执行失败',
  cancelled: '已取消',
  stale: '状态未知，已暂停',
} as const

export function planLabel(state: string | undefined): string {
  if (state === 'proposed') return '待审阅'
  if (state === 'confirmed') return '已确认内容'
  if (state === 'stale') return '来源变化，需重新审阅'
  return '尚无计划提案'
}

export interface OwnerHomeRunInput {
  link: LatestOwnerRunCurrentInput['link']
  executions: ReadonlyArray<Pick<ProjectOwnerRunView['executions'][number], 'id' | 'status'>>
  outcomes: ReadonlyArray<Pick<ProjectOwnerRunView['outcomes'][number], 'executionId' | 'state' | 'receiptId' | 'planRevision'>>
  receipts: ReadonlyArray<Pick<ProjectOwnerRunView['receipts'][number], 'executionId' | 'cost'>>
}

export interface OwnerHomeStatusInput {
  goal: { snapshot: { revision: number } | null; conflict: boolean; requiresReview: boolean }
  runtime: {
    loading: boolean
    binding: { revision: number } | null
    context: { fingerprint: string } | null
    runs: ReadonlyArray<OwnerHomeRunInput>
  }
  plan: { snapshot: Pick<ProjectOwnerPlanDraft, 'revision' | 'state' | 'origin' | 'sourceRun' | 'contextFingerprint' | 'goalRevision'> | null }
}

export interface OwnerHomeStatus {
  /** 项目主页头部阶段标签 */
  stage: string
  /** 下一步动作 */
  nextAction: string
  /** 下一步说明 */
  nextDetail: string
  /** Run 终态异常（失败/未知/停止）需先核对；费用 unknown 不在此列 */
  needsReconciliation: boolean
  /** 费用仍为 unknown，仅作账单核对提示，不构成阻断 */
  costUnknown: boolean
  /** 最近一条 Run 与当前目标/计划/配置来源一致 */
  runCurrent: boolean
}

/** 主页阶段投影：费用 unknown 只提示账单核对，不冒充“上次规划需核对”。 */
export function deriveOwnerHomeStatus(input: OwnerHomeStatusInput): OwnerHomeStatus {
  const { goal, runtime, plan } = input
  const latestRun = runtime.runs[0] ?? null
  const latestExecution = latestRun?.executions[0]
  const latestOutcome = latestExecution
    ? latestRun?.outcomes.find(outcome => outcome.executionId === latestExecution.id)
    : undefined
  const latestReceipt = latestExecution
    ? latestRun?.receipts.find(receipt => receipt.executionId === latestExecution.id)
    : undefined
  const runCurrent = Boolean(latestRun && !runtime.loading && runtime.context && runtime.binding
    && isLatestOwnerRunCurrent({ link: latestRun.link, executionId: latestExecution?.id, outcome: latestOutcome,
      goalRevision: goal.snapshot?.revision, plan: plan.snapshot, bindingRevision: runtime.binding.revision,
      contextFingerprint: runtime.context.fingerprint }))
  const needsReconciliation = latestOutcome?.state === 'unknown' || latestOutcome?.state === 'failed'
    || latestOutcome?.state === 'stopped'
  const costUnknown = latestReceipt?.cost.source === 'unknown'
  const stage = !goal.snapshot ? '目标待保存'
    : !runtime.binding ? '规划配置待确认'
    : needsReconciliation ? '上次规划需核对'
    : latestRun && !runCurrent ? '历史规划来源已变化'
    : plan.snapshot?.state === 'confirmed' && runCurrent ? '计划内容已确认'
    : latestOutcome ? outcomeLabels[latestOutcome.state]
    : latestExecution ? executionLabels[latestExecution.status]
    : latestRun ? '规划准备已就绪'
    : plan.snapshot ? planLabel(plan.snapshot.state)
    : '规划提案待准备'
  const nextAction = !goal.snapshot ? '先记录项目目标'
    : goal.conflict || goal.requiresReview ? '比较最新目标版本'
    : !runtime.binding ? '确认 Owner 规划配置'
    : needsReconciliation ? '先核对上次规划请求'
    : latestRun && !runCurrent ? '核对规划来源是否仍匹配'
    : plan.snapshot?.state === 'proposed' ? '审阅规划提案'
    : plan.snapshot?.state === 'stale' ? '检查已变化的计划来源'
    : !plan.snapshot ? latestRun ? '确认本次规划范围与费用' : '准备一次目标规划'
    : '检查已确认计划，再准备执行授权'
  const nextDetail = !goal.snapshot
    ? '保存目标草案只记录本地内容，不会调用模型、扣费或派发任务。'
    : needsReconciliation
      ? '上次请求的费用或终态仍需核对；系统不自动重试，也不会把未知费用当作零。'
      : !runtime.binding
        ? '绑定仅复用已配置的 AI SDK 员工和双方授权的工作区；不会自动创建员工。'
        : latestRun && !runCurrent
          ? '最近一条规划记录与当前目标、计划或配置来源不一致；先核对新旧来源，不把旧提案当作当前计划。'
        : plan.snapshot?.state === 'proposed'
          ? '提案是待审阅的工作方案，不是已经创建的任务或实际员工分配。'
          : costUnknown
            ? '本次规划费用尚未取得服务商账单，请在对账时核对；这不影响计划内容审阅与后续执行准备。'
            : '配置、准备与审阅均不等于执行授权；每个后续动作仍有独立门禁。'
  return { stage, nextAction, nextDetail, needsReconciliation, costUnknown, runCurrent }
}
