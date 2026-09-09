import type { AgentQueryInput } from '@gravitas/shared'

/** 识别需要由 Runtime 确定性执行、不能发送给模型的用户命令。 */
export function resolveRequestedOperation(userMessage: string): AgentQueryInput['requestedOperation'] {
  return userMessage.trim() === '/compact' ? 'compact' : undefined
}
