/** Owner职责与受控载体分离。A阶段只追加配置/暂停准备，不开放任何模型调用。 */
import { withOwnerConversationContext } from './project-owner-management-conversation'
import { recordOwnerManagementBinding } from './project-owner-management-store'
import { createHash, randomUUID } from 'node:crypto'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getChannelById, listChannels } from './channel-manager'
import { validateControlledTarget } from './agent-controlled-context'
import { hasProjectWorkspaceBinding, listProjectWorkspaceBindings } from './project-workspace-bindings'
import { assertLocalActorEnabled, getProjectOwnerPlanDraft, getProjectOwnerPlanningContext } from './project-owner-plan-service'
import { buildProjectOwnerPlanningRequest, resolveProjectOwnerPlanningRequest } from './project-owner-planning-protocol'
import { prepareControlledTask } from './controlled-project-task-service'
import * as store from './project-sqlite-store'
import { getSettings } from './settings-service'
import { getPilotReviewedPriceEvidenceForModel } from './project-pilot-request-evidence'
import { getAgentProviderProtocol, type OwnerPlanningLink, type OwnerRuntimeBinding, type ProjectWorkspaceBinding } from '@gravitas/shared'
export type { OwnerPlanningLink, OwnerRuntimeBinding } from '@gravitas/shared'
const DEFAULT_OWNER_MODEL_ID = 'glm-5.3-flash'
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
function chooseOwnerModel(channels: ReturnType<typeof listChannels>, settings: ReturnType<typeof getSettings>): { channelId: string; modelId: string; configured: boolean } | null {
  const eligible = channels.filter(channel => channel.enabled && getAgentProviderProtocol(channel.provider, 'ai-sdk') === 'openai-chat')
  const supported = (channel: typeof eligible[number], modelId: string) => {
    const price = getPilotReviewedPriceEvidenceForModel(modelId, 'openai')
    return channel.enabled && Boolean(price && price.maxModelOutputTokens >= 8192)
  }
  const defaultOwnerChannel = [...eligible].filter(channel => channel.provider === 'zhipu'
    && channel.models.some(model => model.enabled && model.id === DEFAULT_OWNER_MODEL_ID && supported(channel, model.id)))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0]
  if (defaultOwnerChannel) return {
    channelId: defaultOwnerChannel.id,
    modelId: DEFAULT_OWNER_MODEL_ID,
    configured: defaultOwnerChannel.id === settings.agentChannelId && DEFAULT_OWNER_MODEL_ID === settings.agentModelId,
  }
  const configured = settings.agentChannelId && settings.agentModelId
    ? eligible.find(channel => channel.id === settings.agentChannelId)?.models.find(model => model.enabled && model.id === settings.agentModelId)
      ? { channelId: settings.agentChannelId, modelId: settings.agentModelId, configured: true }
      : undefined
    : undefined
  const configuredChannel = configured && eligible.find(item => item.id === configured.channelId)
  if (configured && configuredChannel && supported(configuredChannel, configured.modelId)) return configured
  // Owner默认只绑定产品约定模型。其他模型必须由用户明确选定，
  // 避免因渠道更新时间或列表顺序变化而静默切换 Provider。
  return null
}
/** 既有绑定刷新配置指纹时保留模型身份，不借刷新切换Provider。 */
function chooseBoundOwnerModel(binding: OwnerRuntimeBinding): { channelId: string; modelId: string } | null {
  const channel = getChannelById(binding.channelId)
  if (!channel?.enabled || getAgentProviderProtocol(channel.provider, 'ai-sdk') !== 'openai-chat'
    || !channel.models.some(model => model.enabled && model.id === binding.modelId)) return null
  return { channelId: binding.channelId, modelId: binding.modelId }
}
function chooseOwnerWorkspace(bindings: ProjectWorkspaceBinding[], preferredId?: string): ProjectWorkspaceBinding | undefined {
  return bindings.find(binding => binding.workspaceId === preferredId)
    ?? [...bindings].sort((left, right) => right.createdAt - left.createdAt || left.workspaceId.localeCompare(right.workspaceId))[0]
}
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
  // 配置只保存指纹，不落渠道凭据或工作区路径。旧指纹保留兼容；新配置另存排除运行统计的稳定指纹。
  const { totalTasks: _totalTasks, completedTasks: _completedTasks, avgDurationMs: _avgDurationMs, failureCount: _failureCount, updatedAt: _updatedAt, ...employeeConfiguration } = employee
  return {
    channelId: channel.id,
    modelId: target.modelId,
    runtime: 'ai-sdk' as const,
    carrierFingerprint: hash({ employee, channel, workspace }),
    carrierConfigurationFingerprint: hash({ employee: employeeConfiguration, channel, workspace }),
  }
}
export function ownerCarrierBindingMatches(binding: OwnerRuntimeBinding, facts: ReturnType<typeof getOwnerCarrierFacts>): boolean {
  if (binding.channelId !== facts.channelId || binding.modelId !== facts.modelId || binding.runtime !== facts.runtime) return false
  return binding.carrierConfigurationFingerprint
    ? binding.carrierConfigurationFingerprint === facts.carrierConfigurationFingerprint
    : binding.carrierFingerprint === facts.carrierFingerprint
}
function parseBinding(payload: string, projectId: string, expectedRevision: number): OwnerRuntimeBinding {
  try {
    const value = object(JSON.parse(payload), ['schemaVersion', 'projectId', 'revision', 'ownerRole', 'ownerName', 'carrierId', 'workspaceId', 'channelId', 'modelId', 'runtime', 'carrierFingerprint', 'carrierConfigurationFingerprint', 'actor', 'savedAt', 'changeReason'])
    if (value.schemaVersion !== 1 || value.projectId !== projectId || value.revision !== expectedRevision || value.ownerRole !== 'project_owner' || !['local-user', 'system:owner-manager'].includes(String(value.actor)) || value.runtime !== 'ai-sdk') throw new Error('配置身份不匹配')
    return { schemaVersion: 1, projectId, revision: revision(value.revision, 1), ownerRole: 'project_owner', ownerName: text(value.ownerName, '职责名称'), carrierId: text(value.carrierId, '载体ID', 128), workspaceId: text(value.workspaceId, '工作区ID', 128), channelId: text(value.channelId, '渠道ID', 128), modelId: text(value.modelId, '模型ID'), runtime: 'ai-sdk', carrierFingerprint: digest(value.carrierFingerprint), ...(value.carrierConfigurationFingerprint === undefined ? {} : { carrierConfigurationFingerprint: digest(value.carrierConfigurationFingerprint) }), actor: value.actor as OwnerRuntimeBinding['actor'], savedAt: revision(value.savedAt, 1), changeReason: text(value.changeReason, '变更原因', 2000) }
  } catch { throw new Error('Owner配置记录无效，请保留数据库核查') }
}
export function getOwnerRuntimeBinding(projectId: string, atRevision?: number): OwnerRuntimeBinding | null {
  project(projectId)
  const rows = store.getProjectDb().prepare('SELECT revision, payload FROM project_owner_runtime_revisions WHERE project_id = ? ORDER BY revision').all(projectId) as BindingRow[]
  const versions = rows.map((row, index) => parseBinding(row.payload, projectId, index + 1))
  if (rows.some((row, index) => row.revision !== index + 1)) throw new Error('Owner配置记录历史不连续')
  return (atRevision === undefined ? versions.at(-1) : versions.find(version => version.revision === revision(atRevision, 1))) ?? null
}
/** 历史管理载体仍属于Owner身份，不能当作业务员工或独立评审员复用。 */
export function getOwnerRuntimeCarrierIds(): ReadonlySet<string> {
  const rows = store.getProjectDb().prepare('SELECT project_id, revision, payload FROM project_owner_runtime_revisions').all() as Array<{ project_id: string; revision: number; payload: string }>
  return new Set(rows.map(row => parseBinding(row.payload, row.project_id, row.revision).carrierId))
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
    recordOwnerManagementBinding(projectId, result.revision)
    return result
  })
}

