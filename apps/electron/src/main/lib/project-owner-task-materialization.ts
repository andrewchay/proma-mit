/** 同库暂停材料化；没有grant、费用、工具或执行授权。 */
import { randomUUID } from 'node:crypto'
import type { OwnerTaskMaterializationInput, OwnerTaskMaterializationPreview, OwnerTaskMaterializationRecord, OwnerTaskMaterializationView, OwnerTaskProjection, OwnerTaskStepLink, ProjectOwnerGoalSubject } from '@gravitas/shared'
import type { Task } from './project-types'
import * as store from './project-sqlite-store'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { isCompletedStatus } from './task-status-logic'
import { getOwnerExecutionPreparation, listOwnerExecutionPreparationHistory } from './project-owner-execution-preparation'
import { assertOwnerExecutionBoundaryIdle } from './project-owner-execution-preparation-evidence'
import { withPilotPolicySnapshot, getPilotPolicy } from './project-pilot-policy'
import { buildOwnerExecutionSource, OwnerExecutionPreparationConflictError, ownerExecutionHash, ownerExecutionObject, parseOwnerExecutionSubject } from './project-owner-execution-source'
import { accumulateRetainedCandidates, resolveRetainedStepReuse } from './project-owner-retained-step-reuse'
import { readLatestAcceptedArtifact } from './project-owner-accepted-artifact'

