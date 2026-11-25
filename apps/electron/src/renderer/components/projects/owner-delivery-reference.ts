import type { OwnerManagementDeliveryItem, OwnerManagementDeliveryReference, OwnerManagementMessage } from '@gravitas/shared'

/** 与主进程使用相同的消息、任务和唯一成果匹配规则；旧引用可能没有 stepKey。 */
export function findReferencedDelivery(messages: readonly OwnerManagementMessage[], taskId: string | undefined, reference: OwnerManagementDeliveryReference): OwnerManagementDeliveryItem | undefined {
  const message = messages.find(item => item.id === reference.messageId && item.taskId === taskId && item.role === 'assistant' && item.kind === 'delivery')
  const matches = message?.delivery?.items.filter(item => item.artifactHash === reference.artifactHash && (!reference.stepKey || item.stepKey === reference.stepKey)) ?? []
  return matches.length === 1 ? matches[0] : undefined
}

/** 仅显示能唯一对应当前交付版本的最近人工决定。 */
export function findLatestDeliveryReview(messages: readonly OwnerManagementMessage[], taskId: string | undefined, reference: OwnerManagementDeliveryReference): OwnerManagementMessage | undefined {
  const verified = new Map<string, OwnerManagementDeliveryItem>()
  let cursor: OwnerManagementDeliveryReference | undefined = reference
  while (cursor && !verified.has(cursor.messageId)) {
    const item = findReferencedDelivery(messages, taskId, cursor)
    if (!item) break
    verified.set(cursor.messageId, item)
    const previousId = messages.find(message => message.id === cursor?.messageId)?.delivery?.localTextRevisionOf
    cursor = previousId ? { messageId: previousId, artifactHash: reference.artifactHash, stepKey: item.stepKey } : undefined
  }
  return messages.findLast(message => message.taskId === taskId && message.role === 'user'
    && (message.deliveryReviewDecision === 'accepted' || message.deliveryReviewDecision === 'changes_requested')
    && message.deliveryReference && verified.has(message.deliveryReference.messageId)
    && findReferencedDelivery(messages, taskId, message.deliveryReference) === verified.get(message.deliveryReference.messageId))
}
