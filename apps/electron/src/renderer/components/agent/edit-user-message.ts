/**
 * 编辑用户消息并重发 —— 纯函数辅助
 *
 * 行为：用户点击历史用户消息的"编辑"→ 回填输入框 → 发送时先回退到
 * 该消息之前最近一条顶层 assistant 消息（复用 rewindSession 的文件恢复），
 * 再以新文本发起新一轮。本模块只包含可测试的纯逻辑，副作用在 AgentView 中编排。
 */

import type { SDKMessage } from '@gravitas/shared'

/** 编辑重发的回退方案 */
export interface EditRewindPlan {
  /** 回退锚点：目标用户消息之前最近一条顶层 assistant 消息的 uuid */
  anchorAssistantUuid: string
  /** 本地截断后应保留的消息条数（含锚点消息，即目标用户消息的下标） */
  keptCount: number
}

/** 从 SDKMessage 上安全读取 uuid（历史数据可能缺失该字段） */
function getUuid(message: SDKMessage | undefined): string | undefined {
  return (message as unknown as { uuid?: string } | undefined)?.uuid ?? undefined
}

/**
 * 为用户消息定位回退锚点
 *
 * @param messages 顶层消息列表（持久化顺序）
 * @param targetUserUuid 被编辑的用户消息 uuid
 * @returns 回退方案；找不到目标消息或目标之前没有 assistant 消息（首条消息）时返回 null
 */
export function resolveEditRewindAnchor(
  messages: SDKMessage[],
  targetUserUuid: string,
): EditRewindPlan | null {
  const targetIdx = messages.findIndex((m) => getUuid(m) === targetUserUuid)
  // 目标不存在（-1）或目标是首条消息（0，前面没有可回退的对话点）
  if (targetIdx <= 0) return null
  for (let i = targetIdx - 1; i >= 0; i--) {
    const candidate = messages[i]
    const uuid = getUuid(candidate)
    if (candidate?.type === 'assistant' && uuid) {
      return { anchorAssistantUuid: uuid, keptCount: i + 1 }
    }
  }
  return null
}

/** 剥离 attached_files / quoted_file XML 块后的纯文本（回填输入框用，与 parseAttachedFiles 行为一致） */
export function stripAttachmentBlocks(rawText: string): string {
  return rawText
    .replace(/<attached_files>\n?[\s\S]*?\n?<\/attached_files>\n*/g, '')
    .replace(/<quoted_file[^>]*>[\s\S]*?<\/quoted_file>\n*/g, '')
    .trim()
}