const subjectKey = (subject: ProjectOwnerGoalSubject) => subject.taskId ? `task:${subject.taskId}` : 'project'
function fail(message: string): never {
  if (/已更新|版本|已漂移|请求ID|旧预览/.test(message)) throw new OwnerExecutionPreparationConflictError(`Owner任务材料化：${message}`)
  throw new Error(`Owner任务材料化：${message}`)
}
export function parseOwnerTaskMaterializationInput(raw: unknown): OwnerTaskMaterializationInput {
  const value = ownerExecutionObject(raw, ['requestId', 'expectedMaterializationRevision', 'expectedPreparationId', 'expectedPreparationRevision', 'expectedPreparationHash', 'expectedPolicyRevision'])
  for (const key of ['requestId', 'expectedPreparationId'] as const) if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 200) fail('请求或准备ID无效')
  if (typeof value.expectedPreparationHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedPreparationHash)) fail('准备摘要无效')
  for (const key of ['expectedMaterializationRevision', 'expectedPreparationRevision', 'expectedPolicyRevision'] as const) if (!Number.isSafeInteger(value[key]) || Number(value[key]) < (key === 'expectedMaterializationRevision' ? 0 : 1)) fail('版本无效')
  return value as unknown as OwnerTaskMaterializationInput
}
export function ownerTaskSpecificationHash(task: Task): string {
  // 排序/时间戳不是范围；身份、内容、权限与标记才是权威业务规格。
  return ownerExecutionHash({ id: task.id, projectId: task.projectId, parentId: task.parentId, title: task.title, description: task.description, assignee: task.assignee, assigneeMemberId: task.assigneeMemberId, workspaceId: task.workspaceId, developmentScope: task.developmentScope, permissionRequests: task.permissionRequests, tokenBudget: task.tokenBudget, priority: task.priority, startDate: task.startDate, dueDate: task.dueDate, createdByUserId: task.createdByUserId, ownerStepLinkId: task.ownerStepLinkId, controlledPreparationId: task.controlledPreparationId })
}
function readHistory(projectId: string): OwnerTaskMaterializationRecord[] {
  const database = store.getProjectDb()
  const rows = database.prepare('SELECT * FROM project_owner_task_materializations WHERE project_id=? ORDER BY revision').all(projectId) as Array<{ id: string; project_id: string; subject_key: string; target_task_id: string | null; revision: number; request_id: string; input_hash: string; payload: string; integrity_hash: string }>
  const orphan = database.prepare('SELECT l.id FROM project_owner_task_step_links l LEFT JOIN project_owner_task_materializations h ON h.id=l.materialization_id WHERE l.project_id=? AND (h.id IS NULL OR h.project_id != l.project_id) LIMIT 1').get(projectId)
  const markerOrphan = database.prepare('SELECT t.id FROM tasks t LEFT JOIN project_owner_task_step_links l ON l.id=t.owner_step_link_id WHERE t.project_id=? AND t.owner_step_link_id IS NOT NULL AND (l.id IS NULL OR l.task_id != t.id OR l.project_id != t.project_id) LIMIT 1').get(projectId)
  if (orphan || markerOrphan) fail('存在悬空关联/marker，请保留原件核查，不降为none或创建新mapping')
  let previous: string | null = null
  return rows.map((row, index) => {
    try {
      const value = ownerExecutionObject(JSON.parse(row.payload), ['schemaVersion', 'purpose', 'id', 'projectId', 'taskId', 'revision', 'actor', 'savedAt', 'stage', 'input', 'inputHash', 'preview', 'links', 'previousIntegrityHash', 'integrityHash'])
      const record = value as unknown as OwnerTaskMaterializationRecord, { integrityHash, ...body } = record
      const subject = parseOwnerExecutionSubject({ projectId: record.projectId, ...(record.taskId ? { taskId: record.taskId } : {}) }), input = parseOwnerTaskMaterializationInput(record.input)
      if (record.schemaVersion !== 1 || record.purpose !== 'owner_business_task_materialization' || record.stage !== 'paused_materialized_needs_revalidation' || record.actor !== 'local-user' || !Number.isSafeInteger(record.savedAt) || row.id !== record.id || row.project_id !== projectId || record.projectId !== projectId || row.target_task_id !== (record.taskId ?? null) || row.subject_key !== subjectKey(subject) || record.revision !== index + 1 || row.revision !== record.revision || input.expectedMaterializationRevision !== index || input.requestId !== row.request_id || row.input_hash !== record.inputHash || record.inputHash !== ownerExecutionHash({ subject, input }) || record.previousIntegrityHash !== previous || integrityHash !== row.integrity_hash || integrityHash !== ownerExecutionHash(body) || !Array.isArray(record.links) || !record.links.length) fail('历史完整性损坏')
      const { previewFingerprint, ...previewBody } = record.preview
      if (ownerExecutionHash(previewBody) !== previewFingerprint || ownerExecutionHash(record.preview.input) !== ownerExecutionHash(input) || record.preview.projectId !== projectId || record.preview.taskId !== record.taskId || record.preview.preparation.id !== input.expectedPreparationId || record.preview.preparation.integrityHash !== input.expectedPreparationHash || record.preview.preparation.revision !== input.expectedPreparationRevision || record.preview.preparation.policyRevision !== input.expectedPolicyRevision) fail('预览与来源身份不匹配')
      const indexed = database.prepare('SELECT * FROM project_owner_task_step_links WHERE materialization_id=?').all(record.id) as Array<{ id: string; project_id: string; task_id: string; subject_key: string; plan_fingerprint: string; step_key: string; payload: string; integrity_hash: string }>
      // 关联必须与投影一一对应；混合批次接替时 selectedStepKeys 会大于 projections
      // （已验收步骤被复用在旧批次里），因此这里比对 projections，并另行校验复用清单。
      if (indexed.length !== record.links.length || new Set(record.links.map(link => link.taskId)).size !== record.links.length || new Set(record.links.map(link => link.stepKey)).size !== record.links.length || ownerExecutionHash(record.links.map(link => link.stepKey).sort()) !== ownerExecutionHash(record.preview.projections.map(item => item.stepKey).sort())) fail('步骤与权威关联数量不符')
      const retained = record.preview.retainedSteps ?? []
      if (ownerExecutionHash([...record.links.map(link => link.stepKey), ...retained.map(item => item.stepKey)].sort()) !== ownerExecutionHash(record.preview.preparation.source.selectedStepKeys.slice().sort())) fail('复用步骤与所选范围不符')
      for (const link of record.links) {
        const actual = indexed.find(item => item.id === link.id), { integrityHash: linkHash, ...linkBody } = link
        if (!actual || actual.project_id !== projectId || actual.subject_key !== row.subject_key || actual.task_id !== link.taskId || actual.step_key !== link.stepKey || actual.plan_fingerprint !== record.preview.preparation.source.planFingerprint || link.materializationId !== record.id || link.projectId !== projectId || link.subjectKey !== row.subject_key || link.planFingerprint !== actual.plan_fingerprint || linkHash !== ownerExecutionHash(linkBody) || actual.integrity_hash !== linkHash || ownerExecutionHash(JSON.parse(actual.payload)) !== ownerExecutionHash(link) || ownerExecutionHash(link.projection) !== ownerExecutionHash(record.preview.projections.find(item => item.stepKey === link.stepKey))) fail('关联证据损坏，不补造任务')
      }
      previous = integrityHash
      return record
    } catch { return fail('历史/关联无效，请保留原件核查，不降级或重新创建') }
  })
}
export function listOwnerTaskMaterializationHistory(rawSubject: unknown): OwnerTaskMaterializationRecord[] {
  const subject = parseOwnerExecutionSubject(rawSubject)
  return readHistory(subject.projectId).filter(item => item.taskId === subject.taskId)
}
function edgesFor(taskId: string, projectId: string) {
  return store.listTaskDependencies(projectId).filter(edge => edge.taskId === taskId || edge.dependsOnTaskId === taskId)
}
export function getOwnerTaskMaterialization(rawSubject: unknown, renewalExpiresAt?: number): OwnerTaskMaterializationView {
  const subject = parseOwnerExecutionSubject(rawSubject), history = readHistory(subject.projectId), record = history.filter(item => item.taskId === subject.taskId).at(-1) ?? null
  if (renewalExpiresAt !== undefined && !Number.isSafeInteger(renewalExpiresAt)) fail('续期期限无效')
  if (!store.getProject(subject.projectId) || (subject.taskId && store.getTask(subject.taskId)?.projectId !== subject.projectId)) fail('目标主体不存在')
  const view: OwnerTaskMaterializationView = { revision: history.at(-1)?.revision ?? 0, materialization: record, status: record ? 'needs_revalidation' : 'none', blockers: record ? ['任务已暂停落地，执行准备需要重新验证；没有运行许可'] : [] }
  if (!record) return view
  try {
    const policy = getPilotPolicy(subject.projectId), reference = policy?.ownerExecutionPreparation, revalidation = policy?.ownerExecutionRevalidation
    let effectiveRenewalExpiresAt = renewalExpiresAt
    const original = listOwnerExecutionPreparationHistory(subject).find(item => item.id === record.input.expectedPreparationId)
    if (!original || ownerExecutionHash(original) !== ownerExecutionHash(record.preview.preparation) || policy?.state !== 'paused') fail('原Owner准备证据或策略引用已损坏/修订')
    if (revalidation) {
      // 分支(b)：policy已升级v2引用；材料化视图仍保持needs_revalidation并显式标注，不回退(a)也不伪装current。
      if (revalidation.materializationId !== record.id || revalidation.materializationIntegrityHash !== record.integrityHash) fail('v2重验证引用与当前材料化记录不匹配')
      const row = store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_execution_revalidations WHERE id=? AND project_id=?').get(revalidation.id, subject.projectId) as { payload: string; integrity_hash: string } | undefined
      const parsed = row ? JSON.parse(row.payload) as { purpose?: string; stage?: string; input?: { renewalExpiresAt?: number }; source?: { originalPreparation?: unknown; budget?: { expiresAt?: number } } } : null
      if (!row || row.integrity_hash !== revalidation.integrityHash || parsed?.purpose !== 'owner_business_execution_revalidation' || parsed?.stage !== 'paused_task_links' || JSON.stringify(parsed?.source?.originalPreparation) !== JSON.stringify({ id: original.id, revision: original.revision, integrityHash: original.integrityHash, policyRevision: original.policyRevision })) fail('v2重验证证据悬空或损坏，请保留原件核查')
      if (parsed.input?.renewalExpiresAt !== undefined && parsed.input.renewalExpiresAt !== parsed.source?.budget?.expiresAt) fail('v2续期期限与冻结预算不一致')
      effectiveRenewalExpiresAt ??= parsed.input?.renewalExpiresAt
    } else if (policy.revision !== record.input.expectedPolicyRevision || reference?.id !== original.id || reference.revision !== original.revision || reference.integrityHash !== original.integrityHash || reference.purpose !== 'owner_business_execution_preparation') {
      fail('原Owner准备证据或策略引用已损坏/修订')
    }
    if (revalidation) view.blockers = [`已被v2重新验证冻结真实任务（${revalidation.id.slice(0,8)}…）；仍不是执行许可`, ...view.blockers]
    const frozen = record.preview.preparation, effectiveInput = effectiveRenewalExpiresAt === undefined ? frozen.input : { ...frozen.input, expiresAt: effectiveRenewalExpiresAt }, current = buildOwnerExecutionSource(subject, effectiveInput)
    // 自己合法更新目标Task导致原AO05自然stale；只在此读取诊断中识别该已冻结差异，绝不改旧source或授予许可。
    // 显式续期可把当前渠道与Owner绑定写入新再验证；续期服务随后独立核对身份及其余来源，旧记录不修改。
    const comparable = effectiveRenewalExpiresAt === undefined ? current : { ...current, channelHash: frozen.source.channelHash, ownerBindingProvenance: frozen.source.ownerBindingProvenance,
      ...(current.employeeRuntimes ? { employeeRuntimes: current.employeeRuntimes.map((runtime, index) => ({ ...runtime, channelHash: frozen.source.employeeRuntimes?.[index]?.channelHash ?? runtime.channelHash })) } : {}) }
    if (ownerExecutionHash({ ...comparable, ...(subject.taskId ? { targetTaskHash: frozen.source.targetTaskHash } : {}) }) !== ownerExecutionHash(frozen.source)) fail('目标、计划、人员或资料来源已变化')
    for (const link of record.links) {
      const task = store.getTask(link.taskId)
      const statusRemainsInScope = task && (task.status === 'paused' || isCompletedStatus(task.status, store.listTaskStatuses(subject.projectId)))
      if (!task || task.projectId !== subject.projectId || task.ownerStepLinkId !== link.id || !statusRemainsInScope || ownerTaskSpecificationHash(task) !== link.taskSpecificationHash || ownerExecutionHash(edgesFor(task.id, subject.projectId).map(({ id, taskId, dependsOnTaskId, type }) => ({ id, taskId, dependsOnTaskId, type })).sort((a,b) => a.id.localeCompare(b.id))) !== ownerExecutionHash(link.dependencies.slice().sort((a,b) => a.id.localeCompare(b.id)))) fail('权威任务或依赖已变化，不能沿用关联')
    }
    return view
  } catch (error) { return { ...view, status: 'stale', blockers: [error instanceof Error ? error.message : 'Owner来源无法核验', ...view.blockers] } }
}
/** 供重验证模块反查；沿用readHistory同一套完整性/orphan口径，不另造两套校验。 */
export function getOwnerTaskMaterializationRecord(projectId: string, id: string): OwnerTaskMaterializationRecord {
  const record = readHistory(projectId).find(item => item.id === id)
  if (!record || record.projectId !== projectId) fail('材料化记录不存在或不属于当前项目')
  return record
}
/**
 * 从本主体历次旧材料化里找出「已验收且规格未变」的步骤。
 *
 * 只读：不写库、不改旧记录。旧任务与旧 link 原样保留，
 * 新批次据此跳过这些步骤，避免重复派工与重复计费。
 *
 * 复用必须建立在**可核验的验收证据**上，而不是任务状态：
 * 只看 completed 会把「人工标记完成」也当成已验收。
 *
 * 必须累积**所有**历史批次而不是只看最近一次：连续两次恢复时，
 * 第一次恢复的记录只含当时失败的步骤，只看它会让更早已验收的步骤重新派工。
 *
 * 但累积不能只做「有验收就覆盖」：同一 stepKey 的新任务若**没有**通过验收
 * （重做失败、被拒、证据损坏），它已经取代了旧任务，旧候选必须一并失效，
 * 否则会用一份已被替换的旧成果去跳过本该重做的步骤。
 *
 * 任一环节无法核验时该步骤不可复用——宁可重做，也不接受来源不明的复用。
 */
