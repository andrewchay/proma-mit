/**
 * Plan 模式工具定义
 *
 * EnterPlanMode / ExitPlanMode 是 Agent 主动进入/退出计划审批模式的信号工具。
 * 实际的状态切换和 UI 交互由 ProviderAgnosticAgentAdapter 在工具调用前拦截处理，
 * 这里只提供工具定义和占位执行函数，让模型知道可以调用它们。
 */

import type { RuntimeToolDefinition, ToolContext } from '../types.ts'
import type { ToolResult } from '@proma/core'

export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode'
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'

export function createEnterPlanModeToolDefinition(): RuntimeToolDefinition {
  return {
    name: ENTER_PLAN_MODE_TOOL_NAME,
    description:
      '进入 Plan 模式：在继续执行任何写操作之前，先向用户展示完整计划并等待审批。调用后只读工具仍可继续使用，写操作将被拦截直到用户批准 ExitPlanMode。',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '进入 Plan 模式的原因（可选）',
        },
      },
    },
    execute: async (_input: unknown, _ctx: ToolContext): Promise<ToolResult> => ({
      toolCallId: '',
      content: '已进入 Plan 模式',
      isError: false,
    }),
  }
}

export function createExitPlanModeToolDefinition(): RuntimeToolDefinition {
  return {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description:
      '退出 Plan 模式：向用户展示已完成的计划并请求审批，用户批准后可切换到自动执行或自动审批模式。',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '计划摘要和需要审批的内容',
        },
        allowedPrompts: {
          type: 'string',
          description: '建议批准的后续提示词（可选，用逗号分隔）',
        },
      },
      required: ['summary'],
    },
    execute: async (_input: unknown, _ctx: ToolContext): Promise<ToolResult> => ({
      toolCallId: '',
      content: '已退出 Plan 模式',
      isError: false,
    }),
  }
}
