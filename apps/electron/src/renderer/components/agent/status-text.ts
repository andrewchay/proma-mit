import { parseAgentCompletionStatus } from '@gravitas/shared'

/** 隐藏状态标记，保留正文和原始消息供复制、解析使用。 */
export function hideStatusEmoji(text: string): string {
  const hasFinalStatus = !!parseAgentCompletionStatus(text)
  const lines = text.split('\n')
  const lastLine = lines.findLastIndex((line) => line.trim().length > 0)
  return lines.map((line, index) => {
    const prefix = /^(\s*(?:>\s*|[-+*]\s+|\d+\.\s+|#{1,6}\s+|\*\*)*)/
    const match = line.match(prefix)
    const offset = match?.[0].length ?? 0
    const rest = line.slice(offset)
    if (!/^(?:🟢|🟡|🔴)/.test(rest)) return line
    const after = rest.replace(/^(?:🟢|🟡|🔴)\s*/, '')
    if ((hasFinalStatus && index === lastLine) || /^(?:\*\*)?(?:已完成|完成|还差|进行中|待决策|待处理|未完成)/.test(after)) {
      return line.slice(0, offset) + after
    }
    return line
  }).join('\n')
}
