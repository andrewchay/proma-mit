/** Owner职责与受控载体分离。A阶段只追加配置/暂停准备，不开放任何模型调用。 */
import { createHash, randomUUID } from 'node:crypto'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getChannelById } from './channel-manager'
import { validateControlledTarget } from './agent-controlled-context'
import { hasProjectWorkspaceBinding } from './project-workspace-bindings'
import { assertLocalActorEnabled, getProjectOwnerPlanDraft, getProjectOwnerPlanningContext } from './project-owner-plan-service'
import { buildProjectOwnerPlanningRequest } from './project-owner-planning-protocol'
import { prepareControlledTask } from './controlled-project-task-service'
import * as store from './project-sqlite-store'
import type { OwnerPlanningLink, OwnerRuntimeBinding } from '@gravitas/shared'
export type { OwnerPlanningLink, OwnerRuntimeBinding } from '@gravitas/shared'
interface BindingRow { revision: number; payload: string }
interface LinkRow { id: string; project_id: string; request_id: string; planning_task_id: string; input_hash: string; payload: string; source_snapshot: string | null }
const hash = (input: unknown): string => createHash('sha256').update(JSON.stringify(input)).digest('hex')
function object(input: unknown, fields: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).some(key => !fields.includes(key))) throw new Error('Owner请求格式无效或夹带身份/权限字段')
  return input as Record<string, unknown>
}
function text(input: unknown, label: string, max = 200): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max) throw new Error(`Owner${label}无效`)
  return input.trim()
}
function revision(input: unknown, minimum = 0): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum) throw new Error('Owner版本无效')
  return input
}
function digest(input: unknown): string { const value = text(input, '指纹'); if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Owner指纹无效'); return value }
function project(projectId: string): void { text(projectId, '项目ID', 128); if (!store.getProject(projectId)) throw new Error('Owner项目不存在') }
function transaction<T>(run: () => T): T {
  let result: T | undefined
  store.getProjectDb().transaction(() => { result = run() })()
  if (result === undefined) throw new Error('Owner事务未产生回执')
  return result
}
export function getOwnerCarrierFacts(projectId: string, carrierId: string, workspaceId: string) {
  project(projectId)
  const employee = store.getAgentEmployee(carrierId)
  if (!employee?.enabled || employee.executionProfile !== 'controlled' || employee.runtime !== 'ai-sdk') throw new Error('Owner载体必须是已启用的AI SDK受控员工')
  const target = validateControlledTarget(employee, workspaceId, { getChannel: getChannelById, getWorkspace: getAgentWorkspace })
  if (!hasProjectWorkspaceBinding(projectId, workspaceId)) throw new Error('Owner工作区未明确绑定项目')
  const channel = getChannelById(employee.channelId)!
  const workspace = getAgentWorkspace(workspaceId)!
  // 配置只保存指纹，不落渠道凭据或工作区路径。全配置变化需要重新绑定。
  return { channelId: channel.id, modelId: target.modelId, runtime: 'ai-sdk' as const, carrierFingerprint: hash({ employee, channel, workspace }) }
}
function parseBinding(payload: string, projectId: string, expectedRevision: number): OwnerRuntimeBinding {
  try {
    const value = object(JSON.parse(payload), ['schemaVersion', 'projectId', 'revision', 'ownerRole', 'ownerName', 'carrierId', 'workspaceId', 'channelId', 'modelId', 'runtime', 'carrierFingerprint', 'actor', 'savedAt', 'changeReason'])
    if (value.schemaVersion !== 1 || value.projectId !== projectId || value.revision !== expectedRevision || value.ownerRole !== 'project_owner' || value.actor !== 'local-user' || value.runtime !== 'ai-sdk') throw new Error('配置身份不匹配')
    return { schemaVersion: 1, projectId, revision: revision(value.revision, 1), ownerRole: 'project_owner', ownerName: text(value.ownerName, '职责名称'), carrierId: text(value.carrierId, '载体ID', 128), workspaceId: text(value.workspaceId, '工作区ID', 128), channelId: text(value.channelId, '渠道ID', 128), modelId: text(value.modelId, '模型ID'), runtime: 'ai-sdk', carrierFingerprint: digest(value.carrierFingerprint), actor: 'local-user', savedAt: revision(value.savedAt, 1), changeReason: text(value.changeReason, '变更原因', 2000) }
  } catch { throw new Error('Owner配置记录无效，请保留数据库核查') }
}
export function getOwnerRuntimeBinding(projectId: string, atRevision?: number): OwnerRuntimeBinding | null {
  project(projectId)
  const rows = store.getProjectDb().prepare('SELECT revision, payload FROM project_owner_runtime_revisions WHERE project_id = ? ORDER BY revision').all(projectId) as BindingRow[]
  const versions = rows.map((row, index) => parseBinding(row.payload, projectId, index + 1))
  if (rows.some((row, index) => row.revision !== index + 1)) throw new Error('Owner配置记录历史不连续')
  return (atRevision === undefined ? versions.at(-1) : versions.find(version => version.revision === revision(atRevision, 1))) ?? null
}
export function saveOwnerRuntimeBinding(projectId: string, expectedRevision: number, raw: unknown): OwnerRuntimeBinding {
  const input = object(raw, ['ownerName', 'carrierId', 'workspaceId', 'changeReason'])
  const ownerName = text(input.ownerName, '职责名称'), carrierId = text(input.carrierId, '载体ID', 128), workspaceId = text(input.workspaceId, '工作区ID', 128), changeReason = text(input.changeReason, '变更原因', 2000)
  revision(expectedRevision)
  return transaction(() => {
    assertLocalActorEnabled()
    const current = getOwnerRuntimeBinding(projectId)
    if ((current?.revision ?? 0) !== expectedRevision) throw new Error('Owner绑定已更新，请比较后重试')
    const facts = getOwnerCarrierFacts(projectId, carrierId, workspaceId)
    const result: OwnerRuntimeBinding = { schemaVersion: 1, projectId, revision: expectedRevision + 1, ownerRole: 'project_owner', ownerName, carrierId, workspaceId, ...facts, actor: 'local-user', savedAt: Date.now(), changeReason }
    store.getProjectDb().prepare('INSERT INTO project_owner_runtime_revisions (project_id, revision, payload) VALUES (?, ?, ?)').run(projectId, result.revision, JSON.stringify(result))
    return result
  })
}
export function prepareOwnerPlanning(projectId: string, raw: unknown): OwnerPlanningLink {
  const input = object(raw, ['requestId', 'taskId', 'expectedBindingRevision', 'expectedGoalRevision', 'expectedPlanRevision', 'expectedContextFingerprint'])
  const requestId = text(input.requestId, '请求ID', 128)
  const taskId = input.taskId === undefined ? undefined : text(input.taskId, '目标任务ID', 128)
  const bindingRevision = revision(input.expectedBindingRevision, 1), goalRevision = revision(input.expectedGoalRevision, 1), planRevision = revision(input.expectedPlanRevision)
  const contextFingerprint = digest(input.expectedContextFingerprint)
  const inputHash = hash({ projectId, requestId, taskId, bindingRevision, goalRevision, planRevision, contextFingerprint })
  return transaction(() => {
    assertLocalActorEnabled()
    const binding = getOwnerRuntimeBinding(projectId)
    if (!binding) throw new Error('请先明确Owner与规划载体绑定')
    const facts = getOwnerCarrierFacts(projectId, binding.carrierId, binding.workspaceId)
    if (taskId && (store.getProjectDb().prepare('SELECT id FROM project_owner_planning_links WHERE planning_task_id = ?').get(taskId)
      || store.getProjectDb().prepare('SELECT owner_planning_link_id FROM controlled_task_preparations WHERE task_id = ? AND owner_planning_link_id IS NOT NULL').get(taskId))) throw new Error('Owner规划承载任务不能作为目标业务任务再次规划')
    const context = getProjectOwnerPlanningContext(projectId, taskId)
    const plan = getProjectOwnerPlanDraft(projectId, taskId)
    if (binding.revision !== bindingRevision || context.goal.revision !== goalRevision || context.fingerprint !== contextFingerprint || (plan?.revision ?? 0) !== planRevision || hash(facts) !== hash({ channelId: binding.channelId, modelId: binding.modelId, runtime: binding.runtime, carrierFingerprint: binding.carrierFingerprint })) throw new Error('Owner目标、来源、计划或载体配置已更新，请重新确认')
    const request = buildProjectOwnerPlanningRequest(context)
    const makeLink = (id: string, planningTaskId: string, createdAt: number): OwnerPlanningLink => ({ schemaVersion: 1, id, projectId, requestId, planningTaskId, ...(taskId === undefined ? {} : { targetTaskId: taskId }), bindingRevision, goalRevision, goalVersion: context.goal.goal.goalVersion, planRevision, contextFingerprint, carrierFingerprint: facts.carrierFingerprint, protocolVersion: '1', promptHash: hash(request), purpose: 'owner_planning', maxRequests: 1, maxOutputTokens: 4096, createdAt })
    const existing = store.getProjectDb().prepare('SELECT * FROM project_owner_planning_links WHERE project_id = ? AND request_id = ?').get(projectId, requestId) as LinkRow | undefined
    if (existing) {
      let value: OwnerPlanningLink
      try {
        const candidate = JSON.parse(existing.payload) as Record<string, unknown>
        const expected = makeLink(text(existing.id, '关联ID', 128), text(existing.planning_task_id, '规划任务ID', 128), revision(candidate.createdAt, 1))
        object(candidate, Object.keys(expected))
        if (Object.keys(candidate).length !== Object.keys(expected).length || Object.entries(expected).some(([key, item]) => candidate[key] !== item)) throw new Error('关联内容不一致')
        value = expected
      } catch { throw new Error('Owner规划准备记录格式无效，请保留数据库核查') }
      const task = store.getTask(existing.planning_task_id)
      const receipt = store.getProjectDb().prepare('SELECT owner_planning_link_id FROM controlled_task_preparations WHERE task_id = ?').get(existing.planning_task_id) as { owner_planning_link_id: string } | undefined
      if (existing.input_hash !== inputHash || value.id !== existing.id || value.projectId !== projectId || value.planningTaskId !== existing.planning_task_id || value.purpose !== 'owner_planning' || !task || task.projectId !== projectId || task.workspaceId !== binding.workspaceId || task.assignee?.userId !== `agent-${binding.carrierId}` || task.status !== 'paused' || receipt?.owner_planning_link_id !== existing.id) throw new Error('Owner规划准备记录不一致，不自动重新创建')
      if (existing.source_snapshot === null) {
        // 旧A准备只有指纹。仅在全部来源/版本仍当前且未授权启动时显式重试准备补齐快照。
        const authorization = store.getProjectDb().prepare('SELECT execution_id FROM controlled_task_preparations WHERE task_id = ?').get(value.planningTaskId) as { execution_id: string | null }
        if (authorization.execution_id) throw new Error('旧Owner规划准备已关联执行，不能补造发送资料')
        store.getProjectDb().prepare('UPDATE project_owner_planning_links SET source_snapshot = ? WHERE id = ? AND source_snapshot IS NULL').run(JSON.stringify(context), value.id)
      } else if (existing.source_snapshot !== JSON.stringify(context)) throw new Error('Owner规划资料快照记录损坏')
      return value
    }
    const id = randomUUID()
    const prepared = prepareControlledTask({ requestId: `owner-planning:${id}`, projectId, employeeId: binding.carrierId, workspaceId: binding.workspaceId, title: `Owner规划：${context.sources.task?.title ?? context.sources.project.title}`.slice(0, 200), description: '仅提出目标规划/必要澄清；不计作目标业务任务交付，不自动组织员工，不授权业务执行。', priority: 'medium' })
    const result = makeLink(id, prepared.taskId, Date.now())
    store.getProjectDb().prepare('INSERT INTO project_owner_planning_links (id, project_id, request_id, planning_task_id, input_hash, payload, source_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, projectId, requestId, prepared.taskId, inputHash, JSON.stringify(result), JSON.stringify(context))
    store.getProjectDb().prepare('UPDATE controlled_task_preparations SET owner_planning_link_id = ? WHERE task_id = ?').run(id, prepared.taskId)
    return result
  })
}
