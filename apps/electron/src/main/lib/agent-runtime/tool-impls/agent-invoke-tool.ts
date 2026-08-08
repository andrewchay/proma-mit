/**
 * InvokeAgent 工具 — Agent 互调协议（PH2-F）
 *
 * 让当前 Agent/成员把任务/请求发送给另一位成员（真人或 AI 员工）的 Agent，
 * 写入对方 Mailbox 的互调请求（AgentInvokeRequest），对方可接受/回答/执行。
 * =「他人可调用你的 Agent 做确认/小任务」。
 */

import type { ToolResult } from '@gravitas/core'
import type { RuntimeToolDefinition, ToolContext } from '../types.ts'
import { resolveMemberForSession } from '../../app-event-bus'

export const INVOKE_AGENT_TOOL_NAME = 'InvokeAgent'

export function createInvokeAgentToolDefinition(): Omit<RuntimeToolDefinition, 'execute'> {
  return {
    name: INVOKE_AGENT_TOOL_NAME,
    description:
      '把任务/请求发送给另一位成员（真人 paa-<name> 或 AI 员工 agent-<id>）的 Agent。' +
      '对方会在其团队收件箱（Mailbox）看到这个互调请求，并可接受/完成/拒绝。' +
      '当有子任务适合交给某位队友（真人或 AI 员工）完成、或需要向对方确认/索取信息时使用。',
    parameters: {
      type: 'object',
      properties: {
        toMemberId: { type: 'string', description: '目标成员 ID（真实 paa-<name> 或 AI 员工 agent-<id>）' },
        task: { type: 'string', description: '请求内容：做什么 / 问什么 / 确认什么（自包含）' },
      },
      required: ['toMemberId', 'task'],
    },
  }
}

export async function executeInvokeAgentTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const params = input as { toMemberId: string; task: string }
  if (!params.toMemberId || !params.task) {
    return { toolCallId: '', content: '参数错误：需要 toMemberId + task', isError: true }
  }
  try {
    const { sendAgentInvoke, invokeToText } = await import('../../agent-invoke-service')
    const fromMember = resolveMemberForSession(ctx.sessionId) ?? 'unknown'
    const req = sendAgentInvoke(fromMember, params.toMemberId, params.task.trim())
    return { toolCallId: '', content: `已发送互调请求给 ${params.toMemberId}（等待对方处理）。\n${invokeToText(req)}` }
  } catch (error) {
    return { toolCallId: '', content: `发送互调请求失败: ${error instanceof Error ? error.message : String(error)}`, isError: true }
  }
}
