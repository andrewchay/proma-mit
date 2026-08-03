/**
 * Pi Tool Bridge。
 *
 * Pi runtime 不直接暴露其内置文件或 Shell 工具。所有可调用能力都在此处映射到
 * Proma RuntimeToolDefinition，统一经过 Proma 的权限策略、工作目录边界和结果模型。
 * P0 只开放只读 Read；后续阶段按能力开关逐项扩展。
 */

import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ImageContent } from '@earendil-works/pi-ai'
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  createCoreTools,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GOAL_CHECKPOINT_TOOL_NAME,
} from '../agent-runtime/tool-registry'
import { BASH_TOOL_NAME } from '../agent-runtime/tool-impls/bash-tool'
import { WEB_SEARCH_TOOL_NAME } from '../agent-runtime/tool-impls/web-search-tool'
import { WEB_FETCH_TOOL_NAME } from '../agent-runtime/tool-impls/web-fetch-tool'
import { RECALL_MEMORY_TOOL_NAME, ADD_MEMORY_TOOL_NAME } from '../agent-runtime/tool-impls/memory-tool'
import { EDIT_TOOL_NAME } from '../agent-runtime/tool-impls/edit-tool'
import { GREP_TOOL_NAME } from '../agent-runtime/tool-impls/grep-tool'
import { READ_TOOL_NAME } from '../agent-runtime/tool-impls/read-tool'
import { WRITE_TOOL_NAME } from '../agent-runtime/tool-impls/write-tool'
import type { RuntimeToolDefinition, ToolContext } from '../agent-runtime/types'

/** Pi 中暴露给模型的 Proma Read 工具名，避免和 Pi 内置 read 发生混淆。 */
// 模型可见名称与 Proma 既有系统提示词、工具事件保持一致。Pi 内置工具使用小写名称，
// 同时又被 allowlist 禁用，因此这些 PascalCase 名称仍然只会落到 Proma Bridge。
export const PI_PROMA_READ_TOOL_NAME = 'Read'
export const PI_PROMA_WRITE_TOOL_NAME = 'Write'
export const PI_PROMA_EDIT_TOOL_NAME = 'Edit'
export const PI_PROMA_GREP_TOOL_NAME = 'Grep'
export const PI_PROMA_BASH_TOOL_NAME = 'Bash'
export const PI_PROMA_ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode'
export const PI_PROMA_EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'
export const PI_PROMA_ASK_USER_TOOL_NAME = 'AskUserQuestion'
export const PI_PROMA_AGENT_TOOL_NAME = 'Agent'
export const PI_PROMA_GOAL_CHECKPOINT_TOOL_NAME = 'GoalCheckpoint'

/** Pi runtime 的渐进能力开关。只有显式开启的能力才会注册到 Pi。 */
export const PI_RUNTIME_TOOL_CAPABILITIES = {
  read: true,
  write: true,
  shell: true,
  tasks: false,
  attachments: true,
  mcp: true,
  skills: false,
  plan: true,
  askUser: true,
  subAgent: true,
  goal: true,
  webBridge: true,
  computerUse: true,
  webSearch: true,
  memory: true,
} as const

export interface PiToolPermissionResult {
  allowed: boolean
  message?: string
}

export type PiCanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<PiToolPermissionResult>

export interface CreatePiToolBridgeOptions {
  toolContext: ToolContext
  canUseTool?: PiCanUseToolCallback
  coreTools?: RuntimeToolDefinition[]
  /** 由 Proma MCP 管理器提供的、已命名空间化的工具。 */
  mcpTools?: RuntimeToolDefinition[]
}

interface PiToolDetails {
  toolName: string
  isError: boolean
}

function getRequiredTool(tools: RuntimeToolDefinition[], name: string): RuntimeToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) {
    throw new Error(`Pi Tool Bridge 缺少 Proma 工具：${name}`)
  }
  return tool
}

interface PiToolImage {
  mediaType: string
  data: string
}

