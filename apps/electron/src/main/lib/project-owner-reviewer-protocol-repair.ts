/** 同一Reviewer命令内最多补正一次输出；不重跑Executor、不修改原文或放宽校验。 */
import { parseOwnerTechnicalReviewResponse, assertOwnerDevelopmentValidationForVerdict } from './project-owner-technical-review'
import { ownerDevelopmentArtifactFromPrompt } from './project-owner-development-artifact'
import { readOwnerCommandFrozenSource } from './project-owner-employee-runtime'
import { getOwnerTaskMaterializationRecord } from './project-owner-task-materialization'
import { assertOwnerReviewerTextDelivery } from './project-owner-text-delivery'
import * as store from './project-sqlite-store'

export function isOwnerReviewerProtocolRepairSession(sessionId: string): boolean {
  try {
    const execution = store.getAgentExecutionBySessionId(sessionId)
    if (!execution?.ownerCommandId || execution.status !== 'running') return false
    const command = store.getProjectDb().prepare('SELECT role FROM project_owner_execution_commands WHERE id=? AND execution_id=?').get(execution.ownerCommandId, execution.id) as { role: string } | undefined
    return command?.role === 'reviewer'
  } catch { return false }
}

export function ownerReviewerProtocolCorrection(sessionId: string, prompt: string, raw: string): string | null {
  let execution: ReturnType<typeof store.getAgentExecutionBySessionId>
  try { execution = store.getAgentExecutionBySessionId(sessionId) }
  catch { return null }
  if (!execution?.ownerCommandId || execution.status !== 'running') return null
  const command = store.getProjectDb().prepare('SELECT role FROM project_owner_execution_commands WHERE id=? AND execution_id=?').get(execution.ownerCommandId, execution.id) as { role: string } | undefined
  if (command?.role !== 'reviewer') return null
  const rows = store.getProjectDb().prepare('SELECT state FROM project_owner_execution_request_reservations WHERE command_id=?').all(execution.ownerCommandId) as Array<{ state: string }>
  if (!rows.length || rows.some(row => row.state !== 'settled')) return null
  const { source } = readOwnerCommandFrozenSource(execution.ownerCommandId)
  const task = source.tasks.find(item => item.taskId === execution.entityId)
  const link = getOwnerTaskMaterializationRecord(execution.projectId, source.materialization.id).links.find(item => item.id === task?.linkId)
  if (!link) return null
  const development = source.executionKind === 'development' ? ownerDevelopmentArtifactFromPrompt(prompt) : null
  const text = development ? null : assertOwnerReviewerTextDelivery(execution.ownerCommandId)
  if (!development && !text) return null
  try {
    const parsed = parseOwnerTechnicalReviewResponse(raw, link.projection.acceptanceCriteria,
      development?.contentHash ?? text?.contentSha256, development?.content ?? text?.content,
      development ? 'development' : 'text')
    if (development?.validationEvidence) assertOwnerDevelopmentValidationForVerdict(parsed.verdict, development.validationEvidence)
    return null
  } catch (cause) {
    // 只把应用内置校验器的原因交回模型；原始回答仍保留，补正另计请求与费用。
    const reason = cause instanceof Error ? cause.message : '结构化评审校验失败'
    return `主进程内部校验反馈（不是用户的新要求）：本轮评审没有通过校验：${reason}。请基于同一冻结成果和验证证据重新提交严格JSON。这是一次有界补正，不是已经验收；不要重做代码或更改验收标准。quote只能复制一段连续原文，禁止省略号拼接。验证失败时明确给出未满足项和可执行修改建议，不得强行approved。`
  }
}
