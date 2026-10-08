/** Owner计划附属版本：只保存/确认内容，不产生任务、执行、授权或模型调用。 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  ProjectOwnerGoalDraft, ProjectOwnerPlanDraft, ProjectOwnerPlanningContext,
  ProjectOwnerPlanSources, ProjectOwnerRoleAdvice,
} from '@gravitas/shared'
import { getWorkflowIdentityDirectoryPath } from './config-paths'
import { getProjectOwnerGoalDraft, listProjectOwnerGoalHistory } from './project-owner-goal-service'
import { parseProjectOwnerPlanProposal } from './project-owner-planning'
import { getProjectOwnerRoleAdviceCatalog } from './project-owner-role-catalog'
import { getOwnerPlanningRunReceipt, verifyGeneratedOwnerPlan } from './project-owner-planning-run-service'
import { readOwnerPlanningSnapshot, resolveOwnerPlanningTask } from './project-owner-planning-source'
import { parseProjectOwnerPlanningResponse } from './project-owner-planning-protocol'
import { getProject, getProjectDb, getTask } from './project-sqlite-store'

export class ProjectOwnerPlanConflictError extends Error {
  constructor() { super('目标或计划来源已更新，请加载最新版本并比较后重试'); this.name = 'ProjectOwnerPlanConflictError' }
}
interface PlanRow { revision: number; payload: string }

function record(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new Error('Owner 计划必须是 JSON 对象')
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new Error('Owner 计划存在未知字段')
  return input as Record<string, unknown>
}
function text(input: unknown, label: string, max = 2000, allowEmpty = false): string {
  if (typeof input !== 'string' || (!allowEmpty && !input.trim()) || input.length > max) throw new Error(`Owner ${label}格式无效或长度超限`)
  return input
}
function positive(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) throw new Error('Owner 计划版本无效')
  return input
}
function digest(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) throw new Error('Owner 计划来源指纹无效')
  return input
}
function subjectKey(taskId?: string): string { return taskId === undefined ? 'project' : `task:${taskId}` }
function fingerprint(goal: ProjectOwnerGoalDraft, sources: ProjectOwnerPlanSources): string {
  return createHash('sha256').update(JSON.stringify({ goalRevision: goal.revision, goal: goal.goal, sources })).digest('hex')
}
function planFingerprint(plan: Pick<ProjectOwnerPlanDraft, 'planVersion' | 'goalRevision' | 'contextFingerprint' | 'proposal'>): string {
  return createHash('sha256').update(JSON.stringify({ planVersion: plan.planVersion, goalRevision: plan.goalRevision,
    contextFingerprint: plan.contextFingerprint, proposal: plan.proposal })).digest('hex')
}
function requireGoal(projectId: string, taskId?: string): ProjectOwnerGoalDraft {
  const goal = getProjectOwnerGoalDraft(projectId, taskId)
  if (!goal) throw new Error('请先保存 Owner 目标草案')
  return goal
}

/** 只读取当前目标、项目/任务元信息与岗位模板摘要；不读取文件、密钥或外部资料。 */
export function getProjectOwnerPlanningContext(projectId: string, taskId?: string): ProjectOwnerPlanningContext {
  const goal = requireGoal(projectId, taskId)
  const project = getProject(projectId)!
  const task = taskId === undefined ? undefined : getTask(taskId)!
  const sources: ProjectOwnerPlanSources = {
    project: { id: project.id, title: text(project.title, '项目标题'), description: text(project.description, '项目说明', 12000, true) },
    ...(task === undefined ? {} : { task: { id: task.id, projectId: task.projectId, title: text(task.title, '任务标题'), description: text(task.description, '任务说明', 12000, true) } }),
    roles: getProjectOwnerRoleAdviceCatalog(),
  }
  return { goal, sources, fingerprint: fingerprint(goal, sources) }
}