function toolResult(
  toolName: string,
  content: string,
  isError: boolean,
  imageData?: PiToolImage[],
): { content: Array<{ type: 'text'; text: string } | ImageContent>; details: PiToolDetails } {
  return {
    content: [
      { type: 'text', text: content },
      ...(imageData?.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mediaType })) ?? []),
    ],
    details: { toolName, isError },
  }
}

function errorResult(toolName: string, message: string): { content: Array<{ type: 'text'; text: string } | ImageContent>; details: PiToolDetails } {
  return toolResult(toolName, message, true)
}

interface PiBridgeToolConfig<TSchemaType extends TSchema> {
  piName: string
  runtimeName: string
  parameters: TSchemaType
  promptSnippet: string
}

function createBridgeTool<TSchemaType extends TSchema>(
  config: PiBridgeToolConfig<TSchemaType>,
  runtimeTool: RuntimeToolDefinition,
  options: CreatePiToolBridgeOptions,
): ToolDefinition {
  const definition: ToolDefinition<TSchemaType, PiToolDetails> = {
    name: config.piName,
    label: `Proma ${config.runtimeName}`,
    description: runtimeTool.description,
    promptSnippet: config.promptSnippet,
    parameters: config.parameters,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) return errorResult(config.runtimeName, '操作已中止')

      const input = { ...(params as object) } as Record<string, unknown>

      // GoalCheckpoint 是 Goal 控制面的状态提交，不是工作区或外部系统副作用。
      // Proma / AI SDK runtime 都会在权限工具分支之前拦截它；Pi 也必须保持相同语义，
      // 否则 safe 模式会把一个已激活 Goal 的检查点错误拒绝，导致 Goal 无法进入下一状态。
      if (config.runtimeName === GOAL_CHECKPOINT_TOOL_NAME) {
        if (!options.toolContext.onGoalCheckpoint) return errorResult(config.runtimeName, '当前会话没有激活的 Goal')
        await options.toolContext.onGoalCheckpoint(input as unknown as import('@proma/shared').AgentGoalCheckpoint)
        return toolResult(config.runtimeName, 'Goal 检查点已保存', false)
      }

      // AskUserQuestion 是交互式提问工具，授权完全由 onAskUser 回调负责（内部会等待用户回答）。
      // 不能先走通用 canUseTool 门禁——permissionService 会把 AskUserQuestion 路由到 askUserHandler
      // 再发一次提问，随后工具执行阶段 executeAskUserQuestionTool 又会调用 onAskUser 发第二次提问，
      // 导致用户被重复询问两遍（第一次提交被当作门禁响应，第二次带着空表单再次弹出）。
      // 这里与 ProviderAgnosticAgentAdapter / AI SDK runtime core 一致：直接执行工具（内部走 onAskUser）。
      if (config.runtimeName === ASK_USER_QUESTION_TOOL_NAME) {
        const result = await runtimeTool.execute(input, {
          ...options.toolContext,
          abortSignal: signal ?? options.toolContext.abortSignal,
        })
        return toolResult(config.runtimeName, result.content, Boolean(result.isError), result.imageData)
      }

      const permission = options.canUseTool
        ? await options.canUseTool(config.runtimeName, input, signal ?? new AbortController().signal)
        : { allowed: false, message: 'Pi 工具桥未配置 Proma 权限回调' }
      if (!permission.allowed) {
        return errorResult(config.runtimeName, permission.message ?? `Proma 权限策略拒绝了 ${config.runtimeName} 操作`)
      }

      if (config.runtimeName === ENTER_PLAN_MODE_TOOL_NAME) {
        options.toolContext.onEnterPlanMode?.()
      }
      if (config.runtimeName === EXIT_PLAN_MODE_TOOL_NAME) {
        if (!options.toolContext.onExitPlanMode) {
          return errorResult(config.runtimeName, '当前 Runtime 未配置 Plan 审批回调')
        }
        const exitResult = await options.toolContext.onExitPlanMode(input, signal ?? new AbortController().signal)
        if (exitResult.behavior === 'deny') {
          return errorResult(config.runtimeName, exitResult.message)
        }
        if (exitResult.targetMode) options.toolContext.setPermissionMode?.(exitResult.targetMode)
      }
      const result = await runtimeTool.execute(input, {
        ...options.toolContext,
        abortSignal: signal ?? options.toolContext.abortSignal,
      })
      // 截图必须随 tool result 进入 Pi 的下一轮上下文；只回传文字会让模型看不到页面本体。
      return toolResult(config.runtimeName, result.content, Boolean(result.isError), result.imageData)
    },
  }

  // Pi SDK 的 ToolDefinition 默认泛型为 TSchema，因函数参数逆变无法直接表达
  // 具体 TypeBox schema；运行时仍保留完整 schema 并由 Pi 校验。
  return definition as unknown as ToolDefinition
}