/** 用应用已配置模型与项目既有授权初始化Owner专属本地载体；不发送请求或新增工作区授权。 */
export function resolveOwnerRuntimeBindingFromDefaults(projectId: string): OwnerRuntimeBinding | null {
  project(projectId)
  const existing = getOwnerRuntimeBinding(projectId)
  if (existing) {
    let currentFacts: ReturnType<typeof getOwnerCarrierFacts>
    try { currentFacts = getOwnerCarrierFacts(projectId, existing.carrierId, existing.workspaceId) }
    catch { return existing }
    if (ownerCarrierBindingMatches(existing, currentFacts)) return existing
    // 不修改原员工；Owner绑定失效时只在同一项目工作区建立新的内部规划载体。
    const active = store.getProjectDb().prepare(`SELECT 1 AS active FROM project_owner_planning_links l
      JOIN agent_executions e ON e.entity_type = 'task' AND e.entity_id = l.planning_task_id
      WHERE l.project_id = ? AND e.status IN ('queued', 'running') LIMIT 1`).get(projectId)
    if (active) throw new Error('Owner上一条请求仍在排队或运行，已暂停配置刷新；请先核对运行状态')
    const model = chooseBoundOwnerModel(existing)
    const workspace = getAgentWorkspace(existing.workspaceId)
    if (!model || !workspace || !listProjectWorkspaceBindings(projectId).some(item => item.workspaceId === existing.workspaceId)) return existing
    return transaction(() => {
      const latest = getOwnerRuntimeBinding(projectId)
      if (!latest || latest.revision !== existing.revision) throw new Error('Owner绑定已更新，请重新核对当前授权')
      const latestActive = store.getProjectDb().prepare(`SELECT 1 AS active FROM project_owner_planning_links l
        JOIN agent_executions e ON e.entity_type = 'task' AND e.entity_id = l.planning_task_id
        WHERE l.project_id = ? AND e.status IN ('queued', 'running') LIMIT 1`).get(projectId)
      if (latestActive) throw new Error('Owner上一条请求仍在排队或运行，已暂停配置刷新；请先核对运行状态')
      const latestModel = chooseBoundOwnerModel(existing)
      if (!latestModel || latestModel.channelId !== model.channelId || latestModel.modelId !== model.modelId
        || !listProjectWorkspaceBindings(projectId).some(item => item.workspaceId === existing.workspaceId)) throw new Error('Owner模型或项目工作区授权刚刚变化，请重新核对')
      const carrier = store.createAgentEmployee({
        name: `Owner运行载体 · ${projectId.slice(0, 8)}`,
        role: '项目Owner运行载体',
        description: '系统内部载体：承载项目Owner的受控规划调用；不负责或授权业务执行。',
        runtime: 'ai-sdk', channelId: latestModel.channelId, modelId: latestModel.modelId,
        workspaceIds: [existing.workspaceId], executionProfile: 'controlled', permissionMode: 'safe',
      })
      const facts = getOwnerCarrierFacts(projectId, carrier.id, existing.workspaceId)
      const result: OwnerRuntimeBinding = {
        schemaVersion: 1, projectId, revision: existing.revision + 1, ownerRole: 'project_owner', ownerName: existing.ownerName,
        carrierId: carrier.id, workspaceId: existing.workspaceId, ...facts, actor: 'system:owner-manager',
        savedAt: Date.now(), changeReason: 'Owner内部模型配置已刷新；沿用原项目授权工作区，旧管理授权需由用户重新确认',
      }
      store.getProjectDb().prepare('INSERT INTO project_owner_runtime_revisions (project_id, revision, payload) VALUES (?, ?, ?)').run(projectId, result.revision, JSON.stringify(result))
      recordOwnerManagementBinding(projectId, result.revision)
      return result
    })
  }
  const settings = getSettings({ strictRead: true })
  const model = chooseOwnerModel(listChannels(), settings)
  if (!model) return null

  const workspaceBindings = listProjectWorkspaceBindings(projectId)
  const selectedWorkspace = chooseOwnerWorkspace(workspaceBindings, settings.agentWorkspaceId)
  if (!selectedWorkspace) return null

  return transaction(() => {
    const current = getOwnerRuntimeBinding(projectId)
    if (current) return current
    const latestSettings = getSettings({ strictRead: true })
    const latestModel = chooseOwnerModel(listChannels(), latestSettings)
    if (!latestModel || latestModel.channelId !== model.channelId || latestModel.modelId !== model.modelId) throw new Error('Owner默认模型或渠道已变化，请重新准备')
    const latestWorkspace = chooseOwnerWorkspace(listProjectWorkspaceBindings(projectId), latestSettings.agentWorkspaceId)
    if (latestWorkspace?.workspaceId !== selectedWorkspace.workspaceId) throw new Error('Owner项目工作区授权或默认项已变化，请重新准备')
    const workspace = getAgentWorkspace(selectedWorkspace.workspaceId)
    if (!workspace) return null
    const carrier = store.createAgentEmployee({
      name: `Owner运行载体 · ${projectId.slice(0, 8)}`,
      role: '项目Owner运行载体',
      description: '系统内部载体：承载项目Owner的受控规划调用；不负责或授权业务执行。',
      runtime: 'ai-sdk', channelId: model.channelId, modelId: model.modelId,
      workspaceIds: [workspace.id], executionProfile: 'controlled', permissionMode: 'safe',
    })
    const facts = getOwnerCarrierFacts(projectId, carrier.id, workspace.id)
    const result: OwnerRuntimeBinding = {
      schemaVersion: 1, projectId, revision: 1, ownerRole: 'project_owner', ownerName: '项目Owner',
      carrierId: carrier.id, workspaceId: workspace.id, ...facts, actor: 'system:owner-manager',
      savedAt: Date.now(), changeReason: model.modelId === DEFAULT_OWNER_MODEL_ID
        ? '按Owner默认模型绑定GLM-5.3-Flash与项目已授权工作区；仅建立Owner规划载体，不触发模型请求'
        : '复用本应用已配置模型与项目已授权工作区；仅建立Owner规划载体，不触发模型请求',
    }
    store.getProjectDb().prepare('INSERT INTO project_owner_runtime_revisions (project_id, revision, payload) VALUES (?, ?, ?)').run(projectId, 1, JSON.stringify(result))
    recordOwnerManagementBinding(projectId, result.revision)
    return result
  })
}

