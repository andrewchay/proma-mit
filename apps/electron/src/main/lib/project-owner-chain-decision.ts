import { createHash } from 'node:crypto'
import type { OwnerChainDecisionRequest, ProjectChain } from '@gravitas/shared'
import { getProjectChain, updateProjectChain } from './project-chain-service'
import { getOwnerAutonomousScheduleStatus } from './project-owner-autonomous-scheduler'
import { listOwnerExecutionCommands } from './project-owner-execution-command'
import { getProjectOwnerGoalDraft } from './project-owner-goal-service'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { appendOwnerManagementMessage, getOwnerManagementMessage, recordOwnerConversationMessage } from './project-owner-management-store'
import { getProjectDb } from './project-sqlite-store'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** 项目交付链与同一 Owner 对话在同一事务保存；重试必须复用相同请求。 */
export function decideOwnerChainDelivery(input: OwnerChainDecisionRequest): ProjectChain {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['projectId', 'requestId', 'grantId', 'taskId', 'reworkOrdinal', 'revision', 'draftId', 'version', 'choice', 'comment', 'completedCriteria', 'reasonCode'].includes(key))
    || [input.projectId, input.requestId, input.grantId, input.taskId, input.draftId].some(value => typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 128)
    || !Number.isSafeInteger(input.reworkOrdinal) || input.reworkOrdinal < 0 || !Number.isSafeInteger(input.revision) || input.revision < 0 || !Number.isSafeInteger(input.version) || input.version < 1
    || !['accept', 'reject', 'later'].includes(input.choice) || typeof input.comment !== 'string' || input.comment.length > 3000 || !Array.isArray(input.completedCriteria) || input.completedCriteria.length > 100 || input.completedCriteria.some(value => typeof value !== 'string' || value.length > 1000)
    || (input.choice !== 'later' && !input.comment.trim())) throw new Error('交付验收请求无效')
  const eventId = `owner-chain-decision:${input.projectId}:${input.requestId}`
  const messageId = digest({ eventId, role: 'user', kind: 'conversation' })
  const requestHash = digest(input)
  let result: ProjectChain | undefined
  const database = getProjectDb()
  database.transaction(() => {
    assertLocalActorEnabled()
    const old = getOwnerManagementMessage(input.projectId, messageId)
    if (old) {
      if (old.chainReview?.requestHash !== requestHash) throw new Error('验收请求ID已用于不同决定')
      result = getProjectChain(input.projectId)
      return
    }
    const schedule = getOwnerAutonomousScheduleStatus(input.projectId)
    if (schedule.state !== 'waiting' || schedule.nextAction !== 'await_business_acceptance' || schedule.grantId !== input.grantId || schedule.taskId !== input.taskId || schedule.reworkOrdinal !== input.reworkOrdinal) throw new Error('当前执行状态已变化，请重新核对')
    const chain = getProjectChain(input.projectId)
    if (chain.revision !== input.revision) throw new Error('项目交付记录已变化，请重新核对')
    const executions = new Set(listOwnerExecutionCommands({ projectId: input.projectId }).filter(command => command.grantId === input.grantId && command.taskId === input.taskId && command.reworkOrdinal === input.reworkOrdinal && command.role === 'executor' && command.state === 'settled' && command.executionStatus === 'completed').map(command => command.executionId))
    const drafts = chain.drafts.filter(draft => draft.taskId === input.taskId && draft.status === 'submitted' && draft.executionId && executions.has(draft.executionId))
    const delivery = drafts.length === 1 ? drafts[0] : undefined
    if (!delivery || delivery.id !== input.draftId || delivery.version !== input.version || delivery.responsibilities?.reviewerId !== 'local-user') throw new Error('交付版本或验收人已变化，请重新核对')
    const grant = database.prepare('SELECT task_id FROM project_owner_execution_grants WHERE project_id=? AND id=?').get(input.projectId, input.grantId) as { task_id: string | null } | undefined
    const goal = grant && getProjectOwnerGoalDraft(input.projectId, grant.task_id ?? undefined)
    if (!goal) throw new Error('当前 Owner 目标不存在，请重新核对')
    if (input.choice !== 'later') result = updateProjectChain(input.projectId, input.revision, { kind: input.choice, draftId: delivery.id, comment: input.comment.trim(), ...(input.choice === 'accept' ? { evidence: input.comment.trim(), completedCriteria: input.completedCriteria } : { reasonCode: input.reasonCode }) })
    else result = chain
    const content = input.choice === 'accept' ? `我验收通过「${delivery.title}」版本 ${delivery.version}。\n${input.comment.trim()}` : input.choice === 'reject' ? `我要求修改「${delivery.title}」版本 ${delivery.version}。\n${input.comment.trim()}` : `我稍后决定「${delivery.title}」版本 ${delivery.version} 的验收。`
    const message = { projectId: input.projectId, eventId, role: 'user' as const, kind: 'conversation' as const, ...(grant.task_id ? { taskId: grant.task_id } : {}), goalRevision: goal.revision, content, chainReview: { requestHash, draftId: delivery.id, version: delivery.version, choice: input.choice } }
    if (input.choice === 'later') appendOwnerManagementMessage(message)
    else recordOwnerConversationMessage(message)
  })()
  if (!result) throw new Error('交付验收未确认保存')
  return result
}
