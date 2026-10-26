/** v2重新验证：冻结真实权威任务/依赖/人员/资料/配置摘要；不是授权账本，不改写v1原件。 */
import { randomUUID } from 'node:crypto'
import type {
  OwnerExecutionRevalidationInput,
  OwnerExecutionRevalidationPreview,
  OwnerExecutionRevalidationRecord,
  OwnerExecutionRevalidationSource,
  OwnerExecutionRevalidationTask,
  OwnerExecutionRevalidationView,
  ProjectOwnerGoalSubject,
} from '@gravitas/shared'
import * as store from './project-sqlite-store'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { getOwnerExecutionPreparation } from './project-owner-execution-preparation'
import { assertOwnerExecutionBoundaryIdle } from './project-owner-execution-preparation-evidence'
import {
  buildOwnerExecutionSource,
  OwnerExecutionPreparationConflictError,
  ownerExecutionHash,
  ownerExecutionObject,
  parseOwnerExecutionSubject,
} from './project-owner-execution-source'
import {
  getOwnerTaskMaterialization,
  getOwnerTaskMaterializationRecord,
  ownerTaskSpecificationHash,
} from './project-owner-task-materialization'
import { getPilotPolicy, saveOwnerRevalidationPolicy, withPolicyLock } from './project-pilot-policy'

