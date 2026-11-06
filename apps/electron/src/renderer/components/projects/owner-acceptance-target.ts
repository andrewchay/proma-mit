import type { OwnerExecutionCommandView, OwnerExecutionAutonomousScheduleStatus, ProjectChain, ProjectDeliverable } from '@gravitas/shared'

/** 仅允许验收当前授权下的已提交交付；任务名或自由文本不能证明版本关联。 */
export function findOwnerAcceptanceTarget(chain: ProjectChain, schedule: OwnerExecutionAutonomousScheduleStatus, commands: readonly OwnerExecutionCommandView[]): ProjectDeliverable | undefined {
  if (schedule.state !== 'waiting' || schedule.nextAction !== 'await_business_acceptance' || !schedule.grantId || !schedule.taskId || schedule.reworkOrdinal === undefined) return undefined
  const executions = new Set(commands.filter(command => command.grantId === schedule.grantId && command.taskId === schedule.taskId && command.reworkOrdinal === schedule.reworkOrdinal && command.role === 'executor' && command.state === 'settled' && command.executionStatus === 'completed').map(command => command.executionId))
  const matches = chain.drafts.filter(draft => draft.taskId === schedule.taskId && draft.status === 'submitted' && draft.executionId && executions.has(draft.executionId))
  return matches.length === 1 ? matches[0] : undefined
}
