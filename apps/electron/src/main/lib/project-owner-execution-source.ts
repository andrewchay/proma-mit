/** 只构造业务准备事实；不开放工具、模型、资料读取或任务执行。 */
import { execFileSync } from 'node:child_process'
import { AGENT_RUNTIME_CAPABILITIES } from '@gravitas/shared'
import { validateDevelopmentScope } from './development-task-service'
import { PILOT_DEFAULT_PRICE_EVIDENCE_ID } from './project-pilot-request-exit'
import { getPilotReviewedPriceEvidence } from './project-pilot-request-evidence'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  OwnerExecutionPreparationInput,
  OwnerExecutionPreparationSource,
  ProjectOwnerGoalSubject,
} from '@gravitas/shared'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getChannelById } from './channel-manager'
import { getWorkspaceMcpPath, getWorkspaceSkillsDir } from './config-paths'
import { validateControlledTarget } from './agent-controlled-context'
import { validateDevelopmentTarget } from './agent-development-context'
import { hasProjectWorkspaceBinding } from './project-workspace-bindings'
import {
  getProjectOwnerPlanDraft,
  getProjectOwnerPlanningContext,
} from './project-owner-plan-service'
import { getOwnerRuntimeBinding } from './project-owner-runtime-binding'
import { readCatalog } from './knowledge-catalog-service'
import {
  getTask,
  getActiveAgentEmployeeCapabilityVersions,
  getAgentEmployee,
} from './project-sqlite-store'

export class OwnerExecutionPreparationConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OwnerExecutionPreparationConflictError'
  }
}

