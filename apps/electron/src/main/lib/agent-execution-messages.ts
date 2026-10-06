import { createHash } from 'node:crypto'
import type { AgentMessage } from '@gravitas/shared'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Runtime 的完成回调历史上混用了 SDKMessage 与 AgentMessage，不能依赖类型断言。 */
export function normalizeExecutionMessages(messages: readonly unknown[] | undefined): AgentMessage[] {
  return (messages ?? []).flatMap((value): AgentMessage[] => {
    const raw = record(value)
    if (!raw || raw.error || raw._errorCode || raw.errorCode) return []
    const sdkMessage = record(raw.message)
    const role = raw.role ?? raw.type
    if (role !== 'assistant' && role !== 'user') return []
    const body = sdkMessage?.content ?? raw.content
    const content = typeof body === 'string' ? body : Array.isArray(body)
      ? body.flatMap((block) => {
        const text = record(block)
        return text?.type === 'text' && typeof text.text === 'string' ? [text.text] : []
      }).join('\n') : ''
    const id = raw.uuid ?? raw.id ?? sdkMessage?.id
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : typeof raw._createdAt === 'number' ? raw._createdAt : 0
    // 旧消息可能没有 uuid：稳定指纹保守去重，不能把旧回答当作本轮结果。
    const identity = typeof id === 'string' && id ? id : `legacy:${createHash('sha256').update(JSON.stringify({ role, content, createdAt })).digest('hex')}`
    return [{ id: identity, role, content, createdAt }]
  })
}

export function currentExecutionMessages(messages: readonly unknown[] | undefined, previousIds: ReadonlySet<string>): AgentMessage[] {
  return normalizeExecutionMessages(messages).filter((message) => !previousIds.has(message.id))
}
