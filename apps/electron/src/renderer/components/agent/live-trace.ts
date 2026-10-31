import type { SDKAssistantMessage, SDKContentBlock, SDKMessage, SDKToolResultBlock, SDKToolUseBlock, SDKUserMessage } from '@gravitas/shared'
import { TASK_TOOL_NAMES } from './task-progress'

/** 只显示最新的进行中内容，完成后留在可展开的记录中。 */
export function getLiveTraceIndex(blocks: SDKContentBlock[], messages: SDKMessage[], isStreaming: boolean): number | undefined {
  if (!isStreaming || blocks.length === 0) return undefined
  const index = blocks.length - 1
  const block = blocks[index]!
  if (block.type === 'thinking') {
    const lastAssistant = messages.findLast((message): message is SDKAssistantMessage => message.type === 'assistant' && !message.parent_tool_use_id)
    if (lastAssistant && ((lastAssistant as unknown as { _partial?: boolean })._partial || !lastAssistant.message?.stop_reason)) return index
  }
  if (block.type !== 'tool_use') return undefined
  const tool = block as SDKToolUseBlock
  if (TASK_TOOL_NAMES.has(tool.name)) return undefined
  const completed = messages.some((message) => {
    if (message.type !== 'user') return false
    const content = (message as SDKUserMessage).message?.content
    return Array.isArray(content) && content.some((result) => result.type === 'tool_result' && (result as SDKToolResultBlock).tool_use_id === tool.id)
  })
  return completed ? undefined : index
}