function fail(message: string): never {
  if (/已更新|已变化|已过期|请求ID|版本|悬空|损坏/.test(message)) throw new OwnerExecutionPreparationConflictError(`Owner重验证：${message}`)
  throw new Error(`Owner重验证：${message}`)
}
export function parseOwnerExecutionRevalidationInput(raw: unknown): OwnerExecutionRevalidationInput {
  const value = ownerExecutionObject(raw, ['requestId', 'expectedRevalidationRevision', 'expectedMaterializationId', 'expectedMaterializationRevision', 'expectedMaterializationHash', 'expectedPolicyRevision', 'changeReason'])
  for (const key of ['requestId', 'expectedMaterializationId'] as const) if (typeof value[key] !== 'string' || !value[key].trim() || (value[key] as string).length > 200) fail('请求或材料化ID无效')
  if (typeof value.changeReason !== 'string' || !value.changeReason.trim()) fail('变更原因无效')
  for (const key of ['expectedRevalidationRevision', 'expectedMaterializationRevision', 'expectedPolicyRevision'] as const) if (!Number.isSafeInteger(value[key]) || Number(value[key]) < (key === 'expectedRevalidationRevision' ? 0 : 1)) fail('版本无效')
  if (typeof value.expectedMaterializationHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedMaterializationHash)) fail('材料化摘要无效')
  return value as unknown as OwnerExecutionRevalidationInput
}
function edgesFor(taskId: string, projectId: string) {
  return store.listTaskDependencies(projectId).filter(edge => edge.taskId === taskId || edge.dependsOnTaskId === taskId)
}
/** 实时重建v2来源；v1 plan/人员/资料/配置任何漂移都会让重建hash与冻结值不一致。 */
function buildRevalidationSource(subject: ProjectOwnerGoalSubject, input: OwnerExecutionRevalidationInput, materialization: ReturnType<typeof getOwnerTaskMaterializationRecord>): OwnerExecutionRevalidationSource {
  const frozenPreparation = materialization.preview.preparation
  const v1 = buildOwnerExecutionSource(subject, frozenPreparation.input)
  const tasks: OwnerExecutionRevalidationTask[] = materialization.links.map(link => {
    const task = store.getTask(link.taskId)
    if (!task || task.projectId !== subject.projectId || task.ownerStepLinkId !== link.id || task.status !== 'paused') fail('权威任务已不处于冻结暂停状态，不能重新验证')
    if (ownerTaskSpecificationHash(task) !== link.taskSpecificationHash) fail('权威任务规格已变化，请先核查漂移')
    const dependencies = edgesFor(task.id, subject.projectId).map(({ id, taskId, dependsOnTaskId, type }) => ({ id, taskId, dependsOnTaskId, type }))
    if (ownerExecutionHash(dependencies.slice().sort((a, b) => a.id.localeCompare(b.id))) !== ownerExecutionHash(link.dependencies.slice().sort((a, b) => a.id.localeCompare(b.id)))) fail('权威依赖已变化，不能沿用关联')
    return { taskId: task.id, stepKey: link.stepKey, linkId: link.id, linkKind: link.kind, linkIntegrityHash: link.integrityHash, taskSpecificationHash: link.taskSpecificationHash, status: 'paused' as const, assignee: task.assignee ?? { userId: '', displayName: '' }, workspaceId: task.workspaceId ?? '', ...(task.developmentScope ? { developmentScope: task.developmentScope } : {}), dependencies }
  })
  if (ownerExecutionHash(tasks.map(task => task.stepKey).sort()) !== ownerExecutionHash(v1.selectedStepKeys.slice().sort())) fail('步骤与真实任务数量不符，请保留原件核查')
  return {
    schemaVersion: 2,
    stage: 'paused_task_links',
    projectId: subject.projectId,
    ...(subject.taskId ? { taskId: subject.taskId } : {}),
    materialization: { id: materialization.id, revision: materialization.revision, integrityHash: materialization.integrityHash },
    originalPreparation: { id: frozenPreparation.id, revision: frozenPreparation.revision, integrityHash: frozenPreparation.integrityHash, policyRevision: frozenPreparation.policyRevision },
    planRevision: v1.planRevision,
    planVersion: v1.planVersion,
    planFingerprint: v1.planFingerprint,
    contextFingerprint: v1.contextFingerprint,
    selectedStepKeys: v1.selectedStepKeys,
    tasks,
    executor: v1.executor,
    reviewer: v1.reviewer,
    workspaceId: v1.workspaceId,
    workspaceName: v1.workspaceName,
    workspaceHash: v1.workspaceHash,
    channelId: v1.channelId,
    modelId: v1.modelId,
    runtime: v1.runtime,
    channelHash: v1.channelHash,
    capabilityConfigurationHash: v1.capabilityConfigurationHash,
    ...(v1.repositoryIdentityHash === undefined ? {} : { repositoryIdentityHash: v1.repositoryIdentityHash }),
    ownerBindingProvenance: v1.ownerBindingProvenance,
    knowledgeSources: v1.knowledgeSources,
    budget: { maxCostMicros: frozenPreparation.input.maxCostMicros, maxRuns: frozenPreparation.input.maxRuns, maxRework: frozenPreparation.input.maxRework, expiresAt: frozenPreparation.input.expiresAt },
    executionKind: frozenPreparation.input.executionKind,
    blockers: [...v1.blockers, 'v2冻结真实任务事实，不是执行授权；发行、派工、资料工具与预算purpose仍关闭'],
  }
}
function readHistory(projectId: string): OwnerExecutionRevalidationRecord[] {
  const database = store.getProjectDb()
  const rows = database.prepare('SELECT * FROM project_owner_execution_revalidations WHERE project_id=? ORDER BY revision').all(projectId) as Array<{ id: string; project_id: string; task_id: string | null; revision: number; request_id: string; payload: string; integrity_hash: string }>
  let previous: string | null = null
  return rows.map((row, index) => {
    try {
      const value = ownerExecutionObject(JSON.parse(row.payload), ['schemaVersion', 'purpose', 'id', 'projectId', 'taskId', 'revision', 'policyRevision', 'stage', 'actor', 'savedAt', 'input', 'source', 'inputHash', 'previewFingerprint', 'previousIntegrityHash', 'integrityHash'])
      const record = value as unknown as OwnerExecutionRevalidationRecord, { integrityHash, ...body } = record
      const subject = parseOwnerExecutionSubject({ projectId: record.projectId, ...(record.taskId ? { taskId: record.taskId } : {}) }), input = parseOwnerExecutionRevalidationInput(record.input)
      if (record.schemaVersion !== 2 || record.purpose !== 'owner_business_execution_revalidation' || record.stage !== 'paused_task_links' || record.actor !== 'local-user' || !Number.isSafeInteger(record.savedAt) || row.id !== record.id || row.project_id !== projectId || record.projectId !== projectId || row.task_id !== (record.taskId ?? null) || record.revision !== index + 1 || row.revision !== record.revision || input.expectedRevalidationRevision !== index || input.requestId !== row.request_id || record.inputHash !== ownerExecutionHash({ subject, input }) || record.previousIntegrityHash !== previous || integrityHash !== row.integrity_hash || integrityHash !== ownerExecutionHash(body) || record.source.schemaVersion !== 2 || record.source.stage !== 'paused_task_links' || record.source.projectId !== projectId || record.source.materialization.id !== input.expectedMaterializationId || record.source.materialization.revision !== input.expectedMaterializationRevision || record.source.materialization.integrityHash !== input.expectedMaterializationHash || record.source.originalPreparation.id !== materializationPreparationId(record) || record.previewFingerprint !== ownerExecutionHash({ ...subject, input, source: record.source }) || !record.source.tasks.length) fail('历史完整性损坏')
      previous = integrityHash
      return record
    } catch { return fail('重验证历史无效，请保留原件核查，不降级或重建') }
  })
}
function materializationPreparationId(record: OwnerExecutionRevalidationRecord): string {
  if (typeof record.source.originalPreparation?.id !== 'string') throw new Error('v2来源缺少上游准备身份')
  return record.source.originalPreparation.id
}
export function listOwnerExecutionRevalidationHistory(rawSubject: unknown): OwnerExecutionRevalidationRecord[] {
  const subject = parseOwnerExecutionSubject(rawSubject)
  return readHistory(subject.projectId).filter(item => item.taskId === subject.taskId)
}
export function getOwnerExecutionRevalidation(rawSubject: unknown): OwnerExecutionRevalidationView {
  const subject = parseOwnerExecutionSubject(rawSubject), history = readHistory(subject.projectId), record = history.filter(item => item.taskId === subject.taskId).at(-1) ?? null
  const policy = getPilotPolicy(subject.projectId), reference = policy?.ownerExecutionRevalidation
  if (!record) {
    if (reference) return { revision: history.at(-1)?.revision ?? 0, revalidation: null, status: 'stale', blockers: ['策略v2引用悬空或记录缺失，请保留原件核查'] }
    return { revision: history.at(-1)?.revision ?? 0, revalidation: null, status: 'none', blockers: [] }
  }
  const view: OwnerExecutionRevalidationView = { revision: history.at(-1)?.revision ?? 0, revalidation: record, status: 'current', blockers: [] }
  if (!reference) return { ...view, status: 'unapplied', blockers: ['v2记录已提交但策略尚未一致应用；请保留证据核查'] }
  try {
    if (policy?.state !== 'paused' || policy.revision !== record.policyRevision || !reference || reference.id !== record.id || reference.revision !== record.revision || reference.integrityHash !== record.integrityHash || reference.materializationId !== record.input.expectedMaterializationId || reference.materializationIntegrityHash !== record.input.expectedMaterializationHash) fail('策略v2引用与记录不一致，请保留原件核查')
    const materialization = getOwnerTaskMaterializationRecord(subject.projectId, record.input.expectedMaterializationId)
    if (materialization.revision !== record.input.expectedMaterializationRevision || materialization.integrityHash !== record.input.expectedMaterializationHash) fail('材料化记录已修订')
    if (JSON.stringify(record.source.originalPreparation) !== JSON.stringify({ id: materialization.preview.preparation.id, revision: materialization.preview.preparation.revision, integrityHash: materialization.preview.preparation.integrityHash, policyRevision: materialization.preview.preparation.policyRevision })) fail('上游v1准备身份不匹配')
    const rebuilt = buildRevalidationSource(subject, record.input, materialization)
    if (ownerExecutionHash(rebuilt) !== ownerExecutionHash(record.source)) fail('真实任务、人员、资料或配置已变化')
    return { ...view, blockers: rebuilt.blockers }
  } catch (error) { return { ...view, status: 'stale', blockers: [error instanceof Error ? error.message : 'Owner重验证来源无法核验'] } }
}
function currentPreview(subject: ProjectOwnerGoalSubject, input: OwnerExecutionRevalidationInput): OwnerExecutionRevalidationPreview {
  assertLocalActorEnabled()
  const history = readHistory(subject.projectId)
  if ((history.at(-1)?.revision ?? 0) !== input.expectedRevalidationRevision) fail('重验证版本已更新')
  const materializationView = getOwnerTaskMaterialization(subject)
  if (materializationView.status !== 'needs_revalidation' || !materializationView.materialization) fail('材料化来源已漂移或缺失，请先核查')
  if (materializationView.materialization.id !== input.expectedMaterializationId || materializationView.materialization.revision !== input.expectedMaterializationRevision || materializationView.materialization.integrityHash !== input.expectedMaterializationHash) fail('材料化记录已修订')
  const materialization = getOwnerTaskMaterializationRecord(subject.projectId, input.expectedMaterializationId)
  if (materialization.taskId !== subject.taskId) fail('材料化主体不匹配')
  const policy = getPilotPolicy(subject.projectId), view = getOwnerExecutionPreparation(subject), preparation = view.preparation
  // v1视图状态可能是current（project主体）或自然stale（单任务合法patch）；只要求身份与materialization冻结准备精确一致。
  if (!preparation || preparation.id !== materialization.preview.preparation.id || ownerExecutionHash(preparation) !== ownerExecutionHash(materialization.preview.preparation)) fail('v1准备来源不可用，请先核查')
  if (!policy || policy.state !== 'paused' || policy.revision !== input.expectedPolicyRevision || policy.ownerExecutionPreparation?.id !== preparation.id || policy.ownerExecutionPreparation.revision !== preparation.revision || policy.ownerExecutionPreparation.integrityHash !== preparation.integrityHash) fail('策略引用已更新，请重新预览')
  if (preparation.input.expiresAt <= Date.now()) fail('v1执行准备期限已过期，不能顺延重验证')
  assertOwnerExecutionBoundaryIdle(subject.projectId)
  const source = buildRevalidationSource(subject, input, materialization)
  const body = { ...subject, input, source }
  return { ...body, previewFingerprint: ownerExecutionHash(body) }
}
export function previewOwnerExecutionRevalidation(rawSubject: unknown, rawInput: unknown): OwnerExecutionRevalidationPreview {
  return currentPreview(parseOwnerExecutionSubject(rawSubject), parseOwnerExecutionRevalidationInput(rawInput))
}
export function saveOwnerExecutionRevalidation(rawSubject: unknown, rawInput: unknown, fingerprint: unknown): OwnerExecutionRevalidationRecord {
  const subject = parseOwnerExecutionSubject(rawSubject), input = parseOwnerExecutionRevalidationInput(rawInput), database = store.getProjectDb()
  assertLocalActorEnabled()
  if (database.isTransactionActive()) fail('拒绝未提交外层事务')
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) fail('预览摘要无效')
  const inputHash = ownerExecutionHash({ subject, input }), history = readHistory(subject.projectId), prior = history.find(item => item.input.requestId === input.requestId)
  if (prior) {
    if (prior.inputHash !== inputHash || prior.previewFingerprint !== fingerprint || prior.source.tasks.some(task => !store.getTask(task.taskId) || store.getTask(task.taskId)?.ownerStepLinkId !== task.linkId)) fail('请求ID已用于不同输入或权威任务缺失，保留原件，不补造')
    // 与v1 matchesPolicy同构：DB已提交但policy未应用/被覆盖的重放不得伪装成功。
    const applied = getPilotPolicy(subject.projectId)?.ownerExecutionRevalidation
    if (!applied || applied.id !== prior.id || applied.revision !== prior.revision || applied.integrityHash !== prior.integrityHash || getPilotPolicy(subject.projectId)?.revision !== prior.policyRevision) fail('已提交重验证未一致应用于策略，请保留证据核查')
    return prior
  }
  return withPolicyLock(() => {
    let saved: OwnerExecutionRevalidationRecord | null = null
    database.transaction(() => {
      const preview = currentPreview(subject, input)
      if (preview.previewFingerprint !== fingerprint) fail('旧预览已更新，请重新预览')
      if (ownerExecutionHash({ subject, input }) !== inputHash) fail('请求身份不一致')
      const id = randomUUID()
      const record: OwnerExecutionRevalidationRecord = { ...subject, schemaVersion: 2, purpose: 'owner_business_execution_revalidation', id, revision: input.expectedRevalidationRevision + 1, policyRevision: input.expectedPolicyRevision + 1, stage: 'paused_task_links', actor: 'local-user', savedAt: Date.now(), input, inputHash, source: preview.source, previewFingerprint: preview.previewFingerprint, previousIntegrityHash: history.at(-1)?.integrityHash ?? null, integrityHash: 'pending' }
      const { integrityHash: _hash, ...recordBody } = record
      record.integrityHash = ownerExecutionHash(recordBody)
      database.prepare('INSERT INTO project_owner_execution_revalidations(id,project_id,task_id,revision,request_id,payload,integrity_hash) VALUES(?,?,?,?,?,?,?)').run(id, subject.projectId, subject.taskId ?? null, record.revision, input.requestId, JSON.stringify(record), record.integrityHash)
      saved = readHistory(subject.projectId).at(-1)!
    })()
    if (!saved) fail('事务未保存重验证结果')
    const record = saved as OwnerExecutionRevalidationRecord
    saveOwnerRevalidationPolicy(subject.projectId, input.expectedPolicyRevision, () => ({ schemaVersion: 1, purpose: 'owner_business_execution_revalidation', id: record.id, revision: record.revision, integrityHash: record.integrityHash, stage: 'paused_task_links', materializationId: input.expectedMaterializationId, materializationIntegrityHash: input.expectedMaterializationHash }))
    return readHistory(subject.projectId).at(-1)!
  })
}