/**
 * 把目标硬要求中由该步骤承接的部分并入验收标准。
 *
 * 为什么必须在材料化时并入：Reviewer 的检查清单来自 task 的 `acceptanceCriteria`。
 * 如果「打印后为一页」只写在目标里、没进任何步骤的标准，整条验收链都不会检查它——
 * 这正是「原需求写了一页、原验收数组漏了它、交付成了两页」的成因。
 *
 * 只并入关键项：advisory 项留给评审自行判断，避免把提示性要求变成硬门槛。
 * 用原文而非改写：验收标准必须能从目标逐字追溯，改述会掩盖偏差。
 */
function withTracedCriteria(
  step: { key: string; acceptanceCriteria: string[] },
  trace: ReadonlyArray<{ sourceText: string; stepKey: string; criticality: 'critical' | 'advisory' }> | undefined,
): string[] {
  if (!trace?.length) return step.acceptanceCriteria
  const traced = trace
    .filter((item) => item.stepKey === step.key && item.criticality === 'critical')
    .map((item) => item.sourceText.trim())
    .filter((text) => text && !step.acceptanceCriteria.includes(text))
  // 去重后保持「步骤原有标准在前、目标硬要求在后」，评审按原顺序逐项判断。
  return traced.length ? [...step.acceptanceCriteria, ...new Set(traced)] : step.acceptanceCriteria
}

