import type { OwnerExecutionCommandView } from '@gravitas/shared'

export interface OwnerExecutionAttentionInput {
  grantState: string | null | undefined
  scheduleState: string | null | undefined
  nextAction: string | null | undefined
  commands: ReadonlyArray<Pick<OwnerExecutionCommandView, 'state' | 'executionStatus' | 'taskTitle'> & { executionId?: string | null; terminalEvidence?: { reason: string } }>
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

/** 执行阻塞的唯一推导入口：对话区与执行区必须共用，避免一处说“暂无事项”、另一处说“已阻塞”。 */
export function deriveOwnerExecutionAttention(input: OwnerExecutionAttentionInput): OwnerExecutionAttention | null {
  if (input.completed) return null
  const failed = input.commands.find(command => command.state === 'settled' && command.executionStatus === 'failed')
  const blockedByGrant = input.grantState === 'paused' || input.grantState === 'needs_reconcile'
  const blockedBySchedule = input.scheduleState === 'needs_reconcile' || input.scheduleState === 'stale' || input.scheduleState === 'expired'
  if (!failed && !blockedByGrant && !blockedBySchedule) return null
  return {
    blocked: true,
    title: failed?.terminalEvidence?.reason === 'output_limit' ? '研发执行达到输出上限，需要核对' : failed ? '研发执行未完成，需要核对' : '执行授权暂停，需要核对',
    detail: failed ? `「${failed.taskTitle}」没有形成可用成果；已完成的步骤与费用记录都已保留。` : '当前授权不能继续派发新工作，已有记录保留。',
    actions: ['查看失败证据', '核对工作区与费用', '确认后重新安排剩余步骤'],
    // 只有失败命令有准确 executionId 时才能提供「重新核对工作区」入口。
    ...(failed?.executionId ? { recheckExecutionId: failed.executionId } : {}),
  }
}