function parseSources(input: unknown, projectId: string, taskId?: string): ProjectOwnerPlanSources {
  const value = record(input, ['project', 'task', 'roles'])
  const p = record(value.project, ['id', 'title', 'description'])
  if (p.id !== projectId) throw new Error('Owner 计划项目来源不匹配')
  const project = { id: projectId, title: text(p.title, '项目标题'), description: text(p.description, '项目说明', 12000, true) }
  let task: ProjectOwnerPlanSources['task']
  if (taskId === undefined) {
    if (value.task !== undefined) throw new Error('Owner 项目计划夹带任务来源')
  } else {
    const t = record(value.task, ['id', 'projectId', 'title', 'description'])
    if (t.id !== taskId || t.projectId !== projectId) throw new Error('Owner 计划任务来源不匹配')
    task = { id: taskId, projectId, title: text(t.title, '任务标题'), description: text(t.description, '任务说明', 12000, true) }
  }
  if (!Array.isArray(value.roles) || value.roles.length < 1 || value.roles.length > 64) throw new Error('Owner 计划岗位来源无效')
  const roles: ProjectOwnerRoleAdvice[] = value.roles.map((inputRole) => {
    const role = record(inputRole, ['key', 'name', 'version', 'sourceSha256', 'rulesSha256'])
    const version = text(role.version, '岗位版本', 100)
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Owner 岗位版本无效')
    return { key: text(role.key, '岗位键', 200), name: text(role.name, '岗位名称', 200), version,
      sourceSha256: digest(role.sourceSha256), rulesSha256: digest(role.rulesSha256) }
  })
  if (new Set(roles.map((role) => role.key)).size !== roles.length) throw new Error('Owner 计划岗位来源重复')
  return { project, ...(task === undefined ? {} : { task }), roles }
}