function resolveRetainedSteps(
  subject: ProjectOwnerGoalSubject,
  selectedSteps: ReadonlyArray<{ key: string; title: string; outcome: string; acceptanceCriteria: string[]; roleKey: string; deliveryKind?: 'text' | 'development'; dependencies: readonly string[] }>,
  /** 本次材料化所依据的目标版本；旧批次的目标版本不同说明用户明确改了要求。 */
  currentGoalRevision: number,
): OwnerTaskMaterializationPreview['retainedSteps'] {
  // 只在同一目标版本内谈复用。用户改了目标就代表要不同的东西，
  // 即便新计划的步骤文本与旧的一致，旧成果也不该被当作已满足新目标——
  // 否则「改目标」会变成静默空操作：重新规划、确认、然后材料化时全部复用旧成果。
  const priorRecords = readHistory(subject.projectId)
    .filter(record => record.taskId === subject.taskId && record.preview.preparation.source.goalRevision === currentGoalRevision)
  if (!priorRecords.length) return []
  // 每个批次产出该批的步骤出现；「是否通过验收」交给累积函数统一裁决，
  // 避免这里再写一遍「失败要不要回退」的规则。
  const artifactsByTask = new Map<string, string>()
  const batches = priorRecords.map((record) => record.links.map((link) => {
    const task = store.getTask(link.taskId)
    // 任务与旧 link 绑定被破坏时，这一批的该步骤无法追溯；按未验收处理。
    const bound = Boolean(task) && task!.projectId === subject.projectId && task!.ownerStepLinkId === link.id
    // 证据链先于状态：没有 accepted 决定与已核验成果，completed 也不构成复用依据。
    const accepted = bound ? readLatestAcceptedArtifact(subject.projectId, link.taskId) : null
    const valid = Boolean(accepted) && accepted!.stepLinkId === link.id
    if (valid) artifactsByTask.set(link.taskId, accepted!.artifactHash)
    return {
      taskId: link.taskId,
      stepKey: link.stepKey,
      accepted: valid,
      title: link.projection.title,
      outcome: link.projection.outcome,
      acceptanceCriteria: link.projection.acceptanceCriteria,
      roleKey: link.projection.roleKey,
      ...(link.projection.deliveryKind ? { deliveryKind: link.projection.deliveryKind } : {}),
    }
  }))
  const candidates = accumulateRetainedCandidates(batches)
  if (!candidates.length) return []
  const reuse = resolveRetainedStepReuse(
    selectedSteps.map(step => ({
      key: step.key, title: step.title, outcome: step.outcome,
      acceptanceCriteria: step.acceptanceCriteria, roleKey: step.roleKey,
      ...(step.deliveryKind ? { deliveryKind: step.deliveryKind } : {}),
    })),
    candidates,
  ).reuse
  if (!reuse.length) return []
  const byStepKey = new Map(candidates.map(candidate => [candidate.stepKey, candidate]))
  return reuse.map(({ stepKey }) => {
    const candidate = byStepKey.get(stepKey)!
    // 记录谁依赖它：这些下游步骤启动时要把该成果作为上游交接带入。
    const dependedOnBy = selectedSteps.filter(step => step.dependencies.includes(stepKey)).map(step => step.key)
    // 成果哈希来自该任务通过验收时的记录；累积阶段已保证只有验收成立的任务会留下。
    return { stepKey, taskId: candidate.taskId, artifactHash: artifactsByTask.get(candidate.taskId)!, dependedOnBy }
  })
}

