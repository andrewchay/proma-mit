/**
 * ProposeAssetFromRun 工具 — 成功输出转可复用资产（PH2-D）
 *
 * 让 Agent 在成功完成某次运行后，主动把这次输出的方法/步骤沉淀为可复用资产提案
 * （Workflow 草稿 / Skill 定义），供用户确认保存，实现「数据复利」。
 */

import type { ToolResult } from '@gravitas/core'
import type { RuntimeToolDefinition, ToolContext } from '../types.ts'

export const PROPOSE_ASSET_TOOL_NAME = 'ProposeAssetFromRun'

export function createProposeAssetToolDefinition(): Omit<RuntimeToolDefinition, 'execute'> {
  return {
    name: PROPOSE_ASSET_TOOL_NAME,
    description:
      '把一次成功运行的方法/步骤沉淀为可复用资产提案（Workflow 或 Skill）。' +
      '传入本次会话的 sessionId（可选标题）；从该会话证据提炼决策/写回/验证为结构化步骤，' +
      '生成建议的标题、描述、执行提示词与关键工具。拿到提案后用自然语言呈现给用户确认是否保存为正式资产。' +
      '当一个任务的成功路径很可能再次遇到、或用户暗示"下次也这么做"时使用。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '本次成功运行的会话 ID' },
        title: { type: 'string', description: '资产标题（可选，取会话运行标题）' },
      },
      required: ['sessionId'],
    },
  }
}

export async function executeProposeAssetTool(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
  const params = input as { sessionId: string; title?: string }
  if (!params.sessionId) {
    return { toolCallId: '', content: '参数错误：需要 sessionId', isError: true }
  }
  try {
    const { proposeAssetFromRun, proposalToText } = await import('../../asset-proposal-service')
    const proposal = proposeAssetFromRun(params.sessionId, params.title)
    if (!proposal) {
      return {
        toolCallId: '',
        content: '该会话的证据不足以提炼成可复用资产（可能改动/决策过少）。如需沉淀，建议直接为当前工作流程创建 Workflow 或 Skill。',
      }
    }
    return { toolCallId: '', content: proposalToText(proposal) }
  } catch (error) {
    return { toolCallId: '', content: `生成资产提案失败: ${error instanceof Error ? error.message : String(error)}`, isError: true }
  }
}