/**
 * 创建当前 Pi 会话允许的 Proma 工具。
 *
 * 注意：调用方必须把返回值作为 Pi customTools，并用 tools allowlist 仅启用这些名称，
 * 从而保证 Pi 自带 Bash/read/write/edit 等工具不会绕过 Proma。
 */
export function createPiToolBridge(options: CreatePiToolBridgeOptions): ToolDefinition[] {
  const coreTools = options.coreTools ?? createCoreTools()
  const tools: ToolDefinition[] = []
  if (PI_RUNTIME_TOOL_CAPABILITIES.read) {
    tools.push(createBridgeTool({
      piName: PI_PROMA_READ_TOOL_NAME,
      runtimeName: READ_TOOL_NAME,
      parameters: Type.Object({
        file_path: Type.String({ description: '要读取的文件路径，相对于当前工作目录' }),
        offset: Type.Optional(Type.Number({ description: '起始行号（从 0 开始）' })),
        limit: Type.Optional(Type.Number({ description: '最多读取行数' })),
      }),
      promptSnippet: `${PI_PROMA_READ_TOOL_NAME}: 通过 Proma 的受控文件边界读取工作区文件。`,
    }, getRequiredTool(coreTools, READ_TOOL_NAME), options))
  }
  if (PI_RUNTIME_TOOL_CAPABILITIES.write) {
    tools.push(createBridgeTool({
      piName: PI_PROMA_WRITE_TOOL_NAME,
      runtimeName: WRITE_TOOL_NAME,
      parameters: Type.Object({
        file_path: Type.String({ description: '要写入的文件路径，相对于当前工作目录' }),
        content: Type.String({ description: '要写入的文件内容' }),
      }),
      promptSnippet: `${PI_PROMA_WRITE_TOOL_NAME}: 通过 Proma 权限策略写入工作区文件。`,
    }, getRequiredTool(coreTools, WRITE_TOOL_NAME), options))
  }
  if (PI_RUNTIME_TOOL_CAPABILITIES.write) {
    tools.push(createBridgeTool({
      piName: PI_PROMA_EDIT_TOOL_NAME,
      runtimeName: EDIT_TOOL_NAME,
      parameters: Type.Object({
        file_path: Type.String({ description: '要编辑的文件路径，相对于当前工作目录' }),
        old_string: Type.String({ description: '要被替换的精确原文本' }),
        new_string: Type.String({ description: '替换后的文本' }),
      }),
      promptSnippet: `${PI_PROMA_EDIT_TOOL_NAME}: 通过 Proma 权限策略精确编辑工作区文件。`,
    }, getRequiredTool(coreTools, EDIT_TOOL_NAME), options))
  }
  if (PI_RUNTIME_TOOL_CAPABILITIES.read) {
    tools.push(createBridgeTool({
      piName: PI_PROMA_GREP_TOOL_NAME,
      runtimeName: GREP_TOOL_NAME,
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: '搜索范围，相对于当前工作目录' })),
        regex: Type.String({ description: '要匹配的正则表达式' }),
      }),
      promptSnippet: `${PI_PROMA_GREP_TOOL_NAME}: 通过 Proma 的受控搜索工具检索工作区。`,
    }, getRequiredTool(coreTools, GREP_TOOL_NAME), options))
  }
  if (PI_RUNTIME_TOOL_CAPABILITIES.shell) {
    tools.push(createBridgeTool({
      piName: PI_PROMA_BASH_TOOL_NAME,
      runtimeName: BASH_TOOL_NAME,
      parameters: Type.Object({
        command: Type.String({ description: '要在工作目录执行的 shell 命令' }),
        timeout: Type.Optional(Type.Number({ description: '超时时间（毫秒）' })),
      }),
      promptSnippet: `${PI_PROMA_BASH_TOOL_NAME}: 通过 Proma 权限策略在工作目录执行命令。`,
    }, getRequiredTool(coreTools, BASH_TOOL_NAME), options))
  }
  if (PI_RUNTIME_TOOL_CAPABILITIES.webSearch) {
    tools.push(createBridgeTool({
      piName: WEB_SEARCH_TOOL_NAME,
      runtimeName: WEB_SEARCH_TOOL_NAME,
      parameters: Type.Object({
        query: Type.String({ description: '搜索查询词，使用简洁明确的关键词' }),
      }),
      promptSnippet: `${WEB_SEARCH_TOOL_NAME}: 通过 Proma 联网搜索互联网获取实时信息。`,
    }, getRequiredTool(coreTools, WEB_SEARCH_TOOL_NAME), options))
    tools.push(createBridgeTool({
      piName: WEB_FETCH_TOOL_NAME,
      runtimeName: WEB_FETCH_TOOL_NAME,
      parameters: Type.Object({
        url: Type.String({ description: '要抓取的完整 URL（http/https）' }),
      }),
      promptSnippet: `${WEB_FETCH_TOOL_NAME}: 通过 Proma 抓取指定 URL 的网页可读文本。`,
    }, getRequiredTool(coreTools, WEB_FETCH_TOOL_NAME), options))
  }
  if (PI_RUNTIME_TOOL_CAPABILITIES.memory) {
    tools.push(createBridgeTool({
      piName: RECALL_MEMORY_TOOL_NAME,
      runtimeName: RECALL_MEMORY_TOOL_NAME,
      parameters: Type.Object({
        query: Type.String({ description: '记忆检索查询词' }),
      }),
      promptSnippet: `${RECALL_MEMORY_TOOL_NAME}: 通过 Proma 搜索用户的跨会话记忆。`,
    }, getRequiredTool(coreTools, RECALL_MEMORY_TOOL_NAME), options))
    tools.push(createBridgeTool({
      piName: ADD_MEMORY_TOOL_NAME,
      runtimeName: ADD_MEMORY_TOOL_NAME,
      parameters: Type.Object({
        userMessage: Type.String({ description: '要记住的用户消息' }),
        assistantMessage: Type.Optional(Type.String({ description: '对应的助手回复（可选）' })),
      }),
      promptSnippet: `${ADD_MEMORY_TOOL_NAME}: 通过 Proma 存储对话到长期记忆。`,
    }, getRequiredTool(coreTools, ADD_MEMORY_TOOL_NAME), options))
  }
  if (PI_RUNTIME_TOOL_CAPABILITIES.plan) {
    tools.push(createBridgeTool({
      piName: PI_PROMA_ENTER_PLAN_MODE_TOOL_NAME,
      runtimeName: ENTER_PLAN_MODE_TOOL_NAME,
      parameters: Type.Object({ reason: Type.Optional(Type.String({ description: '进入 Plan 模式的原因' })) }),
      promptSnippet: `${PI_PROMA_ENTER_PLAN_MODE_TOOL_NAME}: 进入 Proma Plan 模式。`,
    }, getRequiredTool(coreTools, ENTER_PLAN_MODE_TOOL_NAME), options))
    tools.push(createBridgeTool({
      piName: PI_PROMA_EXIT_PLAN_MODE_TOOL_NAME,
      runtimeName: EXIT_PLAN_MODE_TOOL_NAME,
      parameters: Type.Object({
        summary: Type.String({ description: '待用户审批的计划摘要' }),
        allowedPrompts: Type.Optional(Type.String({ description: '建议批准的后续提示词' })),
      }),
      promptSnippet: `${PI_PROMA_EXIT_PLAN_MODE_TOOL_NAME}: 提交 Plan 并等待 Proma 用户审批。`,
    }, getRequiredTool(coreTools, EXIT_PLAN_MODE_TOOL_NAME), options))
  }
  if (PI_RUNTIME_TOOL_CAPABILITIES.askUser) {
    tools.push(createBridgeTool({
      piName: PI_PROMA_ASK_USER_TOOL_NAME,
      runtimeName: ASK_USER_QUESTION_TOOL_NAME,
      parameters: Type.Object({
        questions: Type.Array(Type.Object({
          question: Type.String(),
          header: Type.Optional(Type.String()),
          multiSelect: Type.Optional(Type.Boolean()),
          options: Type.Optional(Type.Array(Type.Object({
            label: Type.String(),
            description: Type.Optional(Type.String()),
            preview: Type.Optional(Type.String()),
          }))),
        })),
      }),
      promptSnippet: `${PI_PROMA_ASK_USER_TOOL_NAME}: 向 Proma 用户提问并等待回答。`,
    }, getRequiredTool(coreTools, ASK_USER_QUESTION_TOOL_NAME), options))
  }
  if (PI_RUNTIME_TOOL_CAPABILITIES.subAgent) {
    tools.push(createBridgeTool({
      piName: PI_PROMA_AGENT_TOOL_NAME,
      runtimeName: AGENT_TOOL_NAME,
      parameters: Type.Object({
        agent_name: Type.String(),
        task: Type.String(),
        model: Type.Optional(Type.String()),
        files: Type.Optional(Type.Array(Type.String())),
        max_turns: Type.Optional(Type.Number()),
      }),
      promptSnippet: `${PI_PROMA_AGENT_TOOL_NAME}: 通过 Proma 委派独立子任务。`,
    }, getRequiredTool(coreTools, AGENT_TOOL_NAME), options))
  }
  if (PI_RUNTIME_TOOL_CAPABILITIES.goal && options.toolContext.onGoalCheckpoint) {
    tools.push(createBridgeTool({
      piName: PI_PROMA_GOAL_CHECKPOINT_TOOL_NAME,
      runtimeName: GOAL_CHECKPOINT_TOOL_NAME,
      parameters: Type.Object({
        outcome: Type.String(), summary: Type.String(), completed: Type.Array(Type.String()), evidence: Type.Array(Type.Object({ type: Type.String(), value: Type.String() })),
        nextAction: Type.Optional(Type.String()), blocker: Type.Optional(Type.String()), wakeTrigger: Type.Optional(Type.Object({})),
      }),
      promptSnippet: `${PI_PROMA_GOAL_CHECKPOINT_TOOL_NAME}: 向 Proma GoalCoordinator 提交可审计检查点。`,
    }, getRequiredTool(coreTools, GOAL_CHECKPOINT_TOOL_NAME), options))
  }
  if (PI_RUNTIME_TOOL_CAPABILITIES.mcp) {
    for (const mcpTool of options.mcpTools ?? []) {
      tools.push(createBridgeTool({
        piName: mcpTool.name,
        runtimeName: mcpTool.name,
        parameters: Type.Unsafe(mcpTool.parameters),
        promptSnippet: `${mcpTool.name}: 通过 Proma 工作区 MCP 连接调用。`,
      }, mcpTool, options))
    }
  }
  for (const runtimeTool of coreTools) {
    const isWebBridge = runtimeTool.name.startsWith('WebBridge')
    const isComputerUse = runtimeTool.name.startsWith('ComputerUse')
    if ((!PI_RUNTIME_TOOL_CAPABILITIES.webBridge || !isWebBridge) && (!PI_RUNTIME_TOOL_CAPABILITIES.computerUse || !isComputerUse)) continue
    tools.push(createBridgeTool({
      piName: runtimeTool.name,
      runtimeName: runtimeTool.name,
      parameters: Type.Unsafe(runtimeTool.parameters),
      promptSnippet: `${runtimeTool.name}: 通过 Proma 受管自动化边界执行。`,
    }, runtimeTool, options))
  }
  return tools
}
