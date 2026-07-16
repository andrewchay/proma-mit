/**
 * Sub Agent 工具（Provider-Agnostic Runtime）
 *
 * 允许主 Agent 委派子任务给内置子代理（code-reviewer / explorer / researcher）
 * 或自定义子代理。子代理在独立上下文中运行，返回结果摘要。
 */

import type { ToolResult } from '@proma/core'
import type { ToolContext } from '../types'

export const AGENT_TOOL_NAME = 'Agent'

export function createAgentToolDefinition() {
  return {
    name: AGENT_TOOL_NAME,
    description:
      '委派子代理完成独立任务。可调用内置子代理：code-reviewer（代码审查）、explorer（代码库探索）、researcher（技术调研）。子代理会在独立上下文中运行并返回结果摘要。',
    parameters: {
      type: 'object' as const,
      properties: {
        agent_name: {
          type: 'string',
          description: '子代理名称，如 code-reviewer、explorer、researcher',
        },
        task: {
          type: 'string',
          description: '要委派给子代理的具体任务描述',
        },
        model: {
          type: 'string',
          description: '覆盖子代理使用的模型 ID（可选，默认继承主 Agent）',
        },
        files: {
          type: 'array',
          description: '子代理应重点关注的文件路径列表（可选）',
          items: { type: 'string' },
        },
        max_turns: {
          type: 'number',
          description: '子代理最大工具调用轮次（可选，默认 10）',
        },
      },
      required: ['agent_name', 'task'],
    },
  }
}

export async function executeAgentTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.runSubAgent) {
    return {
      toolCallId: '',
      content: '当前 Runtime 未配置 Sub Agent 运行器，无法委派任务',
      isError: true,
    }
  }

  const args = input as Record<string, unknown>
  const agentName = typeof args.agent_name === 'string' ? args.agent_name : ''
  const task = typeof args.task === 'string' ? args.task : ''

  if (!agentName || !task) {
    return {
      toolCallId: '',
      content: 'Agent 工具需要 agent_name 和 task 参数',
      isError: true,
    }
  }

  try {
    const result = await ctx.runSubAgent({
      agentName,
      task,
      model: typeof args.model === 'string' ? args.model : undefined,
      files: Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string') : undefined,
      maxTurns: typeof args.max_turns === 'number' ? args.max_turns : undefined,
      abortSignal: ctx.abortSignal,
    })

    return {
      toolCallId: '',
      content: result,
      isError: false,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      toolCallId: '',
      content: `子代理执行失败: ${message}`,
      isError: true,
    }
  }
}