/** 键顺序不构成身份；摘要不是防任意SQL写入的认证。 */
export function ownerExecutionHash(value: unknown): string {
  function stable(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(stable)
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, stable(item)]),
      )
    return v
  }
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
}
export function ownerExecutionObject(
  raw: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    Object.keys(raw).some((key) => !fields.includes(key))
  )
    throw new Error('Owner执行准备请求格式无效或含未知身份/权限字段')
  return raw as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000)
    throw new Error('Owner执行准备文字无效')
  return value.trim()
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new Error('Owner执行准备预算或版本无效')
  return value
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Owner执行准备清单无效')
  const list = value.map(text)
  if (new Set(list).size !== list.length) throw new Error('Owner执行准备清单重复')
  return list.sort()
}
export function parseOwnerExecutionSubject(raw: unknown): ProjectOwnerGoalSubject {
  const o = ownerExecutionObject(raw, ['projectId', 'taskId'])
  return {
    projectId: text(o.projectId),
    ...(o.taskId === undefined ? {} : { taskId: text(o.taskId) }),
  }
}
export function parseOwnerExecutionInput(raw: unknown): OwnerExecutionPreparationInput {
  const o = ownerExecutionObject(raw, [
    'requestId',
    'expectedPreparationRevision',
    'expectedPolicyRevision',
    'expectedGoalRevision',
    'expectedPlanRevision',
    'selectedStepKeys',
    'executionKind',
    'developmentScope',
    'executorEmployeeId',
    'reviewerEmployeeId',
    'workspaceId',
    'knowledgeSourceIds',
    'maxCostMicros',
    'maxRuns',
    'maxRework',
    'expiresAt',
    'changeReason',
  ])
  if (o.executionKind !== 'development' && o.executionKind !== 'controlled')
    throw new Error('Owner执行准备模式无效')
  let developmentScope: OwnerExecutionPreparationInput['developmentScope']
  if (o.executionKind === 'controlled' && o.developmentScope !== undefined)
    throw new Error('非代码准备不能继承研发写入范围')
  if (o.developmentScope !== undefined) {
    const scope = ownerExecutionObject(o.developmentScope, [
      'workspaceId',
      'targetPaths',
      'allowedPaths',
      'reviewerId',
      'decisionIds',
      'verificationCommands',
    ])
    developmentScope = {
      workspaceId: text(scope.workspaceId),
      targetPaths: strings(scope.targetPaths),
      allowedPaths: strings(scope.allowedPaths),
      ...(scope.reviewerId === undefined ? {} : { reviewerId: text(scope.reviewerId) }),
      ...(scope.decisionIds === undefined ? {} : { decisionIds: strings(scope.decisionIds) }),
      ...(scope.verificationCommands === undefined
        ? {}
        : { verificationCommands: strings(scope.verificationCommands) }),
    }
  }
  return {
    requestId: text(o.requestId),
    expectedPreparationRevision: integer(o.expectedPreparationRevision),
    expectedPolicyRevision:
      o.expectedPolicyRevision === null ? null : integer(o.expectedPolicyRevision, 1),
    expectedGoalRevision: integer(o.expectedGoalRevision, 1),
    expectedPlanRevision: integer(o.expectedPlanRevision, 1),
    selectedStepKeys: strings(o.selectedStepKeys),
    executionKind: o.executionKind,
    ...(developmentScope === undefined ? {} : { developmentScope }),
    executorEmployeeId: text(o.executorEmployeeId),
    reviewerEmployeeId: text(o.reviewerEmployeeId),
    workspaceId: text(o.workspaceId),
    knowledgeSourceIds: strings(o.knowledgeSourceIds),
    maxCostMicros: integer(o.maxCostMicros, 1),
    maxRuns: integer(o.maxRuns, 1),
    maxRework: integer(o.maxRework),
    expiresAt: integer(o.expiresAt, 1),
    changeReason: text(o.changeReason),
  }
}
function capabilityHash(slug: string): string {
  const mcpPath = getWorkspaceMcpPath(slug)
  // 不调用会解密凭据/损坏后回退空配置的MCP getter；只核验原件并存opaque摘要。
  const mcp: unknown = existsSync(mcpPath)
    ? JSON.parse(readFileSync(mcpPath, 'utf8'))
    : { servers: {} }
  if (
    !mcp ||
    typeof mcp !== 'object' ||
    Array.isArray(mcp) ||
    !('servers' in mcp) ||
    !mcp.servers ||
    typeof mcp.servers !== 'object' ||
    Array.isArray(mcp.servers)
  )
    throw new Error('Owner执行准备MCP配置无效')
  const directory = getWorkspaceSkillsDir(slug)
  const skills: Array<{ path: string; hash: string }> = []
  let bytes = 0,
    entries = 0
  function walk(root: string, relative = '', depth = 0): void {
    if (depth > 16) throw new Error('Owner技能资源层级超限，不能完整冻结')
    for (const name of readdirSync(root).sort()) {
      if (name === '.DS_Store') continue
      if (++entries > 2048) throw new Error('Owner技能资源数量超限，不能完整冻结')
      const path = join(root, name),
        key = relative ? `${relative}/${name}` : name,
        stat = lstatSync(path)
      // 不跟随任何资源symlink；不能沿技能引用读取无关Vault或密钥。
      if (
        stat.isSymbolicLink() ||
        name.startsWith('.') ||
        /\.(pem|key|p12|pfx)$/i.test(name) ||
        /^(secrets?|credentials?)([._-]|$)/i.test(name) ||
        /^id_(rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i.test(name)
      )
        throw new Error('Owner技能含链接、隐藏或敏感资源，不能安全冻结')
      if (stat.isDirectory()) {
        walk(path, key, depth + 1)
        continue
      }
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || bytes + stat.size > 32 * 1024 * 1024)
        throw new Error('Owner技能资源类型或大小超限')
      bytes += stat.size
      skills.push({
        path: key,
        hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
      })
    }
  }
  if (existsSync(directory)) {
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Owner技能根目录不能是链接')
    walk(directory)
  }
  return ownerExecutionHash({ mcp, skills })
}
export function buildOwnerExecutionSource(
  subject: ProjectOwnerGoalSubject,
  input: OwnerExecutionPreparationInput,
): OwnerExecutionPreparationSource {
  const context = getProjectOwnerPlanningContext(subject.projectId, subject.taskId)
  const plan = getProjectOwnerPlanDraft(subject.projectId, subject.taskId)
  if (!plan || plan.state !== 'confirmed') throw new Error('Owner计划尚未确认内容或来源已更新')
  if (
    context.goal.revision !== input.expectedGoalRevision ||
    plan.revision !== input.expectedPlanRevision
  )
    throw new OwnerExecutionPreparationConflictError('Owner目标或计划已更新，请重新预览')
  if (
    !input.selectedStepKeys.length ||
    input.selectedStepKeys.some((key) => !plan.proposal.steps.some((step) => step.key === key))
  )
    throw new Error('Owner执行准备步骤不存在或为空')
  if (
    plan.proposal.steps.some(
      (step) =>
        input.selectedStepKeys.includes(step.key) &&
        step.dependencies.some((key) => !input.selectedStepKeys.includes(key)),
    )
  )
    throw new Error('Owner执行准备必须包含所选步骤依赖闭包')
  if (input.expiresAt <= Date.now()) throw new Error('Owner执行准备期限已过期')
  if (input.executorEmployeeId === input.reviewerEmployeeId)
    throw new Error('Owner执行与评审人员必须不同')
  const executor = getAgentEmployee(input.executorEmployeeId),
    reviewer = getAgentEmployee(input.reviewerEmployeeId)
  if (
    !executor?.enabled ||
    !reviewer?.enabled ||
    executor.executionProfile !== input.executionKind ||
    reviewer.executionProfile !== input.executionKind
  )
    throw new Error('Owner执行或评审员工不存在、已停用或模式不符')
  const facts = { getChannel: getChannelById, getWorkspace: getAgentWorkspace }
  const validate =
    input.executionKind === 'controlled' ? validateControlledTarget : validateDevelopmentTarget
  const target = validate(executor, input.workspaceId, facts)
  validate(reviewer, input.workspaceId, facts)
  if (
    executor.channelId !== reviewer.channelId ||
    executor.modelId !== reviewer.modelId ||
    executor.runtime !== reviewer.runtime
  )
    throw new Error('Owner执行与评审必须明确同渠道、模型与Runtime')
  if (!hasProjectWorkspaceBinding(subject.projectId, input.workspaceId))
    throw new Error('Owner执行工作区未绑定当前项目')
  const workspace = getAgentWorkspace(input.workspaceId)!,
    channel = getChannelById(executor.channelId)!
  let repositoryIdentityHash: string | undefined
  let developmentScope: OwnerExecutionPreparationInput['developmentScope']
  if (input.executionKind === 'development') {
    if (!input.developmentScope || input.developmentScope.workspaceId !== input.workspaceId)
      throw new Error('Owner研发准备须明确同工作区的目标与允许修改范围')
    developmentScope = validateDevelopmentScope(input.developmentScope, {
      getWorkspace: getAgentWorkspace,
    })
    try {
      const repository = execFileSync(
        'git',
        ['-C', workspace.rootPath!, 'rev-parse', '--show-toplevel'],
        { timeout: 5000, stdio: 'pipe', encoding: 'utf8' },
      ).trim()
      const baseline = execFileSync('git', ['-C', workspace.rootPath!, 'rev-parse', 'HEAD'], {
        timeout: 5000,
        stdio: 'pipe',
        encoding: 'utf8',
      }).trim()
      repositoryIdentityHash = ownerExecutionHash({ repository, baseline })
    } catch {
      throw new Error('Owner研发工作区不是可核验Git仓库')
    }
  }
  const catalog = readCatalog()
  const bases = catalog.knowledgeBases.filter(
    (base) =>
      base.enabled &&
      catalog.bindings.some(
        (binding) => binding.projectId === subject.projectId && binding.knowledgeBaseId === base.id,
      ),
  )
  const knowledgeSources = input.knowledgeSourceIds.map((id) => {
    const source = catalog.sources.find((source) => source.id === id && source.enabled)
    const knowledgeBaseIds = bases
      .filter((base) => base.sourceIds.includes(id))
      .map((base) => base.id)
      .sort()
    if (!source || !knowledgeBaseIds.length)
      throw new Error('Owner资料不存在、停用或未正式关联当前项目')
    return {
      id,
      name: source.name,
      knowledgeBaseIds,
      metadataHash: ownerExecutionHash({
        source,
        bases: bases.filter((base) => knowledgeBaseIds.includes(base.id)),
      }),
      contentHash: null,
    }
  })
  // 排除heartbeat/统计更新时间；冻结真正影响执行配置的字段，不持久化原始prompt或密钥。
  const configurationHash = (employee: typeof executor): string =>
    ownerExecutionHash({
      id: employee.id,
      enabled: employee.enabled,
      name: employee.name,
      role: employee.role,
      executionProfile: employee.executionProfile,
      runtime: employee.runtime,
      permissionMode: employee.permissionMode,
      workspaceId: employee.workspaceId,
      workspaceIds: employee.workspaceIds,
      channelId: employee.channelId,
      modelId: employee.modelId,
      workflowId: employee.workflowId,
      systemPrompt: employee.systemPrompt,
      skills: employee.skills,
      capabilityVersions: getActiveAgentEmployeeCapabilityVersions(employee.id, input.workspaceId),
    })
  const binding = getOwnerRuntimeBinding(subject.projectId)
  const ownerBindingProvenance = binding
    ? {
        state: 'bound' as const,
        bindingRevision: binding.revision,
        carrierId: binding.carrierId,
        carrierFingerprint: binding.carrierFingerprint,
        bindingHash: ownerExecutionHash(binding),
      }
    : { state: 'none' as const }
  return {
    schemaVersion: 1,
    stage: 'pending_task_links',
    ...subject,
    ownerBindingProvenance,
    goalRevision: context.goal.revision,
    goalVersion: context.goal.goal.goalVersion,
    planRevision: plan.revision,
    planVersion: plan.planVersion,
    planFingerprint: plan.planFingerprint,
    contextFingerprint: plan.contextFingerprint,
    plan,
    selectedStepKeys: input.selectedStepKeys,
    executor: {
      id: executor.id,
      name: executor.name,
      configurationHash: configurationHash(executor),
    },
    reviewer: {
      id: reviewer.id,
      name: reviewer.name,
      configurationHash: configurationHash(reviewer),
    },
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceHash: ownerExecutionHash(workspace),
    ...(subject.taskId === undefined
      ? {}
      : { targetTaskHash: ownerExecutionHash(getTask(subject.taskId)) }),
    ...(repositoryIdentityHash === undefined ? {} : { repositoryIdentityHash }),
    channelId: channel.id,
    modelId: target.modelId,
    runtime: executor.runtime,
    channelHash: ownerExecutionHash(channel),
    capabilityConfigurationHash: capabilityHash(workspace.slug),
    ...(developmentScope === undefined ? {} : { developmentScope }),
    knowledgeSources,
    blockers: [
      '尚无权威业务任务与步骤关联，不能发行执行许可',
      '执行侧资料与逐请求Owner来源门禁尚未接通',
      '拟议预算不是已预留额度，不承诺金额硬封顶',
      ...(!AGENT_RUNTIME_CAPABILITIES[executor.runtime].supportsBudgetStopThreshold
        ? ['当前Runtime不支持费用停止阈值']
        : []),
      ...(getPilotReviewedPriceEvidence(PILOT_DEFAULT_PRICE_EVIDENCE_ID)?.model !== target.modelId
        ? ['当前模型不匹配已审核价格证据，不能据此发行']
        : []),
      ...(input.executionKind === 'controlled' ? ['非代码Pilot发行与资料适配器尚未接通'] : []),
    ],
  }
}
