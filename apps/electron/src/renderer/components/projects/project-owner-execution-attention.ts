import type { OwnerExecutionCommandView } from '@gravitas/shared'

export interface OwnerExecutionAttentionInput {
  grantState: string | null | undefined
  scheduleState: string | null | undefined
  nextAction: string | null | undefined
  commands: ReadonlyArray<Pick<OwnerExecutionCommandView, 'state' | 'executionStatus' | 'taskTitle' | 'workspaceBlocked' | 'reviewReplaced'> & { grantId?: string; taskId?: string; role?: string; reworkOrdinal?: number; executionId?: string | null; terminalEvidence?: { reason: string } }>
  currentSchedule?: { grantId?: string; taskId?: string; role?: string; reworkOrdinal?: number; reason?: string } | null
  completed: boolean
}

export interface OwnerExecutionAttention {
  blocked: true
  title: string
  detail: string
  actions: string[]
  /** 需要「重新核对工作区」入口时，给出对应执行 ID。 */
  recheckExecutionId?: string
}

/**
 * 需要用户介入的命令状态。
 *
 * `released` / `cancelled` 不算：前者是被接替释放，后者是用户自己停的，都不该再要求处理。
 * 命令级阻塞必须单独识别——认领前准备失败（研发工作区被占等）只会把**命令**写成
 * needs_reconcile，授权可能仍是 active、调度也还没进入 needs_reconcile。
 */
const COMMAND_ATTENTION_STATES = new Set(['failed', 'needs_reconcile', 'unknown'])

/** 执行阻塞的唯一推导入口：对话区与执行区必须共用，避免一处说“暂无事项”、另一处说“已阻塞”。 */
export function deriveOwnerExecutionAttention(input: OwnerExecutionAttentionInput): OwnerExecutionAttention | null {
  if (input.completed) return null
  // 命令级事实比授权/调度级更具体，优先据此给出原因。
  const schedule = input.currentSchedule
  const hasScheduleIdentity = Boolean(schedule?.grantId && schedule.taskId && schedule.role && Number.isInteger(schedule.reworkOrdinal))
  const commands = input.commands.filter(command =>
    !command.reviewReplaced && (!schedule?.grantId || command.grantId === schedule.grantId) &&
    (!hasScheduleIdentity || (
      command.taskId === schedule?.taskId && command.role === schedule?.role && command.reworkOrdinal === schedule?.reworkOrdinal
    )))
  const workspaceBlock = commands.find(command => command.workspaceBlocked && command.executionId)
  if (workspaceBlock?.executionId) return {
    blocked: true,
    title: '研发工作区需要清理',
    detail: `「${workspaceBlock.taskTitle}」尚未启动。工作区清理后，可以核对并继续原任务。`,
    actions: ['查看阻塞的文件', '清理工作区后重新核对'],
    recheckExecutionId: workspaceBlock.executionId,
  }
  const blocked = commands.find(command =>
    COMMAND_ATTENTION_STATES.has(command.state) || (command.state === 'settled' && command.executionStatus === 'failed'))
  if (!blocked && schedule?.role === 'reviewer' && input.scheduleState === 'waiting' && input.nextAction === 'human_decision') {
    return {
      blocked: true,
      title: '独立评审需要核对，后续工作已暂停',
      detail: (schedule.reason ?? '评审结束后仍缺少可用结果。').replace('Reviewer', '独立评审'),
      actions: ['查看独立评审记录'],
    }
  }
  const blockedByGrant = input.grantState === 'paused' || input.grantState === 'needs_reconcile'
  const blockedBySchedule = input.scheduleState === 'needs_reconcile' || input.scheduleState === 'stale' || input.scheduleState === 'expired'
  if (!blocked && !blockedByGrant && !blockedBySchedule) return null
  const reason = blocked?.terminalEvidence?.reason
  if (blocked?.role === 'reviewer') {
    const needsReconciliation = blocked.state === 'needs_reconcile' || blocked.state === 'unknown'
    const actions = blocked.terminalEvidence ? ['在项目进展中展开执行终止证据'] : ['在项目进展中查看独立评审的工作记录']
    return {
      blocked: true,
      title: reason === 'output_limit' ? '独立评审达到输出上限' : '独立评审未能完成',
      detail: `「${blocked.taskTitle}」的执行成果记录已保留，独立评审尚无可用结论。${needsReconciliation ? '本次评审费用仍需核对，原预留已保留。' : ''}`,
      actions,
    }
  }
  return {
    blocked: true,
    title: reason === 'output_limit' ? '研发执行达到输出上限，需要核对'
      : blocked ? '研发执行未完成，需要核对'
      : '执行授权暂停，需要核对',
    detail: blocked
      ? `「${blocked.taskTitle}」没有形成可用成果；已完成的步骤与费用记录都已保留。`
      : '当前授权不能继续派发新工作，已有记录保留。',
    actions: ['查看失败证据', '核对工作区与费用', '确认后重新安排剩余步骤'],
    // 只有命令有准确 executionId 时才能提供「重新核对工作区」入口。
    ...(blocked?.executionId ? { recheckExecutionId: blocked.executionId } : {}),
  }
}
