export type OwnerPlanningOutcomeState = 'proposed' | 'needs_clarification' | 'stale' | 'failed' | 'unknown' | 'stopped'
export type OwnerPlanningExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale'
export interface OwnerPlanningFlowInput {
  goal: { exists: boolean; dirty: boolean; requiresReview: boolean; conflict: boolean }
  binding: { exists: boolean; available: boolean }
  plan: { state: 'none' | 'proposed' | 'confirmed' | 'stale'; dirty: boolean; requiresReview: boolean; conflict: boolean }
  prepared: boolean
  executionStatus: OwnerPlanningExecutionStatus | null
  outcomeState: OwnerPlanningOutcomeState | null
}
export type OwnerPlanningStage = 'resolve_goal' | 'save_goal' | 'configure_binding' | 'review_plan' | 'waiting' | 'inspect' | 'answer_clarification' | 'review_proposal' | 'complete' | 'confirm_cost' | 'prepare'
export interface OwnerPlanningNextStep {
  stage: OwnerPlanningStage
  title: string
  detail: string
}
export interface OwnerClarificationFollowUpInput {
  goal: { revision: number; goalVersion: number; constraints: readonly string[] }
  clarification: { goalRevision: number; goalVersion: number; planRevision: number; bindingRevision: number; questions: readonly { question: string }[] }
  planRevision: number
  bindingRevision: number
  context: { goalRevision: number; fingerprint: string } | null
  runs: readonly { goalRevision: number; contextFingerprint: string }[]
}

/** 仅在完整答复已随新目标保存、来源未漂移且尚无新准备时继续无费准备。 */
export function shouldPrepareOwnerClarificationFollowUp(input: OwnerClarificationFollowUpInput): boolean {
  const { goal, clarification, context } = input
  if (goal.revision !== clarification.goalRevision + 1 || goal.goalVersion !== clarification.goalVersion + 1
    || input.planRevision !== clarification.planRevision || input.bindingRevision !== clarification.bindingRevision
    || !context || context.goalRevision !== goal.revision || !context.fingerprint
    || input.runs.some(run => run.goalRevision === goal.revision && run.contextFingerprint === context.fingerprint)
    || clarification.questions.length === 0) return false
  return clarification.questions.every(({ question }) => {
    if (!question.trim()) return false
    const prefix = `Owner澄清答复（${question.trim()}）：`
    return goal.constraints.some(constraint => constraint.startsWith(prefix) && constraint.slice(prefix.length).trim().length > 0)
  })
}
const steps: Record<OwnerPlanningStage, OwnerPlanningNextStep> = {
  resolve_goal: { stage: 'resolve_goal', title: '比较最新目标版本', detail: '目标存在版本冲突；先加载并比较最新版本，不覆盖或自动重试。' },
  save_goal: { stage: 'save_goal', title: '先保存目标草案', detail: '未保存目标不会作为规划输入；保存只写本地草案，不会调用模型或收费。' },
  configure_binding: { stage: 'configure_binding', title: '明确Owner规划载体', detail: '选择已启用的受控AI SDK载体及共同授权工作区；不会自动挑选或跨项目回退。' },
  review_plan: { stage: 'review_plan', title: '比较计划与最新来源', detail: '计划或来源需要比较；先审阅并保存有效版本，不沿用旧确认。' },
  waiting: { stage: 'waiting', title: '等待当前规划Run', detail: '当前Run仍在排队或运行，不要再次启动。' },
  inspect: { stage: 'inspect', title: '先核查Run记录', detail: 'Run失败、终态未知、停止或来源过期；保留证据，不自动重试。' },
  answer_clarification: { stage: 'answer_clarification', title: '回答Owner的必要问题', detail: '完整答复随目标保存后会自动无费准备一次续跑；模型请求仍需单独确认本次费用。' },
  review_proposal: { stage: 'review_proposal', title: '审阅Owner计划提案', detail: '提案尚待内容审阅；内容确认不会创建执行授权、派工或业务完成事实。' },
  complete: { stage: 'complete', title: '规划内容已确认', detail: '当前计划内容已确认；这不代表执行授权、任务已派发或业务成果已验收。' },
  confirm_cost: { stage: 'confirm_cost', title: '逐次确认规划费用', detail: '开始前需单独确认本次模型调用；没有绝对金额硬上限保证，费用未知不按零计算。' },
  prepare: { stage: 'prepare', title: '准备一次目标规划', detail: '准备只冻结当前目标与来源，不会调用模型或收费。' },
}

/** 纯展示投影：不发请求、不改状态、不创建授权或派发。 */
export function deriveOwnerPlanningNextStep(input: OwnerPlanningFlowInput): OwnerPlanningNextStep {
  if (input.goal.conflict || input.goal.requiresReview) return steps.resolve_goal
  if (!input.goal.exists || input.goal.dirty) return steps.save_goal
  if (input.plan.state === 'stale' || input.plan.dirty || input.plan.requiresReview || input.plan.conflict) return steps.review_plan
  if (input.executionStatus === 'queued' || input.executionStatus === 'running') return steps.waiting
  if (input.outcomeState === 'failed' || input.outcomeState === 'unknown' || input.outcomeState === 'stopped' || input.outcomeState === 'stale'
    || input.executionStatus === 'failed' || input.executionStatus === 'cancelled' || input.executionStatus === 'stale' || input.executionStatus === 'completed' && !input.outcomeState) return steps.inspect
  if (input.outcomeState === 'needs_clarification') return steps.answer_clarification
  if (input.plan.state === 'confirmed' && (input.outcomeState === null || input.outcomeState === 'proposed')) return steps.complete
  if (input.outcomeState === 'proposed' || input.plan.state === 'proposed') return steps.review_proposal
  if (input.plan.state === 'confirmed') return steps.complete
  if (!input.binding.exists || !input.binding.available) return steps.configure_binding
  if (input.prepared) return steps.confirm_cost
  return steps.prepare
}
