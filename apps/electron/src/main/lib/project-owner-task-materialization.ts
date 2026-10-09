/** 同库暂停材料化；没有grant、费用、工具或执行授权。 */
import { randomUUID } from 'node:crypto'
import type { OwnerTaskMaterializationInput, OwnerTaskMaterializationPreview, OwnerTaskMaterializationRecord, OwnerTaskMaterializationView, OwnerTaskProjection, OwnerTaskStepLink, ProjectOwnerGoalSubject } from '@gravitas/shared'
import type { Task } from './project-types'
import * as store from './project-sqlite-store'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { getOwnerExecutionPreparation, listOwnerExecutionPreparationHistory } from './project-owner-execution-preparation'
import { assertOwnerExecutionBoundaryIdle } from './project-owner-execution-preparation-evidence'
import { withPilotPolicySnapshot, getPilotPolicy } from './project-pilot-policy'
import { buildOwnerExecutionSource, OwnerExecutionPreparationConflictError, ownerExecutionHash, ownerExecutionObject, parseOwnerExecutionSubject } from './project-owner-execution-source'

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
      if (indexed.length !== record.links.length || new Set(record.links.map(link => link.taskId)).size !== record.links.length || new Set(record.links.map(link => link.stepKey)).size !== record.links.length || ownerExecutionHash(record.links.map(link => link.stepKey).sort()) !== ownerExecutionHash(record.preview.preparation.source.selectedStepKeys.slice().sort())) fail('步骤与权威关联数量不符')
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
export function getOwnerTaskMaterialization(rawSubject: unknown): OwnerTaskMaterializationView {
  const subject = parseOwnerExecutionSubject(rawSubject), history = readHistory(subject.projectId), record = history.filter(item => item.taskId === subject.taskId).at(-1) ?? null
  if (!store.getProject(subject.projectId) || (subject.taskId && store.getTask(subject.taskId)?.projectId !== subject.projectId)) fail('目标主体不存在')
  const view: OwnerTaskMaterializationView = { revision: history.at(-1)?.revision ?? 0, materialization: record, status: record ? 'needs_revalidation' : 'none', blockers: record ? ['任务已暂停落地，执行准备需要重新验证；没有运行许可'] : [] }
  if (!record) return view
  try {
    const policy = getPilotPolicy(subject.projectId), reference = policy?.ownerExecutionPreparation
    const original = listOwnerExecutionPreparationHistory(subject).find(item => item.id === record.input.expectedPreparationId)
    if (!original || ownerExecutionHash(original) !== ownerExecutionHash(record.preview.preparation) || policy?.state !== 'paused' || policy.revision !== record.input.expectedPolicyRevision || reference?.id !== original.id || reference.revision !== original.revision || reference.integrityHash !== original.integrityHash || reference.purpose !== 'owner_business_execution_preparation') fail('原Owner准备证据或策略引用已损坏/修订')
    const frozen = record.preview.preparation, current = buildOwnerExecutionSource(subject, frozen.input)
    // 自己合法更新目标Task导致原AO05自然stale；只在此读取诊断中识别该已冻结差异，绝不改旧source或授予许可。
    if (ownerExecutionHash({ ...current, ...(subject.taskId ? { targetTaskHash: frozen.source.targetTaskHash } : {}) }) !== ownerExecutionHash(frozen.source)) fail('目标、计划、人员或资料来源已变化')
    for (const link of record.links) {
      const task = store.getTask(link.taskId)
      if (!task || task.projectId !== subject.projectId || task.ownerStepLinkId !== link.id || task.status !== 'paused' || ownerTaskSpecificationHash(task) !== link.taskSpecificationHash || ownerExecutionHash(edgesFor(task.id, subject.projectId).map(({ id, taskId, dependsOnTaskId, type }) => ({ id, taskId, dependsOnTaskId, type })).sort((a,b) => a.id.localeCompare(b.id))) !== ownerExecutionHash(link.dependencies.slice().sort((a,b) => a.id.localeCompare(b.id)))) fail('权威任务或依赖已变化，不能沿用关联')
    }
    return view
  } catch (error) { return { ...view, status: 'stale', blockers: [error instanceof Error ? error.message : 'Owner来源无法核验', ...view.blockers] } }
}
function currentPreview(subject: ProjectOwnerGoalSubject, input: OwnerTaskMaterializationInput): OwnerTaskMaterializationPreview {
  assertLocalActorEnabled()
  const history = readHistory(subject.projectId)
  if ((history.at(-1)?.revision ?? 0) !== input.expectedMaterializationRevision) fail('材料化版本已更新')
  if (history.some(record => record.taskId === subject.taskId)) fail('已有步骤关联，修订或迁移须另行确认，不重复创建')
  const view = getOwnerExecutionPreparation(subject), preparation = view.preparation
  if (!preparation || view.status !== 'current' || preparation.id !== input.expectedPreparationId || preparation.revision !== input.expectedPreparationRevision || preparation.integrityHash !== input.expectedPreparationHash || preparation.policyRevision !== input.expectedPolicyRevision) fail('准备或目标已更新，请重新预览')
  assertOwnerExecutionBoundaryIdle(subject.projectId)
  const currentPolicy = getPilotPolicy(subject.projectId)
  if (currentPolicy?.state !== 'paused' || currentPolicy.ownerExecutionPreparation?.purpose !== 'owner_business_execution_preparation') fail('必须为原Owner暂停准备策略')
  const source = preparation.source
  const steps = source.plan.proposal.steps.filter(step => source.selectedStepKeys.includes(step.key))
  if (steps.length !== source.selectedStepKeys.length) fail('冻结步骤缺失')
  let target: Task | null = null
  if (subject.taskId) {
    if (steps.length !== 1 || steps[0]!.dependencies.length) fail('单任务首片仅支持无步骤依赖的一步，不自动拆子任务或合并')
    target = store.getTask(subject.taskId)
    if (!target || !['pending', 'paused'].includes(target.status) || target.parentId || store.getProjectDb().prepare('SELECT id FROM tasks WHERE id=? AND controlled_preparation_id IS NOT NULL').get(target.id) || store.hasOwnerPlanningTaskEvidence(target.id) || store.hasOwnerBusinessTaskEvidence(target.id) || store.listAgentExecutionsByEntity('task', target.id).length || store.listExecutionSubTasks(target.id).length || store.listTasks(subject.projectId, { includeSubTasks: true }).some(task => task.parentId === target!.id) || edgesFor(target.id, subject.projectId).length) fail('目标已有执行、用途、层级或依赖，不能自动接管')
    const control = store.getProjectDb().prepare('SELECT id FROM controlled_task_preparations WHERE task_id=? LIMIT 1').get(target.id)
    const chain = store.getProjectDb().prepare('SELECT payload FROM project_chain_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1').get(subject.projectId) as { payload: string } | undefined
    if (control || (chain && JSON.stringify(JSON.parse(chain.payload)).includes(JSON.stringify(target.id)))) fail('目标已有受控准备或交付/协作证据，须原流程重确认')
  }
  const projections: OwnerTaskProjection[] = steps.map(step => ({ stepKey: step.key, ...(target ? { targetTaskId: target.id } : {}), title: target?.title ?? step.title, description: target?.description ?? `${step.outcome}\n\n验收标准：\n${step.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`, roleKey: step.roleKey, outcome: step.outcome, acceptanceCriteria: step.acceptanceCriteria, dependencies: step.dependencies, assignee: { userId: `agent-${source.executor.id}`, displayName: source.executor.name }, workspaceId: source.workspaceId, ...(source.developmentScope ? { developmentScope: source.developmentScope } : {}), ...(target ? { clearAssigneeMemberId: true as const, previous: { status: target.status, assignee: target.assignee, assigneeMemberId: target.assigneeMemberId, workspaceId: target.workspaceId, developmentScope: target.developmentScope } } : {}) }))
  const body = { ...subject, input, preparation, projections, ...(target ? { targetTaskHash: ownerExecutionHash(target), targetDependenciesHash: ownerExecutionHash(edgesFor(target.id, subject.projectId)) } : {}) }
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