export function prepareOwnerPlanning(projectId: string, raw: unknown): OwnerPlanningLink {
  const input = object(raw, ['requestId', 'taskId', 'expectedBindingRevision', 'expectedGoalRevision', 'expectedPlanRevision', 'expectedContextFingerprint', 'conversationMessageId'])
  const requestId = text(input.requestId, '请求ID', 128)
  const taskId = input.taskId === undefined ? undefined : text(input.taskId, '目标任务ID', 128)
  const conversationMessageId = input.conversationMessageId === undefined ? undefined : text(input.conversationMessageId, '对话消息ID', 128)
  const bindingRevision = revision(input.expectedBindingRevision, 1), goalRevision = revision(input.expectedGoalRevision, 1), planRevision = revision(input.expectedPlanRevision)
  const contextFingerprint = digest(input.expectedContextFingerprint)
  const inputHash = hash({ projectId, requestId, taskId, bindingRevision, goalRevision, planRevision, contextFingerprint, ...(conversationMessageId ? { conversationMessageId } : {}) })
  return transaction(() => {
    assertLocalActorEnabled()
    const binding = getOwnerRuntimeBinding(projectId)
    if (!binding) throw new Error('请先明确Owner与规划载体绑定')
    const facts = getOwnerCarrierFacts(projectId, binding.carrierId, binding.workspaceId)
    if (taskId && (store.getProjectDb().prepare('SELECT id FROM project_owner_planning_links WHERE planning_task_id = ?').get(taskId)
      || store.getProjectDb().prepare('SELECT owner_planning_link_id FROM controlled_task_preparations WHERE task_id = ? AND owner_planning_link_id IS NOT NULL').get(taskId))) throw new Error('Owner规划承载任务不能作为目标业务任务再次规划')
    const existingSnapshot = store.getProjectDb().prepare('SELECT source_snapshot FROM project_owner_planning_links WHERE project_id = ? AND request_id = ?').get(projectId, requestId) as { source_snapshot: string | null } | undefined
    const existingConversation = existingSnapshot?.source_snapshot ? (JSON.parse(existingSnapshot.source_snapshot) as import('@gravitas/shared').ProjectOwnerPlanningContext).conversation : undefined
    const historyThroughMessageId = existingConversation?.historyThroughMessageId
    const baseContext = getProjectOwnerPlanningContext(projectId, taskId)
    const context = conversationMessageId ? withOwnerConversationContext(baseContext, conversationMessageId, historyThroughMessageId, existingConversation ? existingConversation.interactionVersion ?? 1 : 2, existingConversation ? existingConversation.deliveryReview?.version ?? 0 : 1, existingConversation ? existingConversation.observationMessageBindingVersion ?? 0 : 1) : baseContext
    const plan = getProjectOwnerPlanDraft(projectId, taskId)
    if (binding.revision !== bindingRevision || context.goal.revision !== goalRevision || context.fingerprint !== contextFingerprint || (plan?.revision ?? 0) !== planRevision || !ownerCarrierBindingMatches(binding, facts)) throw new Error('Owner目标、来源、计划或载体配置已更新，请重新确认')
    let request = buildProjectOwnerPlanningRequest(context)
    const useLowGlmReasoning = getChannelById(binding.channelId)?.provider === 'zhipu' && /^glm-5\.3(?:-flash)?$/i.test(binding.modelId)
    const makeLink = (id: string, planningTaskId: string, createdAt: number, protocolVersion: OwnerPlanningLink['protocolVersion'] = '2'): OwnerPlanningLink => ({ schemaVersion: 1, id, projectId, requestId, planningTaskId, ...(taskId === undefined ? {} : { targetTaskId: taskId }), ...(conversationMessageId ? { conversationMessageId } : {}), bindingRevision, goalRevision, goalVersion: context.goal.goal.goalVersion, planRevision, contextFingerprint, carrierFingerprint: facts.carrierFingerprint, protocolVersion, ...((protocolVersion === '3' || protocolVersion === '5') ? { reasoningEffort: 'low' as const } : {}), promptHash: hash(request), purpose: 'owner_planning', maxRequests: 1, maxOutputTokens: protocolVersion === '1' ? 4096 : 8192, createdAt })
    const existing = store.getProjectDb().prepare('SELECT * FROM project_owner_planning_links WHERE project_id = ? AND request_id = ?').get(projectId, requestId) as LinkRow | undefined
    if (existing) {
      let value: OwnerPlanningLink
      try {
        const candidate = JSON.parse(existing.payload) as Record<string, unknown>
        if (candidate.protocolVersion !== '1' && candidate.protocolVersion !== '2' && candidate.protocolVersion !== '3' && candidate.protocolVersion !== '4' && candidate.protocolVersion !== '5') throw new Error('关联协议版本无效')
        request = resolveProjectOwnerPlanningRequest(context, digest(candidate.promptHash))
        const expected = makeLink(text(existing.id, '关联ID', 128), text(existing.planning_task_id, '规划任务ID', 128), revision(candidate.createdAt, 1), candidate.protocolVersion)
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
    // 后台已准备而前台旧入口随后到达时，复用未发送的同来源管理准备。
    // 已有执行/发送占位的历史不能被当作新请求重复使用。
    const managed = store.getProjectDb().prepare("SELECT l.request_id FROM project_owner_planning_links l WHERE l.project_id = ? AND l.request_id LIKE 'management:%' AND json_extract(l.payload, '$.purpose') = 'owner_planning' AND json_extract(l.payload, '$.targetTaskId') IS ? AND json_extract(l.payload, '$.bindingRevision') = ? AND json_extract(l.payload, '$.goalRevision') = ? AND json_extract(l.payload, '$.planRevision') = ? AND json_extract(l.payload, '$.contextFingerprint') = ? AND json_extract(l.payload, '$.conversationMessageId') IS ? AND NOT EXISTS (SELECT 1 FROM agent_executions e WHERE e.entity_type = 'task' AND e.entity_id = l.planning_task_id) AND NOT EXISTS (SELECT 1 FROM project_owner_planning_admissions a WHERE a.link_id = l.id) ORDER BY l.rowid DESC LIMIT 1")
      .get(projectId, taskId ?? null, bindingRevision, goalRevision, planRevision, contextFingerprint, conversationMessageId ?? null) as { request_id: string } | undefined
    if (managed && managed.request_id !== requestId) return prepareOwnerPlanning(projectId, { ...input, requestId: managed.request_id })
    const id = randomUUID()
    const prepared = prepareControlledTask({ requestId: `owner-planning:${id}`, projectId, employeeId: binding.carrierId, workspaceId: binding.workspaceId, title: `Owner规划：${context.sources.task?.title ?? context.sources.project.title}`.slice(0, 200), description: '仅提出目标规划/必要澄清；不计作目标业务任务交付，不自动组织员工，不授权业务执行。', priority: 'medium' })
    const jsonOutput = facts.modelId === 'deepseek-flash' && getAgentProviderProtocol(getChannelById(binding.channelId)!.provider, 'ai-sdk') === 'openai-chat'
    const result = makeLink(id, prepared.taskId, Date.now(), useLowGlmReasoning ? '5' : jsonOutput ? '4' : '2')
    store.getProjectDb().prepare('INSERT INTO project_owner_planning_links (id, project_id, request_id, planning_task_id, input_hash, payload, source_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, projectId, requestId, prepared.taskId, inputHash, JSON.stringify(result), JSON.stringify(context))
    store.getProjectDb().prepare('UPDATE controlled_task_preparations SET owner_planning_link_id = ? WHERE task_id = ?').run(id, prepared.taskId)
    return result
  })
}