/** 历史按冻结的合法目标/岗位来源解析，角色升级只使当前计划失效，不重写历史。 */
function parseRow(row: PlanRow, projectId: string, taskId: string | undefined, goals: ProjectOwnerGoalDraft[]): ProjectOwnerPlanDraft {
  try {
    const value = record(JSON.parse(row.payload), ['schemaVersion', 'projectId', 'taskId', 'revision', 'planVersion', 'goalRevision', 'goalVersion', 'state', 'actor', 'origin', 'savedAt', 'changeReason', 'contextFingerprint', 'planFingerprint', 'sources', 'proposal', 'sourceRun'])
    if (value.schemaVersion !== 1 || value.projectId !== projectId || value.taskId !== taskId
      || value.revision !== row.revision || (value.state !== 'proposed' && value.state !== 'confirmed')
      || !((value.origin === 'manual' && value.actor === 'local-user' && value.sourceRun === undefined) || (value.origin === 'generated' && value.actor === (value.state === 'confirmed' ? 'local-user' : 'system:owner-planner') && value.sourceRun !== undefined))) throw new Error('计划元信息无效')
    const revision = positive(row.revision)
    const planVersion = positive(value.planVersion)
    if (planVersion > revision) throw new Error('计划版本超过修订')
    const goalRevision = positive(value.goalRevision)
    const goalVersion = positive(value.goalVersion)
    const goal = goals.find((item) => item.revision === goalRevision && item.goal.goalVersion === goalVersion)
    if (!goal) throw new Error('绑定的历史目标不存在')
    const sources = parseSources(value.sources, projectId, taskId)
    const contextFingerprint = digest(value.contextFingerprint)
    if (contextFingerprint !== fingerprint(goal, sources)) throw new Error('计划来源指纹不匹配')
    const rawProposal = record(value.proposal, ['projectId', 'taskId', 'goalVersion', 'mode', 'summary', 'assumptions', 'risks', 'steps'])
    if (rawProposal.mode !== 'proposal_only') throw new Error('计划夹带执行模式')
    const { mode: _mode, ...proposalInput } = rawProposal
    const proposal = parseProjectOwnerPlanProposal(proposalInput, goal.goal, sources.roles.map((role) => role.key))
    const contentFingerprint = digest(value.planFingerprint)
    if (contentFingerprint !== planFingerprint({ planVersion, goalRevision, contextFingerprint, proposal })) throw new Error('计划内容指纹不匹配')
    let sourceRun: ProjectOwnerPlanDraft['sourceRun']
    if (value.origin === 'generated') { const proof = record(value.sourceRun, ['receiptId', 'executionId', 'responseHash']); sourceRun = { receiptId: digest(proof.receiptId), executionId: text(proof.executionId, 'Run身份', 128), responseHash: digest(proof.responseHash) }; verifyGeneratedOwnerPlan(sourceRun, proposal, goalRevision, contextFingerprint) }
    return { schemaVersion: 1, projectId, ...(taskId === undefined ? {} : { taskId }), revision, planVersion,
      goalRevision, goalVersion, state: value.state, actor: value.actor as ProjectOwnerPlanDraft['actor'], origin: value.origin as ProjectOwnerPlanDraft['origin'], ...(sourceRun ? { sourceRun } : {}), savedAt: positive(value.savedAt),
      changeReason: text(value.changeReason, '变更原因'), contextFingerprint, planFingerprint: contentFingerprint, sources, proposal }
  } catch { throw new Error('Owner 计划记录格式无效，请保留数据库并核查') }
}
function currentRow(projectId: string, taskId?: string): PlanRow | undefined {
  return getProjectDb().prepare(`SELECT revision, payload FROM project_owner_plan_revisions
    WHERE project_id = ? AND subject_key = ? ORDER BY revision DESC LIMIT 1`).get(projectId, subjectKey(taskId)) as PlanRow | undefined
}
function readStoredHistory(projectId: string, taskId?: string): ProjectOwnerPlanDraft[] {
  const goals = listProjectOwnerGoalHistory(projectId, taskId)
  const rows = getProjectDb().prepare(`SELECT revision, payload FROM project_owner_plan_revisions
    WHERE project_id = ? AND subject_key = ? ORDER BY revision ASC`).all(projectId, subjectKey(taskId)) as PlanRow[]
  const plans = rows.map((row) => parseRow(row, projectId, taskId, goals))
  for (const [index, plan] of plans.entries()) {
    const previous = plans[index - 1]
    let valid = plan.revision === index + 1
    if (!previous) valid &&= plan.planVersion === 1 && plan.state === 'proposed'
    else if (plan.planVersion === previous.planVersion) {
      const content = (item: ProjectOwnerPlanDraft) => {
        const { revision: _revision, state: _state, savedAt: _time, actor: _actor, ...snapshot } = item
        return JSON.stringify(snapshot)
      }
      valid &&= previous.state === 'proposed' && plan.state === 'confirmed' && content(plan) === content(previous)
    } else {
      valid &&= plan.planVersion === previous.planVersion + 1 && plan.state === 'proposed'
        && plan.goalRevision >= previous.goalRevision
        && (plan.contextFingerprint !== previous.contextFingerprint || JSON.stringify(plan.proposal) !== JSON.stringify(previous.proposal) || plan.sourceRun?.receiptId !== previous.sourceRun?.receiptId)
    }
    if (!valid) throw new Error('Owner 计划历史转换无效，请保留数据库并核查')
  }
  return plans
}
function readCurrent(context: ProjectOwnerPlanningContext): ProjectOwnerPlanDraft | null {
  const { projectId, taskId } = context.goal.goal
  const plan = readStoredHistory(projectId, taskId).at(-1)
  if (!plan) return null
  return context.fingerprint === plan.contextFingerprint ? plan : { ...plan, state: 'stale' }
}
export function getProjectOwnerPlanDraft(projectId: string, taskId?: string): ProjectOwnerPlanDraft | null {
  const goal = getProjectOwnerGoalDraft(projectId, taskId)
  if (!goal) {
    if (currentRow(projectId, taskId)) throw new Error('Owner 计划缺少关联目标，请保留数据库并核查')
    return null
  }
  return readCurrent(getProjectOwnerPlanningContext(projectId, taskId))
}
export function listProjectOwnerPlanHistory(projectId: string, taskId?: string): ProjectOwnerPlanDraft[] {
  return readStoredHistory(projectId, taskId)
}

