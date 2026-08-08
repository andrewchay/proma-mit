/**
 * RunCostAudit 工具 — 费用审计工具（PH2-C）
 *
 * 给 Agent 一个按需/自动审计费用的能力：
 * - 调用 runCostAudit 生成费用审计报告（近 7 天窗口：总费用/token、按模型/工作区分布、
 *   Top 会话、环比变化、异常告警）。
 * - Agent 据此向用户说明费用情况，主动报告异常或给出省钱建议。
 */

import type { ToolResult } from '@gravitas/core'
import type { RuntimeToolDefinition, ToolContext } from '../types.ts'

export const COST_AUDIT_TOOL_NAME = 'RunCostAudit'

export function createCostAuditToolDefinition(): Omit<RuntimeToolDefinition, 'execute'> {
  return {
    name: COST_AUDIT_TOOL_NAME,
    description:
      '对 Token 用量与费用执行审计：返回近 7 天总费用/token、按模型/工作区分布、Top 消耗会话、' +
      '与上一窗口的费用环比、异常告警（如费用突增、单会话/单模型占比过高）。' +
      '当用户询问费用/消耗、需要检查成本异动、或定时自动审计时使用；拿到报告后总结给用户并提出可优化点。',
    parameters: {
      type: 'object',
      properties: {
        windowMs: { type: 'number', description: '审计窗口长度（毫秒，默认 7 天）' },
      },
    },
  }
}

export async function executeCostAuditTool(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
  const params = (input ?? {}) as { windowMs?: number }
  try {
    const { runCostAudit, costAuditToText } = await import('../../cost-audit-service')
    const report = runCostAudit({ windowMs: params.windowMs })
    return { toolCallId: '', content: costAuditToText(report) }
  } catch (error) {
    return { toolCallId: '', content: `费用审计失败: ${error instanceof Error ? error.message : String(error)}`, isError: true }
  }
}
