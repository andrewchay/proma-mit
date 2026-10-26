import { supportsOwnerExecutionKind } from '@gravitas/shared'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { OwnerExecutionAssignmentCandidate, OwnerExecutionAssignmentContext, ProjectOwnerPlanDraft, ProjectOwnerPlanningContext } from '@gravitas/shared'

export interface CreateOwnerExecutionAssignmentContextInput {
  context: ProjectOwnerPlanningContext
  plan: ProjectOwnerPlanDraft
  workspaces: Array<{ id: string; name: string; capabilities?: string[]; rootPath?: string }>
  projectTitle: string
  projectDescription: string
  ownerCarrierId: string
  ownerName: string
  bindingRevision: number
  ownerDefaults: { workspaceId: string; channelId: string; modelId: string; runtime: string }
  candidates: OwnerExecutionAssignmentCandidate[]
  feedback?: string
  teamContractVersion?: 1 | 2 | 3
}
export class OwnerExecutionAssignmentCapabilityError extends Error {
  constructor(readonly reason: 'no-executable-employee' | 'no-independent-reviewer') {
    super(reason === 'no-executable-employee' ? '当前项目工作区没有可用执行人员' : '当前项目工作区缺少可独立检查成果的另一位员工')
    this.name = 'OwnerExecutionAssignmentCapabilityError'
  }
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function boundedText(value: string, max: number): string { return value.replace(/\u0000/g, '').slice(0, max) }
function hasReferencedCodeSource(input: CreateOwnerExecutionAssignmentContextInput): boolean {
  const codeFiles = new Set((input.plan.sources.code?.files ?? []).map(file => `${file.path}\0${file.sha256}`))
  return codeFiles.size > 0 && input.plan.proposal.steps.some(step =>
    step.sourceReferences?.some(reference => codeFiles.has(`${reference.path}\0${reference.sha256}`)),
  )
}
function safeCandidate(candidate: OwnerExecutionAssignmentCandidate, version: 1 | 2 | 3): OwnerExecutionAssignmentCandidate {
  return {
    id: candidate.id,
    name: boundedText(candidate.name, 200),
    ...(candidate.role ? { role: boundedText(candidate.role, 300) } : {}),
    ...(candidate.roleTemplateId ? { roleTemplateId: candidate.roleTemplateId } : {}),
    ...(candidate.description ? { description: boundedText(candidate.description, 1500) } : {}),
    ...(candidate.skills ? { skills: candidate.skills.slice(0, 30).map(skill => boundedText(skill, 160)) } : {}),
    ...(candidate.totalTasks === undefined ? {} : { totalTasks: candidate.totalTasks }),
    ...(candidate.completedTasks === undefined ? {} : { completedTasks: candidate.completedTasks }),
    ...(candidate.failureCount === undefined ? {} : { failureCount: candidate.failureCount }),
    ...(candidate.avgDurationMs === undefined ? {} : { avgDurationMs: candidate.avgDurationMs }),
    executionProfile: candidate.executionProfile,
    ...(version >= 2 && candidate.ownerControlledCompatible ? { ownerControlledCompatible: true as const } : {}),
    ...(version === 3 && candidate.ownerMixedRuntimeCompatible ? { ownerMixedRuntimeCompatible: true as const } : {}),
    workspaceIds: [...candidate.workspaceIds].sort(),
    channelId: candidate.channelId,
    ...(candidate.modelId ? { modelId: candidate.modelId } : {}),
    runtime: candidate.runtime,
  }
}
export function createOwnerExecutionAssignmentContext(input: CreateOwnerExecutionAssignmentContextInput): OwnerExecutionAssignmentContext {
  const version = input.teamContractVersion ?? 3
  const steps = input.plan.proposal.steps
  if (!steps.length || !input.plan.planFingerprint || input.context.goal.goal.projectId !== input.plan.projectId || !['proposed', 'confirmed'].includes(input.plan.state)) throw new Error('Owner计划或项目来源不是当前有效版本')
  if (!input.workspaces.length) throw new Error('当前项目没有可用于执行的授权工作区')
  const workspaces = input.workspaces.map(workspace => ({ id: workspace.id, name: boundedText(workspace.name, 200), ...(workspace.capabilities ? { capabilities: workspace.capabilities.slice(0, 80).map(item => boundedText(item, 160)) } : {}) })).sort((a, b) => a.id.localeCompare(b.id))
  const workspaceIds = new Set(workspaces.map(workspace => workspace.id))
  const candidates = input.candidates
    .filter(candidate => candidate.id !== input.ownerCarrierId && !candidate.isOwnerCarrier
      && (['controlled', 'development'].includes(candidate.executionProfile) || version >= 2 && supportsOwnerExecutionKind(candidate, 'controlled'))
      && (version !== 3 || candidate.ownerMixedRuntimeCompatible === true)
      && candidate.workspaceIds.some(id => workspaceIds.has(id))
      && Boolean(candidate.channelId && candidate.modelId && candidate.runtime))
    .map(candidate => safeCandidate(candidate, version))
    .sort((a, b) => a.id.localeCompare(b.id))
  if (!candidates.length) throw new OwnerExecutionAssignmentCapabilityError('no-executable-employee')
  if (version === 1 && !candidates.some(candidate => ['reviewer', 'delivery-verifier'].includes(candidate.roleTemplateId ?? ''))) throw new Error('当前项目工作区没有符合岗位模板的独立评审员，不能生成安排提案')
  if (version >= 2 && candidates.length < 2) throw new OwnerExecutionAssignmentCapabilityError('no-independent-reviewer')
  const roles = [...new Set(steps.map(step => step.roleKey))]
  const roleNames = new Map(input.plan.sources.roles.map(role => [role.key, role.name]))
  // 绿地：没有既有代码候选、且至少一个授权工作区是 git 仓库（研发交付依赖 worktree 快照）。
  const greenfieldDevelopment = !hasReferencedCodeSource(input)
    && (input.plan.sources.code?.files.length ?? 0) === 0
    && input.workspaces.some(workspace => Boolean(workspace.rootPath && isGitRepositoryWithHead(workspace.rootPath)))
  const developmentSourcesAvailable = hasReferencedCodeSource(input) || greenfieldDevelopment
  const source = {
    ...(version >= 2 ? { teamContractVersion: version as 2 | 3 } : {}),
    schemaVersion: 1 as const,
    projectId: input.plan.projectId,
    ...(input.plan.taskId === undefined ? {} : { taskId: input.plan.taskId }),
    planRevision: input.plan.revision,
    planFingerprint: input.plan.planFingerprint,
    goalRevision: input.context.goal.revision,
    sourceContextFingerprint: input.context.fingerprint,
    bindingRevision: input.bindingRevision,
    workspaces,
    executionKinds: [...new Set(candidates.flatMap(candidate => (['controlled', 'development'] as const).filter(kind =>
      supportsOwnerExecutionKind(candidate, kind) && (kind !== 'development' || developmentSourcesAvailable),
    )))].sort(),
    ownerDefaults: input.ownerDefaults,
    projectTitle: boundedText(input.projectTitle, 500),
    projectDescription: boundedText(input.projectDescription, 3000),
    objective: boundedText(input.context.goal.goal.objective, 3000),
    constraints: input.context.goal.goal.constraints.slice(0, 30).map(item => boundedText(item, 1000)),
    acceptanceCriteria: (input.context.goal.goal.acceptanceCriteria ?? []).slice(0, 30).map(item => boundedText(item, 1000)),
    roles: roles.map(roleKey => ({ roleKey, name: boundedText(roleNames.get(roleKey) ?? roleKey, 200) })),
    steps: steps.map(step => ({ key: step.key, title: boundedText(step.title, 300), outcome: boundedText(step.outcome, 1200), acceptanceCriteria: step.acceptanceCriteria.slice(0, 30).map(item => boundedText(item, 1000)), dependencies: [...step.dependencies], roleKey: step.roleKey, ...(step.sourceReferences ? { sourceReferences: step.sourceReferences.map(reference => ({ ...reference })) } : {}) })),
    ...(greenfieldDevelopment ? { greenfieldDevelopment: true as const } : {}),
    ...(input.plan.sources.code ? { codeFiles: input.plan.sources.code.files.slice(0, 256).map(file => ({ path: boundedText(file.path, 1000), sha256: file.sha256, matchedTerms: file.matchedTerms.slice(0, 20).map(term => boundedText(term, 120)) })) } : {}),
    candidates,
    ownerCarrierId: input.ownerCarrierId,
    ownerName: boundedText(input.ownerName, 200),
    ...(input.feedback ? { feedback: boundedText(input.feedback, 2000) } : {}),
  }
  return { ...source, contextFingerprint: hash(source) }
}

export function parseOwnerExecutionAssignmentContext(raw: unknown): OwnerExecutionAssignmentContext {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error('Owner安排冻结资料无效')
  const value = raw as Record<string, unknown>
  const allowed = ['teamContractVersion', 'schemaVersion', 'projectId', 'taskId', 'planRevision', 'planFingerprint', 'goalRevision', 'sourceContextFingerprint', 'bindingRevision', 'workspaces', 'executionKinds', 'ownerDefaults', 'projectTitle', 'projectDescription', 'objective', 'constraints', 'acceptanceCriteria', 'roles', 'steps', 'codeFiles', 'greenfieldDevelopment', 'candidates', 'ownerCarrierId', 'ownerName', 'feedback', 'contextFingerprint']
  if (Object.keys(value).some(key => !allowed.includes(key)) || value.teamContractVersion !== undefined && value.teamContractVersion !== 2 && value.teamContractVersion !== 3 || value.schemaVersion !== 1 || typeof value.contextFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.contextFingerprint)) throw new Error('Owner安排冻结资料字段或指纹无效')
  const { contextFingerprint, ...body } = value
  if (hash(body) !== contextFingerprint || typeof value.projectId !== 'string' || typeof value.planFingerprint !== 'string' || typeof value.sourceContextFingerprint !== 'string'
    || !Array.isArray(value.workspaces) || !Array.isArray(value.executionKinds) || !Array.isArray(value.steps) || !Array.isArray(value.roles) || !Array.isArray(value.candidates)
    || !Array.isArray(value.constraints) || !Array.isArray(value.acceptanceCriteria) || value.codeFiles !== undefined && !Array.isArray(value.codeFiles)
    || value.greenfieldDevelopment !== undefined && value.greenfieldDevelopment !== true || !value.ownerDefaults || typeof value.ownerDefaults !== 'object') throw new Error('Owner安排冻结资料完整性校验失败')
  const candidateIds = (value.candidates as Array<{ id?: unknown }>).map(candidate => candidate?.id)
  const workspaceIds = (value.workspaces as Array<{ id?: unknown }>).map(workspace => workspace?.id)
  const stepKeys = (value.steps as Array<{ key?: unknown }>).map(step => step?.key)
  if (candidateIds.some(id => typeof id !== 'string' || !id) || new Set(candidateIds).size !== candidateIds.length
    || workspaceIds.some(id => typeof id !== 'string' || !id) || new Set(workspaceIds).size !== workspaceIds.length
    || stepKeys.some(key => typeof key !== 'string' || !key) || new Set(stepKeys).size !== stepKeys.length) throw new Error('Owner安排冻结资料候选、工作区或步骤身份重复/无效')
  return value as unknown as OwnerExecutionAssignmentContext
}

