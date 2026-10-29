/**
 * 未知动作的查看与解除工具。
 *
 * 「结果未知禁止重试」在上一片已经落成执行约束：三个工具入口会在调用服务之前
 * 拦截同一指纹的重试。但拦截文案只指向一个主进程 API，人没有任何可操作的入口——
 * 模型被拦住、用户看不到清单、解除只能改代码。结果是死锁：动作既不能再执行，
 * 也没人能放行。
 *
 * 这里补两个工具：
 * - `ListUnknownActions`：只读，列出本会话所有未解除的未知动作，让"待处理"可见；
 * - `ResolveUnknownAction`：**必须经过用户确认**才能解除。模型不能自行解除后重试，
 *   用户要在对话框里明确选择"动作没生效"或"动作已生效"，选择结果作为处理依据落盘。
 */

import type { ToolResult } from '@gravitas/core'
import type { ToolContext } from '../types'
import {
  confirmUnknownActionApplied,
  listPendingUnknownActions,
  resolveUnknownAction,
  type UnknownActionRecord,
} from '../unknown-action-store'
import { guardOwnerTool } from './tool-utils'

export const LIST_UNKNOWN_ACTIONS_TOOL_NAME = 'ListUnknownActions'
export const RESOLVE_UNKNOWN_ACTION_TOOL_NAME = 'ResolveUnknownAction'

/** 用户确认后的三种结论；第三种不解除。 */
const NOT_APPLIED = '已核对：动作没有生效，允许重试'
const APPLIED = '已核对：动作已生效，不要重试'
const DEFERRED = '暂不处理'

export function createListUnknownActionsToolDefinition() {
  return {
    name: LIST_UNKNOWN_ACTIONS_TOOL_NAME,
    description: '列出本会话中结果未知、正在拦截重试的动作。只读，不改变任何状态。',
    parameters: { type: 'object' as const, properties: {} },
  }
}

export function createResolveUnknownActionToolDefinition() {
  return {
    name: RESOLVE_UNKNOWN_ACTION_TOOL_NAME,
    description:
      '在用户明确核对目标状态后解除一条未知动作的拦截。必须向用户展示该动作并取得选择；模型不能自行解除后重试。',
    parameters: {
      type: 'object' as const,
      properties: {
        action_key: { type: 'string', description: '拦截文案里给出的动作指纹，形如 computer-use:click:10,20@primary' },
      },
      required: ['action_key'],
    },
  }
}

async function executeListUnknownActionsUnchecked(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const records = await listPendingUnknownActions(ctx.sessionId)
  return {
    toolCallId: '',
    content: JSON.stringify(
      {
        count: records.length,
        actions: records.map((record) => ({
          actionKey: record.actionKey,
          tool: record.tool,
          reason: record.reason,
          createdAt: record.createdAt,
          resolution: record.resolution,
          acknowledgedAt: record.acknowledgedAt,
        })),
      },
      null,
      2,
    ),
  }
}

async function executeResolveUnknownActionUnchecked(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const actionKey = typeof (input as { action_key?: unknown })?.action_key === 'string'
    ? (input as { action_key: string }).action_key
    : undefined
  if (!actionKey) return error('action_key 必须是非空字符串')

  // 解除会放行一个可能已经生效的动作，必须由用户判断，不能由模型单方面决定。
  if (!ctx.onAskUser || !ctx.abortSignal) return error('无法创建用户确认请求：解除未知动作必须经过用户确认')

  const record = (await listPendingUnknownActions(ctx.sessionId)).find((item) => item.actionKey === actionKey)
  if (!record) return error(`没有找到待处理的未知动作：${actionKey}`)

  const question = `动作「${record.tool}」此前结果未知（${record.reason}）。请在目标系统核对后选择：`
  let answer: string | undefined
  try {
    const response = await ctx.onAskUser(
      {
        interactionType: 'unknown_action_resolution',
        questions: [
          {
            question,
            header: '未知动作待核对',
            options: [{ label: NOT_APPLIED }, { label: APPLIED }, { label: DEFERRED }],
          },
        ],
      },
      ctx.abortSignal,
    )
    answer = response.behavior === 'allow' ? response.answers[question] : undefined
  } catch (thrown) {
    return error(`用户确认未完成：${thrown instanceof Error ? thrown.message : String(thrown)}`)
  }

  if (answer !== NOT_APPLIED && answer !== APPLIED) {
    return {
      toolCallId: '',
      content: `未解除：${actionKey} 仍会拦截同一动作的重试。${describePending(record)}`,
      isError: true,
    }
  }

  if (answer === APPLIED) {
    try {
      const confirmed = await confirmUnknownActionApplied({
        sessionId: ctx.sessionId,
        id: record.id,
        resolution: `${answer}｜用户确认`,
      })
      if (!confirmed) return error(`确认失败：${actionKey} 正在执行或已被新记录替换，仍禁止重试`)
      return {
        toolCallId: '',
        content: JSON.stringify({
          acknowledged: true,
          resolved: false,
          actionKey,
          resolution: answer,
          acknowledgedAt: confirmed.acknowledgedAt,
          mayRetry: false,
        }, null, 2),
      }
    } catch (thrown) {
      return error(`人工结论保存失败：${thrown instanceof Error ? thrown.message : String(thrown)}；${actionKey} 仍禁止重试`)
    }
  }

  const resolved = await resolveUnknownAction({
    sessionId: ctx.sessionId,
    id: record.id,
    resolution: `${answer}｜用户确认`,
  })
  if (!resolved) return error(`解除失败：${actionKey} 已不在待处理列表`)
  return {
    toolCallId: '',
    content: JSON.stringify({ resolved: true, actionKey, resolution: answer, mayRetry: answer === NOT_APPLIED }, null, 2),
  }
}

function describePending(record: UnknownActionRecord): string {
  return `待处理：${record.tool}（${record.actionKey}），记录于 ${record.createdAt}。`
}

function error(content: string): ToolResult {
  return { toolCallId: '', content, isError: true }
}

export const executeListUnknownActionsTool = guardOwnerTool(LIST_UNKNOWN_ACTIONS_TOOL_NAME, executeListUnknownActionsUnchecked)
export const executeResolveUnknownActionTool = guardOwnerTool(RESOLVE_UNKNOWN_ACTION_TOOL_NAME, executeResolveUnknownActionUnchecked)
