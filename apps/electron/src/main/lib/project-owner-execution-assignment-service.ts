import { requestOwnerManagementWake } from './project-owner-management-events'
import { createHash, randomUUID } from 'node:crypto'
import { getAgentProviderProtocol, type OwnerExecutionAssignmentInput, type OwnerExecutionAssignmentRunView, type OwnerPlanningLink, type ProjectOwnerGoalSubject } from '@gravitas/shared'
import { getChannelById } from './channel-manager'
import { prepareControlledTask } from './controlled-project-task-service'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { getCurrentOwnerExecutionAssignmentContext } from './project-owner-execution-assignment-context-service'
import { resolveOwnerPlanningTask } from './project-owner-planning-source'
import { buildOwnerExecutionAssignmentRequest } from './project-owner-execution-assignment-protocol'
import { parseOwnerExecutionSubject } from './project-owner-execution-source'
import { listOwnerPlanningRuns } from './project-owner-runtime-ipc'
import * as store from './project-sqlite-store'

interface LinkRow { id: string; project_id: string; request_id: string; planning_task_id: string; input_hash: string; payload: string; source_snapshot: string | null; assignment_snapshot: string | null }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Owner安排请求含无效或未授权字段')
  return value as Record<string, unknown>
}
function text(value: unknown, name: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value !== value.trim()) throw new Error(`Owner安排${name}无效`)
  return value
}
function revision(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Owner安排来源版本无效')
  return value
}
function assignmentInput(raw: unknown): OwnerExecutionAssignmentInput {
  const value = object(raw, ['requestId', 'expectedBindingRevision', 'expectedGoalRevision', 'expectedPlanRevision', 'expectedPlanFingerprint', 'expectedContextFingerprint', 'feedback'])
  const requestId = text(value.requestId, '请求ID')
  const expectedPlanFingerprint = text(value.expectedPlanFingerprint, '计划指纹')
  const expectedContextFingerprint = text(value.expectedContextFingerprint, '来源指纹')
  if (!/^[a-f0-9]{64}$/.test(expectedPlanFingerprint) || !/^[a-f0-9]{64}$/.test(expectedContextFingerprint)) throw new Error('Owner安排指纹格式无效')
  const feedback = value.feedback
  if (feedback !== undefined && (typeof feedback !== 'string' || feedback.trim() !== feedback || feedback.length > 2000)) throw new Error('Owner安排修改意见无效')
  return {
    requestId,
    expectedBindingRevision: revision(value.expectedBindingRevision, 1),
    expectedGoalRevision: revision(value.expectedGoalRevision, 1),
    expectedPlanRevision: revision(value.expectedPlanRevision, 1),
    expectedPlanFingerprint,
    expectedContextFingerprint,
    ...(feedback ? { feedback } : {}),
  }
}
function protocol(binding: { channelId: string; modelId: string }): { version: OwnerPlanningLink['protocolVersion']; reasoning?: 'low' } {
  const channel = getChannelById(binding.channelId)
  if (!channel?.enabled) throw new Error('Owner人员安排模型渠道不可用')
  if (channel.provider === 'zhipu' && /^glm-5\.3(?:-flash)?$/i.test(binding.modelId)) return { version: '5', reasoning: 'low' }
  if (binding.modelId === 'deepseek-flash' && getAgentProviderProtocol(channel.provider, 'ai-sdk') === 'openai-chat') return { version: '4' }
  return { version: '2' }
}
function verifyExisting(row: LinkRow, input: OwnerExecutionAssignmentInput, inputHash: string, contextJson: string, sourceJson: string, promptHash: string, carrierId: string, workspaceId: string): OwnerPlanningLink {
  if (row.input_hash !== inputHash || row.assignment_snapshot !== contextJson || row.source_snapshot !== sourceJson) throw new Error('同一Owner安排请求ID已用于其他来源，保留原件核查')
  const value = JSON.parse(row.payload) as Record<string, unknown>
  const task = store.getTask(row.planning_task_id)
  const preparation = store.getProjectDb().prepare('SELECT owner_planning_link_id FROM controlled_task_preparations WHERE task_id = ?').get(row.planning_task_id) as { owner_planning_link_id: string | null } | undefined
  if (value.id !== row.id || value.projectId !== row.project_id || value.requestId !== input.requestId || value.planningTaskId !== row.planning_task_id || value.purpose !== 'owner_execution_assignment'
    || value.assignmentContextFingerprint !== JSON.parse(contextJson).contextFingerprint || value.promptHash !== promptHash
    || !task || task.projectId !== row.project_id || task.workspaceId !== workspaceId || task.assignee?.userId !== `agent-${carrierId}`
    || !['paused', 'pending', 'in_progress', 'completed', 'failed', 'cancelled', 'stale'].includes(task.status) || preparation?.owner_planning_link_id !== row.id) throw new Error('已存在的Owner安排准备记录不一致，请保留原件核查')
  return value as unknown as OwnerPlanningLink
}
export function prepareOwnerExecutionAssignment(rawSubject: unknown, rawInput: unknown): OwnerPlanningLink {
  assertLocalActorEnabled()
  const subject = parseOwnerExecutionSubject(rawSubject)
  const input = assignmentInput(rawInput)
  const previousSnapshot = store.getProjectDb().prepare('SELECT assignment_snapshot FROM project_owner_planning_links WHERE project_id=? AND request_id=?').get(subject.projectId, input.requestId) as { assignment_snapshot: string | null } | undefined
  const version = previousSnapshot?.assignment_snapshot ? (JSON.parse(previousSnapshot.assignment_snapshot) as import('@gravitas/shared').OwnerExecutionAssignmentContext).teamContractVersion ?? 1 : 3
  const source = getCurrentOwnerExecutionAssignmentContext(subject, input, version)
  const request = buildOwnerExecutionAssignmentRequest(source.context)
  const protocolInfo = protocol(source.binding)
  const linkId = randomUUID()
  const link: OwnerPlanningLink = {
    schemaVersion: 1, id: linkId, projectId: subject.projectId, requestId: input.requestId, planningTaskId: '',
    ...(subject.taskId === undefined ? {} : { targetTaskId: subject.taskId }),
    bindingRevision: source.binding.revision, goalRevision: source.planningContext.goal.revision,
    goalVersion: source.planningContext.goal.goal.goalVersion, planRevision: source.plan.revision,
    contextFingerprint: source.planningContext.fingerprint, carrierFingerprint: source.binding.carrierFingerprint,
    protocolVersion: protocolInfo.version, ...(protocolInfo.reasoning ? { reasoningEffort: protocolInfo.reasoning } : {}),
    assignmentProtocolVersion: '2',
    promptHash: hash(request), purpose: 'owner_execution_assignment', assignmentContextFingerprint: source.context.contextFingerprint,
    maxRequests: 1, maxOutputTokens: 8192, createdAt: Date.now(),
  }
  const inputHash = hash({ projectId: subject.projectId, requestId: input.requestId, taskId: subject.taskId, bindingRevision: link.bindingRevision, goalRevision: link.goalRevision, planRevision: link.planRevision, contextFingerprint: link.contextFingerprint, planFingerprint: source.plan.planFingerprint, assignmentContextFingerprint: source.context.contextFingerprint })
  const sourceJson = JSON.stringify(source.planningContext)
  const assignmentJson = JSON.stringify(source.context)
  const db = store.getProjectDb()
  let saved: OwnerPlanningLink | undefined
  db.transaction(() => {
    assertLocalActorEnabled()
    const current = getCurrentOwnerExecutionAssignmentContext(subject, input, version)
    if (current.context.contextFingerprint !== source.context.contextFingerprint || current.binding.revision !== source.binding.revision) throw new Error('Owner安排来源已更新，请重新读取')
    const existing = db.prepare('SELECT * FROM project_owner_planning_links WHERE project_id = ? AND request_id = ?').get(subject.projectId, input.requestId) as LinkRow | undefined
    if (existing) {
      saved = verifyExisting(existing, input, inputHash, assignmentJson, sourceJson, link.promptHash, source.binding.carrierId, source.binding.workspaceId)
      return
    }
    const active = db.prepare("SELECT e.id FROM project_owner_planning_links l JOIN agent_executions e ON e.entity_type = 'task' AND e.entity_id = l.planning_task_id WHERE l.project_id = ? AND json_extract(l.payload, '$.purpose') = 'owner_execution_assignment' AND json_extract(l.payload, '$.targetTaskId') IS ? AND e.status IN ('queued', 'running') LIMIT 1").get(subject.projectId, subject.taskId ?? null)
    if (active) throw new Error('Owner已有执行安排请求正在运行，请等待当前结果后再调整')
    const prepared = prepareControlledTask({ requestId: `owner-execution-assignment:${input.requestId}`, projectId: subject.projectId, employeeId: source.binding.carrierId, workspaceId: source.binding.workspaceId, title: `Owner安排：${source.context.projectTitle}`.slice(0, 200), description: '仅提出计划步骤范围、工作区、执行方式、执行人员与独立评审建议；不会授权或派工。', priority: 'medium' })
    link.planningTaskId = prepared.taskId
    const collision = db.prepare('SELECT id FROM project_owner_planning_links WHERE project_id = ? AND request_id = ?').get(subject.projectId, input.requestId)
    if (collision) throw new Error('Owner安排请求已被并发准备，请重新读取')
    db.prepare('INSERT INTO project_owner_planning_links (id, project_id, request_id, planning_task_id, input_hash, payload, source_snapshot, assignment_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(link.id, link.projectId, link.requestId, link.planningTaskId, inputHash, JSON.stringify(link), sourceJson, assignmentJson)
    db.prepare('UPDATE controlled_task_preparations SET owner_planning_link_id = ? WHERE task_id = ?').run(link.id, link.planningTaskId)
    saved = link
  })()
  if (!saved) throw new Error('Owner安排准备未产生回执')
  requestOwnerManagementWake(subject.projectId)
  return saved
}
export function listOwnerExecutionAssignmentRuns(rawSubject: unknown): OwnerExecutionAssignmentRunView[] {
  const subject = parseOwnerExecutionSubject(rawSubject)
  return listOwnerPlanningRuns(subject.projectId, subject.taskId, 'owner_execution_assignment').flatMap(run => {
    if (run.link.purpose !== 'owner_execution_assignment') return []
    let sourceStatus: OwnerExecutionAssignmentRunView['sourceStatus'] = 'current'
    let sourceDetail: string | undefined
    try { resolveOwnerPlanningTask(run.link.planningTaskId, true) } catch (cause) { sourceStatus = 'stale'; sourceDetail = cause instanceof Error ? cause.message : '安排来源已变化，请重新核对' }
    return [{
      sourceStatus,
      ...(sourceDetail ? { sourceDetail } : {}),
      link: run.link,
      executions: run.executions,
      outcomes: run.outcomes.flatMap(outcome => outcome.state === 'needs_clarification' || outcome.state === 'replied' ? [] : [{
        executionId: outcome.executionId,
        receiptId: outcome.receiptId,
        state: outcome.state,
        detail: outcome.detail,
        ...(outcome.assignmentProposal ? { assignmentProposal: outcome.assignmentProposal } : {}),
      }]),
    }]
  })
}