function currentPreview(subject: ProjectOwnerGoalSubject, input: OwnerTaskMaterializationInput): OwnerTaskMaterializationPreview {
  assertLocalActorEnabled()
  const history = readHistory(subject.projectId)
  if ((history.at(-1)?.revision ?? 0) !== input.expectedMaterializationRevision) fail('材料化版本已更新')
  const priorRecords = history.filter(record => record.taskId === subject.taskId)
  const view = getOwnerExecutionPreparation(subject), preparation = view.preparation
  if (!preparation || view.status !== 'current' || preparation.id !== input.expectedPreparationId || preparation.revision !== input.expectedPreparationRevision || preparation.integrityHash !== input.expectedPreparationHash || preparation.policyRevision !== input.expectedPolicyRevision) fail('准备或目标已更新，请重新预览')
  assertOwnerExecutionBoundaryIdle(subject.projectId)
  const currentPolicy = getPilotPolicy(subject.projectId)
  if (currentPolicy?.state !== 'paused' || currentPolicy.ownerExecutionPreparation?.purpose !== 'owner_business_execution_preparation') fail('必须为原Owner暂停准备策略')
  const source = preparation.source
  if (priorRecords.some(record => record.preview.preparation.source.planFingerprint === source.planFingerprint)) fail('相同计划已材料化，不能重复创建')
  for (const record of priorRecords) for (const link of record.links) {
    const task = store.getTask(link.taskId)
    if (!task || task.projectId !== subject.projectId || task.ownerStepLinkId !== link.id) fail('旧材料化任务或标记缺失/损坏，保留历史，不补造')
  }
  const selectedSteps = source.plan.proposal.steps.filter(step => source.selectedStepKeys.includes(step.key))
  if (selectedSteps.length !== source.selectedStepKeys.length) fail('冻结步骤缺失')
  // 混合批次接替：已验收且规格未变的步骤不再进入新批次。
  // 若原样重建，「A 已验收、B 失败」的恢复会给 A 建一个全新的可派发任务并再次计费。
  const retainedSteps = resolveRetainedSteps(subject, selectedSteps, source.goalRevision) ?? []
  const retainedKeys = new Set(retainedSteps.map(step => step.stepKey))
  const steps = selectedSteps.filter(step => !retainedKeys.has(step.key))
  if (!steps.length) fail('所选步骤的成果均已验收，没有需要重做的步骤；请直接交付或调整方案')
  let target: Task | null = null
  if (subject.taskId) {
    if (steps.length !== 1 || steps[0]!.dependencies.length) fail('单任务首片仅支持无步骤依赖的一步，不自动拆子任务或合并')
    target = priorRecords.length ? null : store.getTask(subject.taskId)
    if (!priorRecords.length && (!target || !['pending', 'paused'].includes(target.status) || target.parentId || store.getProjectDb().prepare('SELECT id FROM tasks WHERE id=? AND controlled_preparation_id IS NOT NULL').get(target.id) || store.hasOwnerPlanningTaskEvidence(target.id) || store.hasOwnerBusinessTaskEvidence(target.id) || store.listAgentExecutionsByEntity('task', target.id).length || store.listExecutionSubTasks(target.id).length || store.listTasks(subject.projectId, { includeSubTasks: true }).some(task => task.parentId === target!.id) || edgesFor(target.id, subject.projectId).length)) fail('目标已有执行、用途、层级或依赖，不能自动接管')
    if (!priorRecords.length && target) {
      const control = store.getProjectDb().prepare('SELECT id FROM controlled_task_preparations WHERE task_id=? LIMIT 1').get(target.id)
      const chain = store.getProjectDb().prepare('SELECT payload FROM project_chain_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1').get(subject.projectId) as { payload: string } | undefined
      if (control || (chain && JSON.stringify(JSON.parse(chain.payload)).includes(JSON.stringify(target.id)))) fail('目标已有受控准备或交付/协作证据，须原流程重确认')
    }
  }
  const projections: OwnerTaskProjection[] = steps.map(step => {
    const stepExecutor = source.roleAssignments?.find((assignment) => assignment.roleKey === step.roleKey)?.employee ?? source.executor
    const criteria = withTracedCriteria(step, source.plan.proposal.criteriaTrace)
    return { stepKey: step.key, ...(target ? { targetTaskId: target.id } : {}), title: target?.title ?? step.title, description: target?.description ?? `${step.outcome}\n\n验收标准：\n${criteria.map(item => `- ${item}`).join('\n')}`, roleKey: step.roleKey, ...(step.deliveryKind ? { deliveryKind: step.deliveryKind } : {}), outcome: step.outcome, acceptanceCriteria: criteria, dependencies: step.dependencies.filter(key => !retainedKeys.has(key)), assignee: { userId: `agent-${stepExecutor.id}`, displayName: stepExecutor.name }, workspaceId: source.workspaceId, ...(source.developmentScope && step.deliveryKind !== 'text' ? { developmentScope: source.developmentScope } : {}), ...(target ? { clearAssigneeMemberId: true as const, previous: { status: target.status, assignee: target.assignee, assigneeMemberId: target.assigneeMemberId, workspaceId: target.workspaceId, developmentScope: target.developmentScope } } : {}) }
  })
  const body = { ...subject, input, preparation, projections, ...(target ? { targetTaskHash: ownerExecutionHash(target), targetDependenciesHash: ownerExecutionHash(edgesFor(target.id, subject.projectId)) } : {}), ...(retainedSteps.length ? { retainedSteps } : {}) }
  return { ...body, previewFingerprint: ownerExecutionHash(body) }
}
export function previewOwnerTaskMaterialization(rawSubject: unknown, rawInput: unknown): OwnerTaskMaterializationPreview {
  return currentPreview(parseOwnerExecutionSubject(rawSubject), parseOwnerTaskMaterializationInput(rawInput))
}
export function materializeOwnerTasks(rawSubject: unknown, rawInput: unknown, fingerprint: unknown): OwnerTaskMaterializationRecord {
  const subject = parseOwnerExecutionSubject(rawSubject), input = parseOwnerTaskMaterializationInput(rawInput), database = store.getProjectDb()
  assertLocalActorEnabled()
  if (database.isTransactionActive()) fail('拒绝未提交外层事务')
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) fail('预览摘要无效')
  const inputHash = ownerExecutionHash({ subject, input }), history = readHistory(subject.projectId), prior = history.find(item => item.input.requestId === input.requestId)
  if (prior) {
    if (prior.inputHash !== inputHash || prior.preview.previewFingerprint !== fingerprint) fail('请求ID已用于不同输入或预览')
    // 读取历史幂等结果不沿用其许可，缺失/漂移的实体不能补造。
    for (const link of prior.links) if (!store.getTask(link.taskId) || store.getTask(link.taskId)?.ownerStepLinkId !== link.id) fail('已提交权威任务缺失或标记损坏，保留原件，不补造')
    return prior
  }
  return withPilotPolicySnapshot(subject.projectId, input.expectedPolicyRevision, () => {
    let saved: OwnerTaskMaterializationRecord | null = null
    database.transaction(() => {
    const preview = currentPreview(subject, input)
    if (preview.previewFingerprint !== fingerprint) fail('旧预览已更新')
    const id = randomUUID(), links: OwnerTaskStepLink[] = preview.projections.map(projection => ({ id: randomUUID(), materializationId: id, projectId: subject.projectId, subjectKey: subjectKey(subject), planFingerprint: preview.preparation.source.planFingerprint, stepKey: projection.stepKey, taskId: projection.targetTaskId ?? randomUUID(), kind: projection.targetTaskId ? 'existing_target' : 'created', projection, taskSpecificationHash: 'pending', dependencies: [], integrityHash: 'pending' }))
    const staged: OwnerTaskMaterializationRecord = { ...subject, schemaVersion: 1, purpose: 'owner_business_task_materialization', id, revision: input.expectedMaterializationRevision + 1, actor: 'local-user', savedAt: Date.now(), stage: 'paused_materialized_needs_revalidation', input, inputHash, preview, links, previousIntegrityHash: history.at(-1)?.integrityHash ?? null, integrityHash: 'pending' }
    database.prepare('INSERT INTO project_owner_task_materializations(id,project_id,subject_key,target_task_id,revision,request_id,input_hash,payload,integrity_hash) VALUES(?,?,?,?,?,?,?,?,?)').run(id,subject.projectId,subjectKey(subject),subject.taskId ?? null,staged.revision,input.requestId,inputHash,JSON.stringify(staged),'pending')
    for (const link of links) database.prepare('INSERT INTO project_owner_task_step_links(id,materialization_id,project_id,subject_key,plan_fingerprint,step_key,task_id,payload,integrity_hash) VALUES(?,?,?,?,?,?,?,?,?)').run(link.id,id,subject.projectId,link.subjectKey,link.planFingerprint,link.stepKey,link.taskId,JSON.stringify(link),'pending')
    store.withOwnerTaskMaterializationBuild(id, () => {
    for (const link of links) store.materializePausedOwnerTask(link.id)
    for (const link of links) for (const key of link.projection.dependencies) {
      const upstream = links.find(item => item.stepKey === key)
      if (!upstream) fail('依赖不在本次闭包')
      store.materializeOwnerTaskDependency(link.id, upstream.id)
    }
    })
    for (const link of links) {
      const task = store.getTask(link.taskId)!
      link.taskSpecificationHash = ownerTaskSpecificationHash(task)
      link.dependencies = edgesFor(task.id,subject.projectId).map(({ id, taskId, dependsOnTaskId, type }) => ({ id, taskId, dependsOnTaskId, type }))
      const { integrityHash: _hash, ...body } = link
      link.integrityHash = ownerExecutionHash(body)
      database.prepare('UPDATE project_owner_task_step_links SET payload=?,integrity_hash=? WHERE id=?').run(JSON.stringify(link),link.integrityHash,link.id)
    }
    const { integrityHash: _hash, ...body } = staged
    staged.integrityHash = ownerExecutionHash(body)
    database.prepare('UPDATE project_owner_task_materializations SET payload=?,integrity_hash=? WHERE id=?').run(JSON.stringify(staged),staged.integrityHash,id)
    store.recordProjectActivity({ projectId: subject.projectId, entityType: 'task', entityId: links[0]!.taskId, action: 'updated', summary: 'Owner步骤已落为暂停任务，尚无执行许可', actor: 'local-user', payload: { materializationId: id, taskIds: links.map(link => link.taskId) } })
    saved = readHistory(subject.projectId).at(-1)!
    })()
    if (!saved) fail('事务未保存结果')
    return saved
  })
}
