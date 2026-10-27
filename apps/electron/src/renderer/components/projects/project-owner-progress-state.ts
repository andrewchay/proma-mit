import type { OwnerManagementMessage } from '@gravitas/shared'

const ownerUpdates = new Set(['attention', 'configuration_required', 'management_progress', 'execution_arranged', 'delivery', 'clarification', 'conversation', 'reply', 'answer', 'change_proposal', 'change_decision', 'plan_proposal', 'planning_confirmation'])
const ownerWaitLabels: Partial<Record<OwnerManagementMessage['kind'], string>> = {
  attention: 'Owner 已暂停，需处理提示',
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
  const label = ownerWaitLabels[latest.kind]
  if (!label) return null
  return latest.kind === 'attention' && authorizationState === 'stale' ? '授权范围需要重新确认' : label
}

export function isOwnerWaitingForUser(messages: readonly OwnerManagementMessage[], taskId?: string): boolean {
  return getOwnerWaitingLabel(messages, taskId) !== null
}
