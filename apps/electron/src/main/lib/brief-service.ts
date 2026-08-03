/**
 * 核心 task Brief 回执服务 — Brief Service
 *
 * 对「核心任务」（高优先级 / 高风险 / 里程碑）：
 * 1. 判定是否为核心任务
 * 2. 创建 briefReceipt 记录
 * 3. 通过钉钉工作通知/机器人发送 brief（含 H5 回执表单链接）
 * 4. 同学填写回执后回调入库
 *
 * H5 表单由 brief-callback-server 提供；通过内网穿透暴露公网 URL。
 */

import type { Task } from './project-service'
import type { BriefReceipt } from './project-types'
import * as store from './project-sqlite-store'
import { getUserMapping } from './project-service'

/** 判定是否为核心任务：高优先级 / 高风险 视为核心。 */
export function isCoreTask(task: Task): boolean {
  if (task.status === 'draft') return false
  if (task.priority === 'high' || task.priority === 'critical') return true
  if (task.riskLevel === 'high' || task.riskLevel === 'critical') return true
  return false
}

/** 生成回执表单 URL（基于配置的回执服务公网地址 + receipt id） */
export function buildBriefFormUrl(receiptId: string, baseUrl?: string): string {
  const host = baseUrl?.replace(/\/+$/, '') ?? ''
  return `${host}/brief/${receiptId}`
}

/**
 * 为核心任务创建 brief 回执并发送钉钉通知。
 *
 * @param task 核心任务
 * @param brief brief 内容（默认基于任务标题与截止时间生成）
 * @param baseUrl 回执服务公网地址（内网穿透后的 URL）
 */
export async function createBriefForTask(
  task: Task,
  brief?: string,
  baseUrl?: string
): Promise<BriefReceipt | null> {
  if (!isCoreTask(task)) return null
  if (!task.assignee) return null

  // 幂等：已有 pending 回执则复用，避免重复创建（自动同步与手动触发可能并发）
  const existingReceipts = store.listBriefReceiptsByTask(task.id)
  const pending = existingReceipts.find((r) => r.status === 'pending')
  if (pending) return pending

  const mapping = await getUserMapping(task.assignee.userId)
  const unionId = mapping?.dingTalkUnionId ?? mapping?.dingtalkUserId
  if (!unionId) return null

  const briefText = brief ?? buildDefaultBrief(task)
  const receipt = store.createBriefReceipt({
    taskId: task.id,
    projectId: task.projectId,
    unionId,
    brief: briefText,
  })

  // 补写回执表单 URL（依赖 receipt id）
  const receiptFormUrl = buildBriefFormUrl(receipt.id, baseUrl)
  store.updateBriefReceipt(receipt.id, { formUrl: receiptFormUrl })

  // 发送钉钉通知（含回执表单链接）
  const { sendDingTalkRobotMessage } = await import('./dingtalk-todo-provider')
  const sent = await sendDingTalkRobotMessage({
    title: `【核心任务】${task.title}`,
    text: `**核心任务 brief：${task.title}**\n\n${briefText}\n\n> 截止：${task.dueDate ? new Date(task.dueDate).toLocaleString('zh-CN') : '未设置'}\n\n请点击填写回执确认：[填写回执](${receiptFormUrl})`,
  })

  if (!sent.success) {
    console.warn(`[BriefService] 钉钉通知发送失败（回执仍保留，可手动补发）: ${sent.error}`)
  }
  // 重新读取以返回包含 formUrl 的最新回执
  return store.getBriefReceipt(receipt.id)
}

/** 同学提交回执后调用 */
export function recordBriefResponse(
  receiptId: string,
  content: string
): BriefReceipt | null {
  return store.updateBriefReceipt(receiptId, {
    status: 'responded',
    content,
    respondedAt: Date.now(),
  })
}

function buildDefaultBrief(task: Task): string {
  const parts = [`请确认你对任务「${task.title}」的理解与承诺。`]
  if (task.dueDate) {
    parts.push(`截止时间：${new Date(task.dueDate).toLocaleString('zh-CN')}`)
  }
  if (task.description) {
    parts.push(`任务说明：${task.description}`)
  }
  return parts.join('\n')
}
