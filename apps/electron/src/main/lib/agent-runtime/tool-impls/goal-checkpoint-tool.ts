/** GoalCheckpoint 是 Goal Runtime 的控制面工具，不执行工作区副作用。 */

import type { ToolResult } from '@proma/core'
import type { RuntimeToolDefinition, ToolContext } from '../types.ts'

export const GOAL_CHECKPOINT_TOOL_NAME = 'GoalCheckpoint'

export function createGoalCheckpointToolDefinition(): RuntimeToolDefinition {
  return {
    name: GOAL_CHECKPOINT_TOOL_NAME,
    description: '当存在激活 Goal 时，在本轮工作结束前提交结构化进展、证据和下一步。只有验收条件已有实际证据时才可提交 complete。',
    parameters: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['continue', 'waiting', 'blocked', 'complete'] },
        summary: { type: 'string', description: '本轮完成情况和当前事实摘要。' },
        completed: { type: 'array', description: '本轮完成项。' },
        evidence: { type: 'array', description: '测试、命令、文件或工具结果等可审计证据。' },
        nextAction: { type: 'string', description: '继续执行时的下一项具体动作。' },
        wakeTrigger: { type: 'object', description: '等待或续跑的唤醒条件。' },
        blocker: { type: 'string', description: '无法继续时的具体阻塞原因。' },
      },
      required: ['outcome', 'summary', 'completed', 'evidence'],
    },
    execute: async (_input: unknown, _ctx: ToolContext): Promise<ToolResult> => ({
      toolCallId: '',
      content: 'GoalCheckpoint 只能由 Goal Runtime 拦截处理。',
      isError: true,
    }),
  }
}
