/**
 * 对外动作识别：只认显式外部副作用工具名，来自持久化会话消息中的 tool_use。
 *
 * 用途仅限于恢复说明与人工判断；它不是许可，也不能证明动作真的成功。
 * 没有命中时不代表“绝对没有对外执行”，只代表没有已知标签。
 */
import type { SDKMessage } from '@gravitas/shared'

/** 明确会产生外部副作用或越过工作区边界的工具。 */
export const OWNER_OUTWARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  'SendExternalMessage',
  'WebBridgeUpload',
  'WebBridgeDownload',
  'ComputerUseRequestTakeover',
])

export function detectOwnerOutwardActions(messages: readonly SDKMessage[]): string[] {
  const found = new Set<string>()
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const content = (message as unknown as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const item = block as { type?: unknown; name?: unknown }
      if (item.type !== 'tool_use' || typeof item.name !== 'string') continue
      if (OWNER_OUTWARD_TOOL_NAMES.has(item.name)) found.add(item.name)
    }
  }
  return [...found].sort()
}
