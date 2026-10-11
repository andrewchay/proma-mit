/**
 * Turn 完成后的 follow-up 建议 —— 纯函数
 *
 * 基于刚结束一轮的工具调用与结果，确定性生成 1-2 条可点的建议追问。
 * 保守原则：只在"下一步该做什么"比较明确时给建议，避免对只读问答类轮次造成干扰。
 */

import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKToolUseBlock,
  SDKToolResultBlock,
} from '@gravitas/shared'

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const EXPLORATORY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])

/** 判断消息是否为真实用户输入（而非工具结果回执） */
function isUserInput(msg: SDKMessage): boolean {
  if (msg.type !== 'user') return false
  const blocks = (msg as SDKUserMessage).message?.content
  return Array.isArray(blocks) && blocks.some((b) => b.type === 'text' && 'text' in b && !!(b as { text: string }).text)
}

/** 切出最后一轮消息（最后一条用户输入起到末尾） */
export function sliceLastTurn(messages: SDKMessage[]): SDKMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserInput(messages[i]!)) return messages.slice(i)
  }
  return messages
}

interface ToolCallSummary {
  name: string
  /** Bash 命令内容（非 Bash 工具为空串） */
  command: string
  failed: boolean
}

/** 汇总一轮中的工具调用与成败（工具结果按 tool_use_id 关联） */
function summarizeToolCalls(turnMessages: SDKMessage[]): ToolCallSummary[] {
  const failedIds = new Set<string>()
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const blocks = (msg as SDKUserMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type === 'tool_result' && (block as SDKToolResultBlock).is_error === true) {
        failedIds.add((block as SDKToolResultBlock).tool_use_id)
      }
    }
  }

  const calls: ToolCallSummary[] = []
  for (const msg of turnMessages) {
    if (msg.type !== 'assistant') continue
    const blocks = (msg as SDKAssistantMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const tu = block as SDKToolUseBlock
      const input = tu.input as Record<string, unknown>
      calls.push({
        name: tu.name,
        command: tu.name === 'Bash' && typeof input.command === 'string' ? input.command : '',
        failed: failedIds.has(tu.id),
      })
    }
  }
  return calls
}

const TEST_COMMAND_RE = /\b(test|spec|vitest|jest|bun test|pytest|go test|cargo test)\b/i
const COMMIT_COMMAND_RE = /\bgit\s+commit\b/

/**
 * 从完整消息历史推导 follow-up 建议（内部自动切最后一轮）
 *
 * @returns 按相关度排序的建议列表，最多 2 条；无明确建议时返回空数组
 */
export function deriveFollowUpSuggestions(messages: SDKMessage[]): string[] {
  const turn = sliceLastTurn(messages)
  const calls = summarizeToolCalls(turn)
  if (calls.length === 0) return []

  // 纯只读探索轮（Read/Grep/Glob/LS）不打扰
  const onlyExploratory = calls.every((c) => EXPLORATORY_TOOLS.has(c.name))
  if (onlyExploratory) return []

  const suggestions: string[] = []
  const hasMutating = calls.some((c) => MUTATING_TOOLS.has(c.name))
  // 测试类命令执行失败（tool_result is_error）
  const failedTest = calls.some((c) => c.name === 'Bash' && c.failed && TEST_COMMAND_RE.test(c.command))
  const ranTest = calls.some((c) => c.name === 'Bash' && TEST_COMMAND_RE.test(c.command))
  const committed = calls.some((c) => c.name === 'Bash' && COMMIT_COMMAND_RE.test(c.command) && !c.failed)
  const searched = calls.some((c) => c.name === 'WebSearch' || c.name === 'WebFetch')

  // 测试失败优先级最高
  if (failedTest) {
    suggestions.push('测试有失败，先查看失败详情并修复失败的用例')
  }
  // 有代码改动但没跑测试 → 提醒验证
  if (hasMutating && !ranTest && !failedTest) {
    suggestions.push('运行相关测试，验证刚才的改动是否符合预期')
  }
  // 刚提交 → 提醒推送
  if (committed && !hasMutating) {
    suggestions.push('把当前提交推送到远端仓库')
  }
  // 联网检索后 → 提醒沉淀（在已有建议时作为第二条补充）
  if (searched) {
    suggestions.push('把刚才搜集到的信息整理成要点总结')
  }

  return [...new Set(suggestions)].slice(0, 2)
}

