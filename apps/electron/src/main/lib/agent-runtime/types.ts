/**
 * Agent Runtime 类型定义
 *
 * 定义 Provider-Agnostic Agent Runtime 所需的输入、工具、消息等类型。
 * 该层不依赖任何特定 SDK，只依赖 @proma/core 的 ProviderAdapter 和 @proma/shared 的公共类型。
 */

import type { ToolDefinition, ToolCall, ToolResult } from '@proma/core'
import type { ProviderType, PromaPermissionMode } from '@proma/shared'
import type { SessionCallbacks } from '../agent-orchestrator'

/** Agent Runtime 输入 */
export interface AgentRuntimeInput {
  /** 会话 ID */
  sessionId: string
  /** 渠道 ID */
  channelId: string
  /** 工作区 ID（可选） */
  workspaceId?: string
  /** 用户当前 prompt */
  prompt: string
  /** 模型 ID */
  model: string
  /** 供应商类型 */
  provider: ProviderType
  /** 明文 API Key */
  apiKey: string
  /** API Base URL */
  baseUrl: string
  /** Agent 工作目录 */
  cwd: string
  /** 系统提示词 */
  systemPrompt: string
  /** 可用工具列表 */
  tools: RuntimeToolDefinition[]
  /** 最大工具调用轮次（安全上限） */
  maxTurns?: number
  /** 中止信号 */
  abortSignal?: AbortSignal
}

/** Agent Runtime 接口 */
export interface AgentRuntime {
  /** 发送消息并运行 Agent 循环 */
  sendMessage(input: AgentRuntimeInput, callbacks: SessionCallbacks): Promise<void>
  /** 中止指定会话 */
  abort(sessionId: string): void
  /** 释放资源 */
  dispose(): void
}

/** 工具执行上下文 */
export interface ToolContext {
  /** 当前工作目录 */
  cwd: string
  /** 会话 ID */
  sessionId: string
  /** 中止信号 */
  abortSignal?: AbortSignal
  /** 当前权限模式（Plan 模式判断用） */
  permissionMode?: PromaPermissionMode
  /** Plan 模式是否已由 Agent 触发进入 */
  planModeEntered?: boolean
  /** 进入 Plan 模式通知回调 */
  onEnterPlanMode?: () => void
  /** 退出 Plan 模式审批回调 */
  onExitPlanMode?: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{ behavior: 'allow'; targetMode?: PromaPermissionMode } | { behavior: 'deny'; message: string }>
  /** 切换权限模式（由 ExitPlanMode 回调结果触发） */
  setPermissionMode?: (mode: PromaPermissionMode) => void
}

/** Runtime 工具定义 */
export interface RuntimeToolDefinition {
  /** 工具名称 */
  name: string
  /** 工具描述 */
  description: string
  /** JSON Schema 参数定义 */
  parameters: ToolDefinition['parameters']
  /** 工具执行函数 */
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

/** Runtime 内部消息（用于 history 维护） */
export interface RuntimeMessage {
  /** 消息角色 */
  role: 'user' | 'assistant' | 'tool'
  /** 文本内容 */
  content: string
  /** 助手消息携带的工具调用 */
  toolCalls?: ToolCall[]
  /** 工具结果对应的工具调用 ID */
  toolCallId?: string
  /** 是否为错误结果 */
  isError?: boolean
  /** 时间戳 */
  createdAt: number
}

/** Agent Runtime 配置（阶段 1 简单硬编码，后续可扩展） */
export interface AgentRuntimeConfig {
  /** 最大工具调用轮次 */
  maxTurns: number
}

/** 默认 Runtime 配置 */
export const DEFAULT_RUNTIME_CONFIG: AgentRuntimeConfig = {
  maxTurns: 25,
}
