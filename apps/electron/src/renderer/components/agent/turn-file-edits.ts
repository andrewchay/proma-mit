/**
 * Turn 级文件改动收集 —— 纯函数
 *
 * 从一轮对话（用户消息 → 下一条用户消息之间的所有消息）中提取修改类工具
 * 触及的文件及其编辑操作，供 TurnFileChangesSummary 展示与内联 diff 预览。
 */

import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKToolUseBlock,
  SDKToolResultBlock,
} from '@gravitas/shared'

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** 一次编辑操作（old → new 片段） */
export interface FileEditOp {
  oldStr: string
  newStr: string
}

/** 单个文件在本轮的改动 */
export interface FileChangeEntry {
  path: string
  /** 编辑操作序列（Write / NotebookEdit 等无 old/new 的工具为空数组） */
  ops: FileEditOp[]
}

function getFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'NotebookEdit') {
    const fp = input.notebook_path
    return typeof fp === 'string' ? fp : null
  }
  const fp = input.file_path ?? input.filePath ?? input.path
  return typeof fp === 'string' ? fp : null
}

/** 从工具输入提取编辑操作（Edit 单片段 / MultiEdit 多片段） */
function extractOps(toolName: string, input: Record<string, unknown>): FileEditOp[] {
  if (toolName === 'Edit') {
    const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
    const newStr = typeof input.new_string === 'string' ? input.new_string : ''
    if (!oldStr && !newStr) return []
    return [{ oldStr, newStr }]
  }
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : []
    const ops: FileEditOp[] = []
    for (const item of edits) {
      if (typeof item !== 'object' || item === null) continue
      const edit = item as Record<string, unknown>
      const oldStr = typeof edit.old_string === 'string' ? edit.old_string : ''
      const newStr = typeof edit.new_string === 'string' ? edit.new_string : ''
      if (!oldStr && !newStr) continue
      ops.push({ oldStr, newStr })
    }
    return ops
  }
  return []
}

/**
 * 收集一轮消息中的文件改动（保持工具调用顺序，按文件首次出现归组）
 *
 * 已失败的工具调用（tool_result is_error）被排除，与 TurnFileChangesSummary 原语义一致。
 */
export function collectFileChanges(turnMessages: SDKMessage[]): FileChangeEntry[] {
  // 先标记失败的 tool_use_id
  const failed = new Set<string>()
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const blocks = (msg as SDKUserMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      const rb = block as SDKToolResultBlock
      if (rb.is_error === true) failed.add(rb.tool_use_id)
    }
  }

  const byPath = new Map<string, FileChangeEntry>()
  for (const msg of turnMessages) {
    if (msg.type !== 'assistant') continue
    const blocks = (msg as SDKAssistantMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const tu = block as SDKToolUseBlock
      if (!MUTATING_TOOLS.has(tu.name)) continue
      if (failed.has(tu.id)) continue

      const input = tu.input as Record<string, unknown>
      const filePath = getFilePath(tu.name, input)
      if (!filePath) continue

      const existing = byPath.get(filePath)
      if (existing) {
        existing.ops.push(...extractOps(tu.name, input))
      } else {
        byPath.set(filePath, { path: filePath, ops: extractOps(tu.name, input) })
      }
    }
  }
  return [...byPath.values()]
}
