import type { OwnerManagementDeliveryItem, OwnerManagementDeliveryReference, OwnerManagementMessage } from '@gravitas/shared'

/** 与主进程使用相同的消息、任务和唯一成果匹配规则；旧引用可能没有 stepKey。 */
export function findReferencedDelivery(messages: readonly OwnerManagementMessage[], taskId: string | undefined, reference: OwnerManagementDeliveryReference): OwnerManagementDeliveryItem | undefined {
  const message = messages.find(item => item.id === reference.messageId && item.taskId === taskId && item.role === 'assistant' && item.kind === 'delivery')
  const matches = message?.delivery?.items.filter(item => item.artifactHash === reference.artifactHash && (!reference.stepKey || item.stepKey === reference.stepKey)) ?? []
  return matches.length === 1 ? matches[0] : undefined
}

/** 仅显示能唯一对应当前交付版本的最近人工决定。 */
export function findLatestDeliveryReview(messages: readonly OwnerManagementMessage[], taskId: string | undefined, reference: OwnerManagementDeliveryReference): OwnerManagementMessage | undefined {
  const selected = findReferencedDelivery(messages, taskId, reference)
  if (!selected) return undefined
  return messages.findLast(message => message.taskId === taskId && message.role === 'user' && Boolean(message.deliveryReviewDecision)
    && message.deliveryReference?.messageId === reference.messageId
    && findReferencedDelivery(messages, taskId, message.deliveryReference) === selected)
}