/** 缺目录沿现有本机默认身份；存在但损坏/重复/停用不得回退成启用。 */
export function assertLocalActorEnabled(): void {
  let input: unknown
  try { input = JSON.parse(readFileSync(getWorkflowIdentityDirectoryPath(), 'utf8')) }
  catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return
    throw new Error('本机身份目录不可读，请核查后重试')
  }
  if (!input || typeof input !== 'object' || !('users' in input) || !Array.isArray(input.users)) throw new Error('本机身份目录格式无效')
  const ids = new Set<string>()
  let enabled = false
  for (const user of input.users) {
    if (!user || typeof user !== 'object' || typeof user.id !== 'string' || !user.id.trim()
      || typeof user.enabled !== 'boolean' || ids.has(user.id)) throw new Error('本机身份目录格式无效')
    ids.add(user.id)
    if (user.id === 'local-user') enabled = user.enabled
  }
  if (!enabled) throw new Error('本机操作人未启用')
}
function checkVersions(context: ProjectOwnerPlanningContext, current: ProjectOwnerPlanDraft | null, goalRevision: number, revision: number): void {
  if (!Number.isSafeInteger(goalRevision) || goalRevision < 1 || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Owner 计划修订参数无效')
  if (context.goal.revision !== goalRevision || (current?.revision ?? 0) !== revision) throw new ProjectOwnerPlanConflictError()
}
function append(plan: ProjectOwnerPlanDraft): void {
  positive(plan.revision); positive(plan.planVersion)
  getProjectDb().prepare(`INSERT INTO project_owner_plan_revisions (project_id, subject_key, revision, payload)
    VALUES (?, ?, ?, ?)`).run(plan.projectId, subjectKey(plan.taskId), plan.revision, JSON.stringify(plan))
}

/** 驱动transaction契约不返回回调值，事务外只在成功提交后交付结果。 */
function planTransaction(operation: () => ProjectOwnerPlanDraft): ProjectOwnerPlanDraft {
  let result: ProjectOwnerPlanDraft | undefined
  getProjectDb().transaction(() => { result = operation() })()
  if (!result) throw new Error('Owner 计划保存失败')
  return result
}

export function saveProjectOwnerPlanDraft(projectId: string, expectedGoalRevision: number, expectedRevision: number, input: unknown, taskId?: string): ProjectOwnerPlanDraft {
  return planTransaction(() => {
    const context = getProjectOwnerPlanningContext(projectId, taskId)
    const current = readCurrent(context)
    checkVersions(context, current, expectedGoalRevision, expectedRevision)
    assertLocalActorEnabled()
    const value = record(input, ['expectedContextFingerprint', 'summary', 'assumptions', 'risks', 'steps', 'changeReason'])
    if (digest(value.expectedContextFingerprint) !== context.fingerprint) throw new ProjectOwnerPlanConflictError()
    const changeReason = text(value.changeReason, '变更原因').trim()
    const { expectedContextFingerprint: _fingerprint, changeReason: _reason, ...proposalInput } = value
    const proposal = parseProjectOwnerPlanProposal({ ...proposalInput, projectId, ...(taskId === undefined ? {} : { taskId }), goalVersion: context.goal.goal.goalVersion }, context.goal.goal, context.sources.roles.map((role) => role.key))
    if (current && current.state !== 'stale' && JSON.stringify(current.proposal) === JSON.stringify(proposal)) return current
    const plan: ProjectOwnerPlanDraft = { schemaVersion: 1, projectId, ...(taskId === undefined ? {} : { taskId }), revision: expectedRevision + 1,
      planVersion: (current?.planVersion ?? 0) + 1, goalRevision: context.goal.revision, goalVersion: context.goal.goal.goalVersion,
      state: 'proposed', actor: 'local-user', origin: 'manual', savedAt: Date.now(), changeReason,
      contextFingerprint: context.fingerprint, planFingerprint: planFingerprint({ planVersion: (current?.planVersion ?? 0) + 1, goalRevision: context.goal.revision, contextFingerprint: context.fingerprint, proposal }), sources: context.sources, proposal }
    append(plan)
    return plan
  })
}

/** 内容确认与执行授权严格分离。没有Model/Task/Execution/Pilot服务依赖或事件。 */
export function confirmProjectOwnerPlanDraft(projectId: string, expectedGoalRevision: number, expectedRevision: number, taskId?: string): ProjectOwnerPlanDraft {
  return planTransaction(() => {
    const context = getProjectOwnerPlanningContext(projectId, taskId)
    const current = readCurrent(context)
    checkVersions(context, current, expectedGoalRevision, expectedRevision)
    assertLocalActorEnabled()
    if (!current) throw new Error('请先保存 Owner 计划提案')
    if (current.state === 'stale') throw new ProjectOwnerPlanConflictError()
    if (current.state === 'confirmed') return current
    const confirmed: ProjectOwnerPlanDraft = { ...current, revision: current.revision + 1, state: 'confirmed', actor: 'local-user', savedAt: Date.now() }
    append(confirmed)
    return confirmed
  })
}

/** 内部可信Run入口，不注册IPC；原文解析+历史反查+双CAS，不接受客户端proposal/actor/origin。 */
export function appendGeneratedOwnerPlan(receiptId: string): ProjectOwnerPlanDraft {
  return planTransaction(() => {
    const receipt = getOwnerPlanningRunReceipt(receiptId)
    if (!receipt?.validTerminal || receipt.stopped || receipt.error) throw new Error('Owner没有可生成提案的可信终态')
    const execution = getProjectDb().prepare('SELECT status FROM agent_executions WHERE id = ?').get(receipt.executionId) as { status: string } | undefined
    if (execution?.status !== 'running') throw new Error('Owner生成提案仅允许当前运行中的可信Run')
    if (getProjectDb().prepare('SELECT execution_id FROM project_owner_planning_stop_requests WHERE execution_id = ?').get(receipt.executionId)) throw new Error('Owner已经请求停止，不允许从旧回执生成提案')
    const frozen = readOwnerPlanningSnapshot(receipt.planningTaskId)
    if (!frozen) throw new Error('Owner规划来源缺失')
    const currentSource = resolveOwnerPlanningTask(receipt.planningTaskId)
    if (!currentSource || receipt.linkId !== frozen.link.id || receipt.executionId !== (getProjectDb().prepare('SELECT execution_id FROM controlled_task_preparations WHERE task_id = ?').get(receipt.planningTaskId) as { execution_id: string | null } | undefined)?.execution_id) throw new Error('Owner Run身份已变化')
    const context = getProjectOwnerPlanningContext(receipt.projectId, frozen.link.targetTaskId)
    const current = readCurrent(context)
    checkVersions(context, current, frozen.link.goalRevision, frozen.link.planRevision)
    assertLocalActorEnabled()
    const response = parseProjectOwnerPlanningResponse(receipt.responseText, frozen.context)
    if (response.kind !== 'plan_proposal') throw new Error('Owner澄清不是计划提案')
    const planVersion = (current?.planVersion ?? 0) + 1
    const plan: ProjectOwnerPlanDraft = { schemaVersion: 1, projectId: receipt.projectId, ...(frozen.link.targetTaskId === undefined ? {} : { taskId: frozen.link.targetTaskId }), revision: frozen.link.planRevision + 1, planVersion, goalRevision: frozen.link.goalRevision, goalVersion: frozen.link.goalVersion, state: 'proposed', actor: 'system:owner-planner', origin: 'generated', sourceRun: { receiptId, executionId: receipt.executionId, responseHash: receipt.responseHash }, savedAt: Date.now(), changeReason: '可信规划Run生成新提案；待人工内容确认', contextFingerprint: context.fingerprint, planFingerprint: planFingerprint({ planVersion, goalRevision: frozen.link.goalRevision, contextFingerprint: context.fingerprint, proposal: response.proposal }), sources: context.sources, proposal: response.proposal }
    verifyGeneratedOwnerPlan(plan.sourceRun!, plan.proposal, plan.goalRevision, plan.contextFingerprint)
    append(plan)
    return plan
  })
}