/** 仅接受同一提案从待审到确认时产生的单次revision递增；其他来源变化仍判旧。 */
export function ownerAssignmentContextMatchesApprovalTransition(previous: OwnerExecutionAssignmentContext, current: OwnerExecutionAssignmentContext): boolean {
  if (current.planRevision !== previous.planRevision + 1 || current.planFingerprint !== previous.planFingerprint
    || current.projectId !== previous.projectId || current.taskId !== previous.taskId
    || current.goalRevision !== previous.goalRevision || current.sourceContextFingerprint !== previous.sourceContextFingerprint
    || current.bindingRevision !== previous.bindingRevision) return false
  const withoutRevision = ({ planRevision: _revision, contextFingerprint: _fingerprint, ...value }: OwnerExecutionAssignmentContext) => value
  return hash(withoutRevision(previous)) === hash(withoutRevision(current))
}

/**
 * 研发交付依赖 worktree 快照，其基线来自仓库 HEAD。
 * 只有 `git init` 而没有首个提交的空仓会在执行准备阶段失败，因此这里就要求 HEAD 可解析，
 * 避免把一条必然失败的路径提供成候选。
 */
function isGitRepositoryWithHead(rootPath: string): boolean {
  if (!existsSync(join(rootPath, '.git'))) return false
  try {
    execFileSync('git', ['-C', rootPath, 'rev-parse', '--verify', 'HEAD'], { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}
