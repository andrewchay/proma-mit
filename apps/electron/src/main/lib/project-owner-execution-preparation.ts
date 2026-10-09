import { listAgentWorkspaces } from './agent-workspace-manager'
import { hasProjectWorkspaceBinding } from './project-workspace-bindings'
import { readCatalog } from './knowledge-catalog-service'
/** 追加式来源准备，不是授权账本；保存永远不调用Runner/Provider或创建业务Task。 */
import { randomUUID } from 'node:crypto'
import type {
  OwnerExecutionPreparationInput,
  OwnerExecutionPreparationPreview,
  OwnerExecutionPreparationRecord,
  OwnerExecutionPreparationView,
  ProjectOwnerGoalSubject,
} from '@gravitas/shared'
import { getProject, getTask, listAgentEmployees, getProjectDb } from './project-sqlite-store'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { getPilotPolicy, saveOwnerPreparationPolicy } from './project-pilot-policy'
import { assertOwnerExecutionBoundaryIdle } from './project-owner-execution-preparation-evidence'
import {
  buildOwnerExecutionSource,
  OwnerExecutionPreparationConflictError,
  ownerExecutionHash,
  ownerExecutionObject,
  parseOwnerExecutionInput,
  parseOwnerExecutionSubject,
} from './project-owner-execution-source'
interface Row {
  id: string
  project_id: string
  task_id: string | null
  revision: number
  request_id: string
  payload: string
  integrity_hash: string
}
function history(projectId: string): OwnerExecutionPreparationRecord[] {
  const rows = getProjectDb()
    .prepare(
      'SELECT * FROM project_owner_execution_preparations WHERE project_id=? ORDER BY revision',
    )
    .all(projectId) as Row[]
  let previous: string | null = null
  return rows.map((row, index) => {
    try {
      const raw = ownerExecutionObject(JSON.parse(row.payload), [
        'schemaVersion',
        'id',
        'projectId',
        'taskId',
        'revision',
        'policyRevision',
        'stage',
        'actor',
        'savedAt',
        'input',
        'source',
        'inputHash',
        'previousIntegrityHash',
        'integrityHash',
      ])
      const { integrityHash, ...body } = raw
      const input = parseOwnerExecutionInput(raw.input),
        subject = parseOwnerExecutionSubject({
          projectId: raw.projectId,
          ...(raw.taskId === undefined ? {} : { taskId: raw.taskId }),
        })
      const source = ownerExecutionObject(raw.source, [
        'schemaVersion',
        'stage',
        'ownerBindingProvenance',
        'projectId',
        'taskId',
        'goalRevision',
        'goalVersion',
        'planRevision',
        'planVersion',
        'planFingerprint',
        'contextFingerprint',
        'plan',
        'selectedStepKeys',
        'executor',
        'reviewer',
        'workspaceId',
        'workspaceName',
        'workspaceHash',
        'targetTaskHash',
        'repositoryIdentityHash',
        'channelId',
        'modelId',
        'runtime',
        'channelHash',
        'capabilityConfigurationHash',
        'developmentScope',
        'knowledgeSources',
        'blockers',
      ])
      if (
        raw.schemaVersion !== 1 ||
        raw.stage !== 'pending_task_links' ||
        raw.actor !== 'local-user' ||
        raw.id !== row.id ||
        subject.projectId !== projectId ||
        (subject.taskId ?? null) !== row.task_id ||
        row.project_id !== projectId ||
        raw.revision !== index + 1 ||
        row.revision !== index + 1 ||
        input.expectedPreparationRevision !== index ||
        input.requestId !== row.request_id ||
        raw.inputHash !== ownerExecutionHash({ subject, input }) ||
        raw.previousIntegrityHash !== previous ||
        source.schemaVersion !== 1 ||
        source.stage !== 'pending_task_links' ||
        source.projectId !== projectId ||
        source.taskId !== subject.taskId ||
        source.planRevision !== input.expectedPlanRevision ||
        source.goalRevision !== input.expectedGoalRevision ||
        !Number.isSafeInteger(raw.savedAt) ||
        !Number.isSafeInteger(raw.policyRevision) ||
        integrityHash !== row.integrity_hash ||
        integrityHash !== ownerExecutionHash(body)
      )
        throw new Error('准备身份或来源摘要不匹配')
      previous = row.integrity_hash
      return raw as unknown as OwnerExecutionPreparationRecord
    } catch {
      throw new Error('Owner执行准备历史无效，请保留原件核查，不降级普通Pilot')
    }
  })
}
function matchesPolicy(record: OwnerExecutionPreparationRecord): boolean {
  const policy = getPilotPolicy(record.projectId),
    reference = policy?.ownerExecutionPreparation
  return (
    policy?.revision === record.policyRevision &&
    reference?.id === record.id &&
    reference.revision === record.revision &&
    reference.integrityHash === record.integrityHash &&
    policy.executorEmployeeId === record.source.executor.id &&
    policy.reviewerEmployeeId === record.source.reviewer.id &&
    policy.channelId === record.source.channelId &&
    policy.modelId === record.source.modelId &&
    policy.workspaceId === record.source.workspaceId &&
    policy.maxCostMicros === record.input.maxCostMicros &&
    policy.maxRuns === record.input.maxRuns &&
    policy.maxRework === record.input.maxRework &&
    policy.expiresAt === record.input.expiresAt
  )
}
export function listOwnerExecutionPreparationHistory(
  rawSubject: unknown,
): OwnerExecutionPreparationRecord[] {
  const subject = parseOwnerExecutionSubject(rawSubject)
  return history(subject.projectId).filter((record) => record.taskId === subject.taskId)
}
export function getOwnerExecutionPreparation(rawSubject: unknown): OwnerExecutionPreparationView {
  const subject = parseOwnerExecutionSubject(rawSubject),
    records = history(subject.projectId),
    preparation = records.at(-1) ?? null
  if (
    !getProject(subject.projectId) ||
    (subject.taskId !== undefined && getTask(subject.taskId)?.projectId !== subject.projectId)
  )
    throw new Error('Owner执行准备主体不存在')
  const policy = getPilotPolicy(subject.projectId)
  const workspaces = listAgentWorkspaces()
    .filter((workspace) => hasProjectWorkspaceBinding(subject.projectId, workspace.id))
    .map(({ id, name }) => ({ id, name }))
  const employees = listAgentEmployees()
    .filter(
      (employee) =>
        employee.enabled &&
        ['controlled', 'development'].includes(employee.executionProfile ?? 'general') &&
        (employee.workspaceIds ?? (employee.workspaceId ? [employee.workspaceId] : [])).some((id) =>
          workspaces.some((workspace) => workspace.id === id),
        ),
    )
    .map((employee) => ({
      id: employee.id,
      name: employee.name,
      executionProfile: employee.executionProfile ?? 'general',
      workspaceIds: employee.workspaceIds ?? (employee.workspaceId ? [employee.workspaceId] : []),
      channelId: employee.channelId,
      modelId: employee.modelId,
      runtime: employee.runtime,
    }))
  const catalog = readCatalog(),
    baseIds = catalog.bindings
      .filter((binding) => binding.projectId === subject.projectId)
      .map((binding) => binding.knowledgeBaseId)
  const sourceIds = new Set(
    catalog.knowledgeBases
      .filter((base) => base.enabled && baseIds.includes(base.id))
      .flatMap((base) => base.sourceIds),
  )
  const knowledgeSources = catalog.sources
    .filter((source) => source.enabled && sourceIds.has(source.id))
    .map(({ id, name }) => ({ id, name }))
  const view: OwnerExecutionPreparationView = {
    choices: { employees, workspaces, knowledgeSources },
    revision: preparation?.revision ?? 0,
    policyRevision: policy?.revision ?? null,
    preparation,
    status: preparation ? 'current' : 'none',
    blockers: [],
  }
  if (!preparation) {
    if (policy?.ownerExecutionPreparation)
      throw new Error('Owner执行准备策略引用悬空，请保留配置核查')
    return view
  }
  if (!matchesPolicy(preparation))
    return {
      ...view,
      status: 'unapplied',
      blockers: ['Owner准备证据与策略尚未一致应用，请保留原件核查'],
    }
  if (preparation.taskId !== subject.taskId)
    return {
      ...view,
      status: 'other_subject',
      blockers: ['当前项目策略绑定另一目标主体，须显式修订；不会自动切换'],
    }
  try {
    const source = buildOwnerExecutionSource(subject, preparation.input)
    if (ownerExecutionHash(source) !== ownerExecutionHash(preparation.source))
      throw new Error('Owner执行来源或配置已更新，请重新预览准备')
    return { ...view, blockers: source.blockers }
  } catch (error) {
    return {
      ...view,
      status: 'stale',
      blockers: [error instanceof Error ? error.message : 'Owner准备来源已变化'],
    }
  }
}
export function previewOwnerExecutionPreparation(
  rawSubject: unknown,
  rawInput: unknown,
): OwnerExecutionPreparationPreview {
  assertLocalActorEnabled()
  const subject = parseOwnerExecutionSubject(rawSubject),
    input = parseOwnerExecutionInput(rawInput),
    records = history(subject.projectId)
  if (
    (records.at(-1)?.revision ?? 0) !== input.expectedPreparationRevision ||
    (getPilotPolicy(subject.projectId)?.revision ?? null) !== input.expectedPolicyRevision
  )
    throw new OwnerExecutionPreparationConflictError('Owner准备或策略已更新，请加载并比较后重试')
  assertOwnerExecutionBoundaryIdle(subject.projectId)
  const source = buildOwnerExecutionSource(subject, input)
  return { ...source, input, previewFingerprint: ownerExecutionHash({ subject, input, source }) }
}
export function saveOwnerExecutionPreparation(
  rawSubject: unknown,
  rawInput: unknown,
  previewFingerprint: string,
): OwnerExecutionPreparationRecord {
  if (getProjectDb().isTransactionActive())
    throw new Error('Owner准备保存拒绝未提交外层事务，不能跨JSON/数据库假称原子提交')
  assertLocalActorEnabled()
  const subject = parseOwnerExecutionSubject(rawSubject),
    input = parseOwnerExecutionInput(rawInput)
  if (typeof previewFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(previewFingerprint))
    throw new Error('Owner准备预览指纹无效')
  const existing = history(subject.projectId).find(
    (record) => record.input.requestId === input.requestId,
  )
  if (existing) {
    if (existing.inputHash !== ownerExecutionHash({ subject, input }))
      throw new Error('Owner准备请求ID已用于不同输入')
    if (!matchesPolicy(existing))
      throw new Error('Owner准备尚未一致应用或已被新修订替代，请保留证据核查')
    const source = buildOwnerExecutionSource(subject, input)
    if (
      ownerExecutionHash({ subject, input, source }) !== previewFingerprint ||
      ownerExecutionHash(source) !== ownerExecutionHash(existing.source)
    )
      throw new Error('Owner来源已更新，请重新预览')
    return existing
  }
  // 预检没有持久化副作用；在policy锁内/DB事务中再次核查，JSON失败时保留未应用证据。
  let saved: OwnerExecutionPreparationRecord | undefined
  saveOwnerPreparationPolicy(subject.projectId, input.expectedPolicyRevision, (policyRevision) => {
    getProjectDb().transaction(() => {
      const preview = previewOwnerExecutionPreparation(subject, input)
      if (preview.previewFingerprint !== previewFingerprint)
        throw new OwnerExecutionPreparationConflictError('Owner预览来源已更新，请重新确认')
      const previous = history(subject.projectId).at(-1)
      const { input: _input, previewFingerprint: _fingerprint, ...source } = preview
      const body = {
        schemaVersion: 1 as const,
        id: randomUUID(),
        ...subject,
        revision: input.expectedPreparationRevision + 1,
        policyRevision,
        stage: 'pending_task_links' as const,
        actor: 'local-user' as const,
        savedAt: Date.now(),
        input,
        source,
        inputHash: ownerExecutionHash({ subject, input }),
        previousIntegrityHash: previous?.integrityHash ?? null,
      }
      saved = { ...body, integrityHash: ownerExecutionHash(body) }
      getProjectDb()
        .prepare(
          'INSERT INTO project_owner_execution_preparations (id,project_id,task_id,revision,request_id,payload,integrity_hash) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          saved.id,
          subject.projectId,
          subject.taskId ?? null,
          saved.revision,
          input.requestId,
          JSON.stringify(saved),
          saved.integrityHash,
        )
    })()
    if (!saved) throw new Error('Owner准备证据未保存')
    return {
      input: {
        workspaceId: input.workspaceId,
        employeeIds: [input.executorEmployeeId, input.reviewerEmployeeId],
        executorEmployeeId: input.executorEmployeeId,
        reviewerEmployeeId: input.reviewerEmployeeId,
        modelId: saved.source.modelId,
        channelId: saved.source.channelId,
        maxCostMicros: input.maxCostMicros,
        maxRuns: input.maxRuns,
        maxRework: input.maxRework,
        expiresAt: input.expiresAt,
      },
      reference: {
        schemaVersion: 1,
        purpose: 'owner_business_execution_preparation',
        id: saved.id,
        revision: saved.revision,
        integrityHash: saved.integrityHash,
        stage: 'pending_task_links',
      },
    }
  })
  if (!saved || !matchesPolicy(saved)) throw new Error('Owner准备未应用，请保留原件核查')
  return saved
}
