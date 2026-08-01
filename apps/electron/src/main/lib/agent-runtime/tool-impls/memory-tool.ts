/**
 * 记忆工具实现（Agent Runtime）
 *
 * 复用 Chat 模式的 MemOS Cloud 记忆能力（memory-service / memos-client），
 * 为 Agent 提供跨会话记忆：RecallMemory（回忆）与 AddMemory（记住）。
 *
 * 凭据与 Chat 模式共用：~/.proma/memory.json（getMemoryConfig）。
 * 未配置时工具返回可读错误，引导用户在 设置 > 记忆 中配置。
 */

import type { ToolResult } from '@proma/core'
import type { ToolContext } from '../types.ts'
import { getMemoryConfig } from '../../memory-service'
import { searchMemory, addMemory, formatSearchResult, type MemosCredentials } from '../../memos-client'

export const RECALL_MEMORY_TOOL_NAME = 'RecallMemory'
export const ADD_MEMORY_TOOL_NAME = 'AddMemory'

export interface RecallMemoryToolInput {
  query: string
}

export interface AddMemoryToolInput {
  userMessage: string
  assistantMessage?: string
}

export function createRecallMemoryToolDefinition() {
  return {
    name: RECALL_MEMORY_TOOL_NAME,
    description:
      '搜索用户的跨会话记忆（事实与偏好）。当用户提到"之前""上次"等回溯表述，或当前任务可能和过去做过的事情有关时，先回忆再回答。',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: '记忆检索查询词',
        },
      },
      required: ['query'],
    },
  }
}

export function createAddMemoryToolDefinition() {
  return {
    name: ADD_MEMORY_TOOL_NAME,
    description:
      '存储对话内容到长期记忆。当对话中出现值得记住的信息（用户的工作方式、偏好、重要决定、一起解决过的问题）时调用。',
    parameters: {
      type: 'object' as const,
      properties: {
        userMessage: {
          type: 'string',
          description: '要记住的用户消息',
        },
        assistantMessage: {
          type: 'string',
          description: '对应的助手回复（可选）',
        },
      },
      required: ['userMessage'],
    },
  }
}

/** 从全局配置构建记忆凭据；未配置时返回 null */
function buildMemosCredentials(): MemosCredentials | null {
  const config = getMemoryConfig()
  if (!config.apiKey) return null
  return {
    apiKey: config.apiKey,
    userId: config.userId?.trim() || 'proma-user',
    baseUrl: config.baseUrl,
  }
}

export async function executeRecallMemoryTool(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
  const credentials = buildMemosCredentials()
  if (!credentials) {
    return {
      toolCallId: '',
      content: '记忆工具未配置 API Key。请告知用户在 设置 > 记忆 中配置 MemOS Cloud 凭据后重试。',
      isError: true,
    }
  }

  try {
    const query = (input as RecallMemoryToolInput).query?.trim()
    if (!query) return { toolCallId: '', content: '记忆检索参数缺失: query', isError: true }
    const result = await searchMemory(credentials, query)
    return { toolCallId: '', content: formatSearchResult(result) }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[Agent 记忆工具] 回忆失败:', error)
    return { toolCallId: '', content: `记忆操作失败: ${msg}`, isError: true }
  }
}

export async function executeAddMemoryTool(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
  const credentials = buildMemosCredentials()
  if (!credentials) {
    return {
      toolCallId: '',
      content: '记忆工具未配置 API Key。请告知用户在 设置 > 记忆 中配置 MemOS Cloud 凭据后重试。',
      isError: true,
    }
  }

  try {
    const userMessage = (input as AddMemoryToolInput).userMessage?.trim()
    if (!userMessage) return { toolCallId: '', content: '记忆存储参数缺失: userMessage', isError: true }
    const assistantMessage = (input as AddMemoryToolInput).assistantMessage?.trim() || undefined
    await addMemory(credentials, { userMessage, assistantMessage })
    return { toolCallId: '', content: '记忆已存储。' }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[Agent 记忆工具] 存储失败:', error)
    return { toolCallId: '', content: `记忆操作失败: ${msg}`, isError: true }
  }
}
