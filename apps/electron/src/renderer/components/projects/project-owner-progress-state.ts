import type { OwnerExecutionAutonomousScheduleStatus, OwnerExecutionCommandView, OwnerManagementMessage } from '@gravitas/shared'

/** 只把当前授权、当前方案对应的交付视为本轮完成。 */
export function hasCompletedOwnerDelivery(messages: readonly OwnerManagementMessage[], commands: readonly Pick<OwnerExecutionCommandView, 'grantId' | 'state'>[], taskId: string | undefined, planVersion: number | undefined, grantId: string | undefined): boolean {
  if (!grantId || planVersion === undefined) return false
  const scopedCommands = commands.filter(command => command.grantId === grantId)
  return scopedCommands.length > 0 && scopedCommands.every(command => command.state === 'settled')
    && messages.some(message => message.taskId === taskId && message.kind === 'delivery' && message.delivery?.planVersion === planVersion && message.eventId?.startsWith(`owner-delivery:${grantId}:`))
}

const ownerUpdates = new Set(['attention', 'configuration_required', 'management_progress', 'execution_arranged', 'delivery', 'clarification', 'conversation', 'reply', 'answer', 'change_proposal', 'change_decision', 'plan_proposal', 'planning_confirmation'])
const ownerWaitLabels: Partial<Record<OwnerManagementMessage['kind'], string>> = {
  attention: 'Owner 提出需要关注的事项',
  configuration_required: '需要补齐项目配置',
  clarification: '需要补充必要信息',
  planning_confirmation: '方案待你审阅',
  plan_proposal: '方案待你审阅',
  execution_arranged: '安排待你确认',
  change_proposal: '修订方案待你确认',
}

export function getOwnerWaitingMessage(messages: readonly OwnerManagementMessage[], taskId?: string): OwnerManagementMessage | null {
  const latest = [...messages].reverse().find(message => message.taskId === taskId && message.role === 'assistant' && ownerUpdates.has(message.kind))
  return latest && ownerWaitLabels[latest.kind] ? latest : null
}

export function getOwnerWaitingLabel(messages: readonly OwnerManagementMessage[], taskId?: string, authorizationState?: string): string | null {
  const latest = getOwnerWaitingMessage(messages, taskId)
  if (!latest) return null
  if (latest.kind === 'plan_proposal' && authorizationState === 'exhausted') return '等待项目预算决定'
  const label = ownerWaitLabels[latest.kind]
  if (!label) return null
  return latest.kind === 'attention' && authorizationState === 'stale' ? '授权范围需要重新确认' : label
}

export function isOwnerWaitingForUser(messages: readonly OwnerManagementMessage[], taskId?: string): boolean {
  return getOwnerWaitingLabel(messages, taskId) !== null
}

/** 项目列表一行要回答的问题：现在什么状态、在等谁、下一步是谁的事。 */
export interface OwnerProjectRowSummary {
  /** 阶段标签，用于列表主行。 */
  stage: string
  /** 等待对象；空字符串表示没有人在等。 */
  waitingOn: string
  /** 下一动作，给用户的操作提示。 */
  nextAction: string
  /** 是否正在等我处理——列表据此排序或高亮。 */
  needsUser: boolean
}

/**
 * 把调度状态与对话消息折叠成一行摘要。
 *
 * 优先看「是否有人在等用户」：等待用户的项目必须浮到列表上方，
 * 否则多项目并行时用户只能逐个点开才能发现卡点。
 *
 * 调度状态与对话消息可能不同步——消息是用户可见的事实，
 * 调度状态是系统内部投影。两者冲突时以消息为准：用户看到过提示，
 * 就不该因为内部状态已推进而认为没事。
 */
export function summarizeOwnerProjectRow(
  messages: readonly OwnerManagementMessage[],
  taskId: string | undefined,
  schedule: { state: string; reason?: string; nextAction?: string; deliveryPublished?: OwnerExecutionAutonomousScheduleStatus['deliveryPublished']; waitingQuestion?: OwnerExecutionAutonomousScheduleStatus['waitingQuestion'] } | undefined,
  authorizationState?: string,
): OwnerProjectRowSummary {
  if (schedule?.waitingQuestion) return { stage: '等待中', waitingOn: '你', nextAction: '在 Owner 对话回答问题', needsUser: true }
  const waitingLabel = getOwnerWaitingLabel(messages, taskId, authorizationState)
  if (waitingLabel) return { stage: '等待你', waitingOn: '你', nextAction: waitingLabel, needsUser: true }
  if (!schedule) return { stage: '未开始', waitingOn: '', nextAction: '尚未建立管理授权', needsUser: false }
  if (schedule.deliveryPublished) return { stage: '已交付', waitingOn: '', nextAction: '在项目对话查看成果', needsUser: false }
  switch (schedule.state) {
    case 'running': return { stage: '进行中', waitingOn: '', nextAction: 'Owner 与团队正在推进', needsUser: false }
    case 'ready': return { stage: '进行中', waitingOn: '', nextAction: '即将安排下一步', needsUser: false }
    case 'waiting': return { stage: '等待中', waitingOn: schedule.nextAction === 'human_decision' ? '你' : '系统核对', nextAction: schedule.reason ?? '等待前置条件满足', needsUser: schedule.nextAction === 'human_decision' }
    case 'paused': return { stage: '已暂停', waitingOn: '你', nextAction: schedule.reason ?? '恢复后才会继续派工', needsUser: true }
    case 'needs_reconcile': return { stage: '待核对', waitingOn: '你', nextAction: schedule.reason ?? '费用或停止状态需人工核对', needsUser: true }
    case 'stale': return { stage: '待重新确认', waitingOn: '你', nextAction: schedule.reason ?? '来源或授权已变化，需重新确认', needsUser: true }
    case 'expired': return { stage: '已过期', waitingOn: '你', nextAction: schedule.reason ?? '授权期限已过', needsUser: true }
    case 'archived': return { stage: '已归档', waitingOn: '', nextAction: '本次授权已结束', needsUser: false }
    case 'manual': return { stage: '手动模式', waitingOn: '你', nextAction: '需逐条确认后才会派工', needsUser: true }
    case 'no_grant': return { stage: '未开始', waitingOn: '', nextAction: '尚未建立管理授权', needsUser: false }
    default: return { stage: '未知', waitingOn: '', nextAction: schedule.reason ?? '请打开项目核对', needsUser: false }
  }
}
