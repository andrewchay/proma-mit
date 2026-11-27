import { createHash } from 'node:crypto'
import type { OwnerManagementDeliveryItem, OwnerManagementMessage, SendOwnerManagementMessageRequest } from '@gravitas/shared'
import { applyOwnerLocalTextEdit, ownerTextDeliveryCharacterLimit, parseOwnerLocalTextEdit } from './project-owner-delivery-content'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { getOwnerExecutionGrant } from './project-owner-execution-grant-issue'
import { getOwnerManagementDelegation } from './project-owner-management-delegation'
import { appendOwnerManagementMessage, getOwnerManagementMessage, getOwnerManager } from './project-owner-management-store'
import { getProjectOwnerPlanDraft } from './project-owner-plan-service'
import { getProjectOwnerGoalDraft } from './project-owner-goal-service'
import { findOwnerDeliveredBudgetIssue } from './project-owner-budget-deliverable'
import { findOwnerDeliveredRosterConflict } from './project-owner-roster-scenario'
import * as store from './project-sqlite-store'

const textHash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')

type UserMessage = Omit<OwnerManagementMessage, 'id' | 'conversationId' | 'createdAt'> & { goalRevision: number }

/** 与用户消息同事务，只处理准确引用的最新文本交付。 */
export function tryApplyOwnerLocalTextEdit(input: SendOwnerManagementMessageRequest, message: UserMessage): OwnerManagementMessage | null {
  const { projectId, taskId, deliveryReference: reference } = input
  if (!reference || input.deliveryReviewDecision === 'deferred') return null
  const rule = input.deliveryReviewDecision === 'accepted' ? null : parseOwnerLocalTextEdit(input.content)
  if (!rule && input.deliveryReviewDecision !== 'accepted') return null
  const db = store.getProjectDb()
  const manager = getOwnerManager(projectId)
  const grant = getOwnerExecutionGrant({ projectId, ...(taskId ? { taskId } : {}) })
  const plan = getProjectOwnerPlanDraft(projectId, taskId)
  const goal = getProjectOwnerGoalDraft(projectId, taskId)
  const source = getOwnerManagementMessage(projectId, reference.messageId)
  const delivery = source?.delivery
  if (!manager || manager.status !== 'active' || !grant || grant.state !== 'active' || grant.budget.expiresAt <= Date.now()
    || !delivery || !goal || !plan || plan.state !== 'confirmed' || plan.goalRevision !== input.expectedGoalRevision
    || delivery.planVersion !== plan.planVersion || source.eventId !== `owner-delivery:${grant.grantId}:${ownerExecutionHash(delivery)}`
    || getOwnerManagementDelegation(projectId, taskId).state !== 'active') return null
  const latest = db.prepare(`SELECT id FROM project_owner_management_messages
    WHERE project_id=? AND json_extract(payload,'$.kind')='delivery' AND json_extract(payload,'$.taskId') IS ?
    ORDER BY rowid DESC LIMIT 1`).get(projectId, taskId ?? null) as { id: string } | undefined
  const pending = db.prepare("SELECT 1 FROM agent_executions WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(projectId)
  const pendingCommand = db.prepare("SELECT 1 FROM project_owner_execution_commands WHERE project_id=? AND state IN ('reserved','queued','running') LIMIT 1").get(projectId)
  if (pending || pendingCommand) return null
  const item = delivery.items.find(item => item.artifactHash === reference.artifactHash && (!reference.stepKey || item.stepKey === reference.stepKey))
  const step = plan.proposal.steps.find(step => step.key === item?.stepKey)
  if (!item || !step || step.deliveryKind === 'development' || delivery.items.length !== plan.proposal.steps.length
    || plan.proposal.steps.some(step => !delivery.items.some(item => item.stepKey === step.key))
    || textHash(item.content) !== item.artifactHash
    || /^\s*(?:<!doctype\s+html|<html\b)/i.test(item.content)
    || plan.proposal.steps.some(step => step.dependencies.includes(item.stepKey))) return null

  const saveReply = (content: string) => {
    const saved = appendOwnerManagementMessage({ ...message, localTextAction: true })
    appendOwnerManagementMessage({ projectId, ...(taskId ? { taskId } : {}), eventId: `owner-local-text-reply:${saved.id}`,
      role: 'assistant', kind: 'reply', content, goalRevision: input.expectedGoalRevision })
    return saved
  }
  if (!rule && !item.localTextRevision) return null
  if (latest?.id !== source.id) {
    if (!rule) throw new Error('该修订已有更新，请打开最新版本后再确认。')
    return saveReply('你选中的成果已有更新。请在最新版本中引用要修改的原文。')
  }
  if (!rule) return saveReply('已记录你对当前局部修订版本的认可。')
  const revised = applyOwnerLocalTextEdit(item.content, rule)
  if (revised === null) return saveReply(rule.kind === 'insert'
    ? '请这样写：只在「完整原文行」之后新增一行「新增正文」，原文行需在当前版本中只出现一次。原版本仍可查阅。'
    : '无法在当前版本中唯一定位这项局部修改。请引用只出现一次的原文，并说明准确的改法。原版本仍可查阅。')
  const limit = ownerTextDeliveryCharacterLimit(item.acceptanceCriteria)
  if ((limit !== null && Array.from(revised.trim()).length > limit) || Buffer.byteLength(revised, 'utf8') > 65_536)
    return saveReply('修改后会超过原成果的字数上限。请缩短修改文字，或在对话中调整字数要求。')
  const evidence = delivery.items.map(entry => ({
    stepKey: entry.stepKey,
    content: entry === item ? revised : entry.content,
    dependencies: plan.proposal.steps.find(step => step.key === entry.stepKey)?.dependencies,
    ...(textHash(entry.content) === entry.artifactHash ? {} : { fileSnapshot: true as const }),
  }))
  const issue = findOwnerDeliveredBudgetIssue(goal.goal, evidence) ?? findOwnerDeliveredRosterConflict(goal.goal, evidence)
  if (issue) return saveReply(`这次修改可能影响原验收要求。请先核对后再提交。\n${issue}`)

  const saved = appendOwnerManagementMessage({ ...message, localTextAction: true })
  const revisedItem: OwnerManagementDeliveryItem = {
    ...item, content: revised, artifactHash: textHash(revised),
    ownerDecision: '已按你指定的范围做局部修改，并核对其余原文逐字一致。',
    reviewerSummary: '修改已完成本地差异核对，内容请在当前版本中审阅。',
    localTextRevision: { requestMessageId: saved.id, previousMessageId: source.id, baseMessageId: item.localTextRevision?.baseMessageId ?? source.id, baseArtifactHash: item.localTextRevision?.baseArtifactHash ?? item.artifactHash },
  }
  const revision = { ...delivery, localTextRevisionOf: source.id, items: delivery.items.map(entry => entry === item ? revisedItem : entry) }
  appendOwnerManagementMessage({ projectId, ...(taskId ? { taskId } : {}), eventId: `owner-delivery:${grant.grantId}:${ownerExecutionHash(revision)}`,
    role: 'assistant', kind: 'delivery', content: '已按你的指定做局部修改，其余内容和同批成果已保留。请审阅修订后的版本。',
    goalRevision: input.expectedGoalRevision, delivery: revision })
  return saved
}


/** 从最新交付中取出仍绑定原命令验收证据的本地修订，旧成果作为来源保留。 */
export function readOwnerLocalTextRevision(projectId: string, taskId: string | null, grantId: string, stepKey: string, baseArtifactHash: string): OwnerManagementDeliveryItem | null {
  const db = store.getProjectDb()
  const row = db.prepare(`SELECT m.id FROM project_owner_management_messages m, json_each(m.payload, '$.delivery.items') item
    WHERE m.project_id=? AND json_extract(m.payload,'$.taskId') IS ? AND json_extract(m.payload,'$.kind')='delivery'
      AND json_extract(item.value,'$.stepKey')=? ORDER BY m.rowid DESC LIMIT 1`).get(projectId, taskId, stepKey) as { id: string } | undefined
  const current = row ? getOwnerManagementMessage(projectId, row.id) : null
  const item = current?.delivery?.items.find(entry => entry.stepKey === stepKey)
  const amendment = item?.localTextRevision
  if (!item || !amendment || amendment.baseArtifactHash !== baseArtifactHash) return null
  // 只有用户认可过准确的新版本，才可把本地差异当成后继任务的依据。
  const approved = db.prepare(`SELECT m.id FROM project_owner_management_messages m JOIN project_owner_management_messages d
    ON d.id=json_extract(m.payload,'$.deliveryReference.messageId') AND d.project_id=m.project_id
    JOIN json_each(d.payload,'$.delivery.items') entry
    WHERE m.project_id=? AND json_extract(m.payload,'$.taskId') IS ? AND json_extract(m.payload,'$.localTextAction')=1
      AND json_extract(m.payload,'$.deliveryReviewDecision')='accepted' AND json_extract(m.payload,'$.deliveryReference.artifactHash')=?
      AND json_extract(entry.value,'$.stepKey')=? AND json_extract(entry.value,'$.artifactHash')=?
      AND json_extract(entry.value,'$.localTextRevision.requestMessageId')=? LIMIT 1`)
    .get(projectId, taskId, item.artifactHash, stepKey, item.artifactHash, amendment.requestMessageId)
  if (!approved) return null
  const base = getOwnerManagementMessage(projectId, amendment.baseMessageId)
  const previous = getOwnerManagementMessage(projectId, amendment.previousMessageId)
  const request = getOwnerManagementMessage(projectId, amendment.requestMessageId)
  const previousItem = previous?.delivery?.items.find(entry => entry.stepKey === stepKey)
  const rule = request?.kind === 'conversation' && request.role === 'user' && request.localTextAction ? parseOwnerLocalTextEdit(request.content) : null
  if (!base?.delivery || base.eventId !== `owner-delivery:${grantId}:${ownerExecutionHash(base.delivery)}`
    || (base.taskId ?? null) !== taskId || (previous?.taskId ?? null) !== taskId || (request?.taskId ?? null) !== taskId
    || !base.delivery.items.some(entry => entry.stepKey === stepKey && entry.artifactHash === baseArtifactHash && !entry.localTextRevision)
    || !previousItem || (previousItem.localTextRevision
      ? previousItem.localTextRevision.baseMessageId !== amendment.baseMessageId || previousItem.localTextRevision.baseArtifactHash !== baseArtifactHash
      : previous?.id !== base.id || previousItem.artifactHash !== baseArtifactHash)
    || request?.deliveryReference?.messageId !== previous?.id || request?.deliveryReference?.artifactHash !== previousItem.artifactHash
    || !rule || applyOwnerLocalTextEdit(previousItem.content, rule) !== item.content) return null
  return item
}
