/**
 * Companion 会话历史提取
 *
 * 从 SDK 消息流（getAgentSessionSDKMessages）提取手机端可读的会话历史。
 * AgentMessage 列表对 SDK 驱动的会话非常稀疏，桌面端历史实际渲染自 SDK 消息，
 * 手机端沿用同一数据源但做轻量提取：只保留用户/助手文本与工具活动行。
 * SDKMessage 为宽松类型，提取全程容错，畸形消息一律跳过。
 */

export interface CompanionHistoryEntry {
  role: 'user' | 'assistant' | 'tool'
  text: string
}

interface ContentBlock {
  type?: string
  text?: string
  name?: string
}

/** 单条内容块提取（返回 null 表示该块不可读） */
function extractBlock(block: unknown, role: 'user' | 'assistant'): { role: 'user' | 'assistant' | 'tool'; text: string } | null {
  if (typeof block !== 'object' || block === null) return null
  const b = block as ContentBlock
  if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
    return { role, text: b.text }
  }
  if (role === 'assistant' && b.type === 'tool_use' && typeof b.name === 'string') {
    return { role: 'tool', text: b.name }
  }
  // user 消息里的 tool_result 是工具输出回传，桌面端也不逐条展示，跳过
  return null
}

/** 提取手机端可读的会话历史（只保留最后 maxEntries 条） */
export function extractCompanionHistory(messages: unknown, maxEntries = 200): CompanionHistoryEntry[] {
  if (!Array.isArray(messages)) return []
  const entries: CompanionHistoryEntry[] = []

  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) continue
    const msg = raw as { type?: string; message?: { role?: string; content?: unknown } }
    if (msg.type !== 'user' && msg.type !== 'assistant') continue
    const role = msg.type === 'user' ? 'user' : 'assistant'
    const content = msg.message?.content

    if (typeof content === 'string') {
      if (content.trim()) entries.push({ role, text: content })
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const extracted = extractBlock(block, role)
      if (extracted) entries.push(extracted)
    }
  }

  return entries.slice(-maxEntries)
}
