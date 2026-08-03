/** 可复制的项目周报/摘要，数据全部来自项目模型、告警、Todo outbox、活动流与 AI 员工执行。 */

import {
  getProject,
  getProjectProgress,
  listDingTalkTodoRetries,
  listProjectActivities,
  listProjectWorkItems,
} from './project-service.ts'
import { listProjectAlerts } from './project-alert-service.ts'
import * as store from './project-sqlite-store'

export interface ProjectSummary {
  projectId: string
  title: string
  generatedAt: number
  completed: number
  total: number
  overdueCount: number
  blockedCount: number
  highRiskCount: number
  todoRetryCount: number
  recentActivityCount: number
  /** AI 员工任务完成数 */
  agentCompleted: number
  /** AI 员工任务总数 */
  agentTotal: number
  /** AI 员工执行失败数 */
  agentFailed: number
  markdown: string
}

export async function generateProjectSummary(projectId: string): Promise<ProjectSummary> {
  const project = await getProject(projectId)
  if (!project) throw new Error('项目不存在')
  const [progress, items, alerts, retries, activities, agentExecs] = await Promise.all([
    getProjectProgress(projectId),
    listProjectWorkItems(projectId),
    listProjectAlerts(projectId),
    listDingTalkTodoRetries(projectId),
    listProjectActivities(projectId),
    store.listAgentExecutionsByProject(projectId),
  ])
  const overdue = items.filter((item) => item.isOverdue)
  const blocked = alerts.filter((alert) => alert.type === 'blocked')
  const highRisk = alerts.filter((alert) => alert.type === 'high_risk')
  const agentCompleted = agentExecs.filter((exec) => exec.status === 'completed').length
  const agentFailed = agentExecs.filter((exec) => exec.status === 'failed' || exec.status === 'stale').length
  const agentTotal = agentExecs.length
  const generatedAt = Date.now()
  const lines = [
    `# ${project.title} 项目摘要`,
    '',
    `生成时间：${new Date(generatedAt).toLocaleString('zh-CN')}`,
    '',
    '## 进度',
    `- 完成：${progress.completed}/${progress.total}（${progress.percentage}%）`,
    `- 逾期：${overdue.length}`, `- 阻塞：${blocked.length}`, `- 高风险：${highRisk.length}`, `- 钉钉 Todo 待重试：${retries.length}`,
  ]
  if (agentTotal > 0) {
    lines.push(
      '',
      '## AI 员工',
      `- 执行：${agentCompleted}/${agentTotal} 完成${agentFailed > 0 ? `，失败 ${agentFailed}` : ''}`,
    )
  }
  if (overdue.length > 0) lines.push('', '## 逾期项', ...overdue.slice(0, 10).map((item) => `- ${item.title}${item.assignee ? `（${item.assignee.displayName}）` : '（未指派）'}`))
  if (blocked.length > 0) lines.push('', '## 阻塞项', ...blocked.slice(0, 10).map((alert) => `- ${alert.title}：${alert.description}`))
  if (highRisk.length > 0) lines.push('', '## 高风险项', ...highRisk.slice(0, 10).map((alert) => `- ${alert.title}：${alert.description}`))
  if (activities.length > 0) lines.push('', '## 近期活动', ...activities.slice(0, 5).map((activity) => `- ${activity.summary}`))
  if (overdue.length === 0 && blocked.length === 0 && highRisk.length === 0 && retries.length === 0) lines.push('', '当前未发现逾期、阻塞、高风险或待重试同步。')
  return { projectId, title: project.title, generatedAt, completed: progress.completed, total: progress.total, overdueCount: overdue.length, blockedCount: blocked.length, highRiskCount: highRisk.length, todoRetryCount: retries.length, recentActivityCount: activities.length, agentCompleted, agentTotal, agentFailed, markdown: lines.join('\n') }
}
