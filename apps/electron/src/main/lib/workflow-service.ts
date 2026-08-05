/**
 * Workflow Run 服务。
 *
 * Definition 与 Run 分文件保存：Definition 只在编辑/发布时更新；
 * Run 使用原子 JSON 快照恢复状态，并用 JSONL 记录审计事件。
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  type WorkflowApprovalRecord,
  type WorkflowCapabilityPolicy,
  type WorkflowDefinition,
  type WorkflowImportInput,
  type WorkflowNodeRun,
  type WorkflowNodeRunStatus,
  type WorkflowPublishInput,
  type WorkflowRun,
  type WorkflowRunEvent,
  type WorkflowRunEventType,
  type WorkflowTriggerKind,
  WORKFLOW_PERMISSION_PROFILES,
  validateWorkflowCapabilities,
} from '@gravitas/shared'
import { parseWorkflowDefinition, exportWorkflowDefinition as buildWorkflowExportFile, importWorkflowDefinition as parseWorkflowImportFile } from '@gravitas/shared/workflow'
import {
  getWorkflowDefinitionPath,
  getWorkflowDir,
  getWorkflowRunEventsPath,
  getWorkflowRunPath,
  getWorkflowRunsDir,
  getWorkflowsDir,
} from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { getAgentWorkspace, getWorkspaceCapabilities } from './agent-workspace-manager'
import { resolveWorkflowApprovalAssignees } from './workflow-identity-service'

type SuccessfulNodeStatus = Extract<WorkflowNodeRunStatus, 'completed' | 'skipped'>

function isSuccessfulNodeStatus(status: WorkflowNodeRunStatus): status is SuccessfulNodeStatus {
  return status === 'completed' || status === 'skipped'
}

function isTerminalNodeStatus(status: WorkflowNodeRunStatus): boolean {
  return isSuccessfulNodeStatus(status) || status === 'failed' || status === 'cancelled' || status === 'blocked'
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const id = key(item)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** 合并所有节点引用的能力，作为 Run 创建时的冻结总览。 */
function collectCapabilityPolicy(definition: WorkflowDefinition): WorkflowCapabilityPolicy {
  const policies = definition.nodes.map((node) => node.capabilityPolicy).filter((policy): policy is WorkflowCapabilityPolicy => !!policy)
  return {
    skills: uniqueBy(policies.flatMap((policy) => policy.skills ?? []), (skill) => `${skill.slug}@${skill.version ?? ''}`),
    mcpServers: uniqueBy(policies.flatMap((policy) => policy.mcpServers ?? []), (server) => `${server.name}@${server.configFingerprint ?? ''}`),
    allowedTools: uniqueBy(policies.flatMap((policy) => policy.allowedTools ?? []), (tool) => tool),
    permissionProfileId: policies.map((policy) => policy.permissionProfileId).find((id) => !!id),
  }
}

function collectNodeCapabilityPolicies(definition: WorkflowDefinition): Record<string, WorkflowCapabilityPolicy> {
  return Object.fromEntries(
    definition.nodes
      .filter((node) => node.capabilityPolicy)
      .map((node) => [node.id, deepClone(node.capabilityPolicy!)]),
  )
}

function findWorkflowIdForRun(runId: string): string | null {
  for (const entry of readdirSync(getWorkflowsDir(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = getWorkflowRunPath(entry.name, runId)
    if (existsSync(candidate)) return entry.name
  }
  return null
}

function appendRunEvent(workflowId: string, event: WorkflowRunEvent): void {
  appendFileSync(getWorkflowRunEventsPath(workflowId, event.runId), `${JSON.stringify(event)}\n`, 'utf-8')
}

function persistRun(workflowId: string, run: WorkflowRun, event: Omit<WorkflowRunEvent, 'id' | 'runId' | 'occurredAt'>): WorkflowRun {
  const now = Date.now()
  run.updatedAt = now
  writeJsonFileAtomic(getWorkflowRunPath(workflowId, run.id), run)
  appendRunEvent(workflowId, {
    id: randomUUID(),
    runId: run.id,
    occurredAt: now,
    ...event,
  })
  return run
}

function getNodeRun(run: WorkflowRun, nodeId: string): WorkflowNodeRun {
  const nodeRun = run.nodeRuns[nodeId]
  if (!nodeRun) throw new Error(`Run 中不存在节点: ${nodeId}`)
  return nodeRun
}

function outgoingNodeIds(definition: WorkflowDefinition, nodeId: string): string[] {
  return definition.edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to)
}

function incomingNodeIds(definition: WorkflowDefinition, nodeId: string): string[] {
  return definition.edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from)
}

function markReadyChildren(run: WorkflowRun, completedNodeId: string): string[] {
  const definition = run.snapshot.definition
  const ready: string[] = []
  for (const childId of outgoingNodeIds(definition, completedNodeId)) {
    const child = getNodeRun(run, childId)
    if (child.status !== 'pending') continue
    const parents = incomingNodeIds(definition, childId)
    if (parents.every((parentId) => isSuccessfulNodeStatus(getNodeRun(run, parentId).status))) {
      child.status = 'ready'
      ready.push(childId)
    }
  }
  return ready
}

/** 条件分支未选中的节点仅在所有前置分支都被跳过时递归跳过，避免阻塞 Run。 */
function skipUnselectedBranch(run: WorkflowRun, initialNodeIds: string[]): string[] {
  const skipped: string[] = []
  const queue: string[] = []
  for (const nodeId of initialNodeIds) {
    const nodeRun = getNodeRun(run, nodeId)
    if (nodeRun.status !== 'pending') continue
    nodeRun.status = 'skipped'
    nodeRun.finishedAt = Date.now()
    skipped.push(nodeId)
    queue.push(...outgoingNodeIds(run.snapshot.definition, nodeId))
  }
  while (queue.length > 0) {
    const nodeId = queue.shift()!
    const nodeRun = getNodeRun(run, nodeId)
    if (nodeRun.status !== 'pending') continue
    const parents = incomingNodeIds(run.snapshot.definition, nodeId)
    if (!parents.every((parentId) => getNodeRun(run, parentId).status === 'skipped')) continue
    nodeRun.status = 'skipped'
    nodeRun.finishedAt = Date.now()
    skipped.push(nodeId)
    queue.push(...outgoingNodeIds(run.snapshot.definition, nodeId))
  }
  return skipped
}

function updateRunStatusFromNodes(run: WorkflowRun): void {
  const nodeRuns = Object.values(run.nodeRuns)
  if (nodeRuns.some((node) => node.status === 'waiting_approval')) {
    run.status = 'waiting_approval'
    return
  }
  if (nodeRuns.some((node) => node.status === 'failed')) {
    run.status = 'failed'
    run.finishedAt = Date.now()
    return
  }
  if (nodeRuns.every((node) => isSuccessfulNodeStatus(node.status))) {
    run.status = 'completed'
    run.finishedAt = Date.now()
    return
  }
  run.status = 'running'
}

/** 保存已通过 DSL 校验的 Definition。 */
export function saveWorkflowDefinition(input: unknown): WorkflowDefinition {
  const definition = parseWorkflowDefinition(input)
  const now = Date.now()
  const next = { ...definition, teamId: definition.teamId ?? 'personal', updatedAt: now }
  writeJsonFileAtomic(getWorkflowDefinitionPath(next.id), next)
  return next
}

/** 导出单份可移植 Definition；文件不包含运行记录、凭证或本地目录。 */
export function exportWorkflowDefinition(workflowId: string): ReturnType<typeof buildWorkflowExportFile> {
  const definition = getWorkflowDefinition(workflowId)
  if (!definition) throw new Error(`Workflow 不存在: ${workflowId}`)
  return buildWorkflowExportFile(definition)
}

/**
 * 将文件导入为目标工作区的新草稿。ID 由服务端生成或校验，避免覆盖已有流程。
 */
export function importWorkflowDefinition(input: WorkflowImportInput): WorkflowDefinition {
  const workspace = getAgentWorkspace(input.workspaceId)
  if (!workspace) throw new Error(`Workflow 所属工作区不存在: ${input.workspaceId}`)
  const workflowId = input.workflowId?.trim() || `workflow-${randomUUID()}`
  if (getWorkflowDefinition(workflowId)) throw new Error(`Workflow 已存在: ${workflowId}`)
  return saveWorkflowDefinition({ ...parseWorkflowImportFile(input.file, { workspaceId: input.workspaceId, workflowId }), teamId: workspace.teamId ?? 'personal' })
}

/**
 * 发布 Definition 前校验所属工作区的 Skill/MCP/权限档案。
 * 发布后的版本只能作为新 Run 的快照来源，Run 不会被后续草稿覆盖。
 */
export function publishWorkflowDefinition(workflowId: string, input: WorkflowPublishInput): WorkflowDefinition {
  const definition = getWorkflowDefinition(workflowId)
  if (!definition) throw new Error(`Workflow 不存在: ${workflowId}`)
  if (definition.status === 'archived') throw new Error('已归档 Workflow 不能发布')
  if (!input.version.trim()) throw new Error('发布版本不能为空')

  const workspace = getAgentWorkspace(definition.workspaceId)
  if (!workspace) throw new Error(`Workflow 所属工作区不存在: ${definition.workspaceId}`)
  const violations = validateWorkflowCapabilities(
    definition,
    getWorkspaceCapabilities(workspace.slug),
    WORKFLOW_PERMISSION_PROFILES,
  )
  if (violations.length > 0) {
    const messages = violations.map((item) => `${item.nodeId}:${item.capability}:${item.name}:${item.reason}`)
    throw new Error(`Workflow 能力预检失败: ${messages.join(', ')}`)
  }

  const now = Date.now()
  const published: WorkflowDefinition = {
    ...definition,
    status: 'published',
    version: input.version,
    publication: {
      version: input.version,
      publishedAt: now,
      publishedBy: input.publishedBy,
      changeSummary: input.changeSummary,
    },
    updatedAt: now,
  }
  return saveWorkflowDefinition(published)
}

/** 读取单个 Workflow Definition。 */
export function getWorkflowDefinition(workflowId: string): WorkflowDefinition | null {
  const definition = readJsonFileSafe<WorkflowDefinition>(getWorkflowDefinitionPath(workflowId))
  return definition ? parseWorkflowDefinition(definition) : null
}

/** 列出本地所有通过格式校验的 Definition；损坏文件不会阻断其他流程。 */
export function listWorkflowDefinitions(): WorkflowDefinition[] {
  const definitions: WorkflowDefinition[] = []
  for (const entry of readdirSync(getWorkflowsDir(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const definition = getWorkflowDefinition(entry.name)
      if (definition) definitions.push(definition)
    } catch (error) {
      console.error(`[Workflow] 跳过无法读取的 Definition: ${entry.name}`, error)
    }
  }
  return definitions.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 删除一个 Workflow Definition（含其全部 Run 快照、审计事件与模板安装关系）。
 *
 * 安全约束：存在正在进行的 Run（queued / running / waiting_approval / blocked）
 * 时拒绝删除，避免销毁正在执行的流程。模板源本身不受影响（模板是独立文件）。
 */
export function deleteWorkflowDefinition(workflowId: string): { deleted: boolean; reason?: string } {
  const definition = getWorkflowDefinition(workflowId)
  if (!definition) return { deleted: false, reason: 'Workflow 不存在' }

  const activeRun = listWorkflowRuns(workflowId).find((run) =>
    ['queued', 'running', 'waiting_approval', 'blocked'].includes(run.status),
  )
  if (activeRun) {
    return { deleted: false, reason: `存在进行中的 Run（${activeRun.status}），请先取消或等待其完成` }
  }

  try {
    rmSync(getWorkflowDir(workflowId), { recursive: true, force: true })
    console.log(`[Workflow] 已删除 Definition: ${workflowId}`)
    return { deleted: true }
  } catch (error) {
    console.error(`[Workflow] 删除 Definition 失败: ${workflowId}`, error)
    return { deleted: false, reason: error instanceof Error ? error.message : '删除失败' }
  }
}

/** 创建 Run 时冻结已发布 Definition 与能力引用。 */
export function createWorkflowRun(
  workflowId: string,
  input: Record<string, unknown>,
  trigger: WorkflowTriggerKind = 'manual',
): WorkflowRun {
  const definition = getWorkflowDefinition(workflowId)
  if (!definition) throw new Error(`Workflow 不存在: ${workflowId}`)
  if (definition.status !== 'published' || !definition.publication) {
    throw new Error('只有已发布的 Workflow 才能创建 Run')
  }

  const now = Date.now()
  const startNode = definition.nodes.find((node) => node.kind === 'start')
  if (!startNode) throw new Error('Workflow 缺少 start 节点')
  const nodeRuns: Record<string, WorkflowNodeRun> = {}
  for (const node of definition.nodes) {
    nodeRuns[node.id] = {
      nodeId: node.id,
      status: node.id === startNode.id ? 'completed' : 'pending',
      attempt: 0,
      ...(node.id === startNode.id && { startedAt: now, finishedAt: now }),
    }
  }

  const run: WorkflowRun = {
    id: randomUUID(),
    workspaceId: definition.workspaceId,
    teamId: definition.teamId ?? 'personal',
    snapshot: {
      definitionId: definition.id,
      definitionVersion: definition.publication.version,
      definition: deepClone(definition),
      nodeCapabilityPolicies: collectNodeCapabilityPolicies(definition),
      capabilityPolicy: collectCapabilityPolicy(definition),
    },
    status: 'running',
    trigger,
    input: deepClone(input),
    nodeRuns,
    approvals: [],
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  }
  const readyNodes = markReadyChildren(run, startNode.id)
  writeJsonFileAtomic(getWorkflowRunPath(workflowId, run.id), run)
  appendRunEvent(workflowId, { id: randomUUID(), runId: run.id, type: 'run_created', occurredAt: now, payload: { trigger } })
  for (const nodeId of readyNodes) {
    appendRunEvent(workflowId, { id: randomUUID(), runId: run.id, type: 'node_ready', occurredAt: now, nodeId })
  }
  return run
}

/** 读取 Run；找不到或文件损坏时返回 null。 */
export function getWorkflowRun(workflowId: string, runId: string): WorkflowRun | null {
  const run = readJsonFileSafe<WorkflowRun>(getWorkflowRunPath(workflowId, runId))
  if (!run) return null
  if (!run.teamId) {
    run.teamId = run.snapshot.definition.teamId ?? 'personal'
    writeJsonFileAtomic(getWorkflowRunPath(workflowId, runId), run)
  }
  return run
}

/** 按最近更新时间列出一个 Workflow 的运行快照。损坏文件不会阻断审计视图。 */
export function listWorkflowRuns(workflowId: string): WorkflowRun[] {
  const runs: WorkflowRun[] = []
  for (const entry of readdirSync(getWorkflowRunsDir(workflowId), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const run = getWorkflowRun(workflowId, entry.name.slice(0, -'.json'.length))
      if (run) runs.push(run)
    } catch (error) {
      console.error(`[Workflow] 跳过无法读取的 Run: ${entry.name}`, error)
    }
  }
  return runs.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 读取 Run 的审计事件。 */
export function listWorkflowRunEvents(workflowId: string, runId: string): WorkflowRunEvent[] {
  const path = getWorkflowRunEventsPath(workflowId, runId)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try { return [JSON.parse(line) as WorkflowRunEvent] } catch { return [] }
    })
}

/** 将 ready 节点置为 running，并增加一次执行尝试。 */
export function startWorkflowNode(workflowId: string, runId: string, nodeId: string): WorkflowRun {
  const run = getWorkflowRun(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  if (run.status !== 'running') throw new Error(`当前 Run 状态不允许开始节点: ${run.status}`)
  const nodeRun = getNodeRun(run, nodeId)
  if (nodeRun.status !== 'ready') throw new Error(`节点未就绪: ${nodeId}`)

  nodeRun.status = 'running'
  nodeRun.attempt += 1
  nodeRun.startedAt = Date.now()
  nodeRun.finishedAt = undefined
  return persistRun(workflowId, run, { type: 'node_started', nodeId, payload: { attempt: nodeRun.attempt } })
}

/**
 * 为 Tool 节点取得持久化执行租约。key 在同一 Run/节点内稳定，可透传给支持幂等的 MCP；
 * 进程崩溃后不能据此猜测远端结果，必须进入人工处置。
 */
export function acquireWorkflowSideEffectLease(workflowId: string, runId: string, nodeId: string, leaseDurationMs = 5 * 60_000): WorkflowRun {
  const run = getWorkflowRun(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  const node = run.snapshot.definition.nodes.find((item) => item.id === nodeId)
  if (node?.kind !== 'tool') throw new Error('只有 tool 节点可以取得副作用租约')
  const started = startWorkflowNode(workflowId, runId, nodeId)
  const nodeRun = getNodeRun(started, nodeId)
  nodeRun.sideEffect = { idempotencyKey: `${workflowId}:${runId}:${nodeId}`, leaseId: randomUUID(), leaseExpiresAt: Date.now() + leaseDurationMs, status: 'executing' }
  return persistRun(workflowId, started, { type: 'side_effect_lease_acquired', nodeId, payload: { idempotencyKey: nodeRun.sideEffect.idempotencyKey, leaseExpiresAt: nodeRun.sideEffect.leaseExpiresAt } })
}

/** 将结果不确定的副作用节点锁定为 blocked，禁止自动重试。 */
export function requireWorkflowSideEffectIntervention(workflowId: string, runId: string, nodeId: string, reason: string): WorkflowRun {
  const run = getWorkflowRun(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  const nodeRun = getNodeRun(run, nodeId)
  if (nodeRun.status !== 'running' || !nodeRun.sideEffect) throw new Error('当前节点没有待处置的副作用租约')
  nodeRun.status = 'blocked'
  nodeRun.finishedAt = Date.now()
  nodeRun.sideEffect.status = 'requires_intervention'
  nodeRun.sideEffect.reason = reason
  run.status = 'blocked'
  return persistRun(workflowId, run, { type: 'side_effect_intervention_required', nodeId, payload: { reason, idempotencyKey: nodeRun.sideEffect.idempotencyKey } })
}

/** 人工确认远端已完成、批准以相同幂等键重试，或放弃本次副作用。 */
export function resolveWorkflowSideEffect(workflowId: string, runId: string, nodeId: string, action: 'confirm' | 'retry' | 'abandon'): WorkflowRun {
  const run = getWorkflowRun(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  const nodeRun = getNodeRun(run, nodeId)
  if (nodeRun.status !== 'blocked' || nodeRun.sideEffect?.status !== 'requires_intervention') throw new Error('当前节点不需要副作用人工处置')
  if (action === 'retry') {
    nodeRun.status = 'ready'; nodeRun.finishedAt = undefined; nodeRun.error = undefined
    run.status = 'running'; run.finishedAt = undefined
  } else if (action === 'confirm') {
    nodeRun.status = 'completed'; nodeRun.finishedAt = Date.now(); nodeRun.sideEffect.status = 'confirmed'
    const readyNodes = markReadyChildren(run, nodeId); updateRunStatusFromNodes(run)
    persistRun(workflowId, run, { type: 'side_effect_resolved', nodeId, payload: { action, readyNodes } })
    for (const childNodeId of readyNodes) appendRunEvent(workflowId, { id: randomUUID(), runId, type: 'node_ready', occurredAt: Date.now(), nodeId: childNodeId })
    return run
  } else {
    nodeRun.status = 'failed'; nodeRun.finishedAt = Date.now(); nodeRun.error = { code: 'side_effect_abandoned', message: '人工放弃不确定的外部副作用', retryable: false }; updateRunStatusFromNodes(run)
  }
  return persistRun(workflowId, run, { type: 'side_effect_resolved', nodeId, payload: { action } })
}

/** 启动恢复时调用：任何遗留 executing 副作用节点都升级为人工处置，绝不自动重放。 */
export function recoverWorkflowSideEffects(): WorkflowRun[] {
  const recovered: WorkflowRun[] = []
  for (const run of listRecoverableWorkflowRuns()) {
    const workflowId = run.snapshot.definitionId
    for (const nodeRun of Object.values(run.nodeRuns)) {
      if (nodeRun.sideEffect?.status === 'executing' && nodeRun.status === 'running') recovered.push(requireWorkflowSideEffectIntervention(workflowId, run.id, nodeRun.nodeId, '检测到应用重启或执行中断，远端副作用结果未知'))
    }
  }
  return recovered
}

/** 完成执行节点并推进所有已满足前置条件的后继节点。 */
export function completeWorkflowNode(
  workflowId: string,
  runId: string,
  nodeId: string,
  output: Record<string, unknown> = {},
  options: { selectedOutgoingNodeIds?: string[] } = {},
): WorkflowRun {
  const run = getWorkflowRun(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  const nodeRun = getNodeRun(run, nodeId)
  if (nodeRun.status !== 'running') throw new Error(`节点未运行，不能完成: ${nodeId}`)

  nodeRun.status = 'completed'
  if (nodeRun.sideEffect) nodeRun.sideEffect.status = 'confirmed'
  nodeRun.output = deepClone(output)
  nodeRun.finishedAt = Date.now()
  const selected = options.selectedOutgoingNodeIds ? new Set(options.selectedOutgoingNodeIds) : null
  const outgoing = outgoingNodeIds(run.snapshot.definition, nodeId)
  if (selected && [...selected].some((childId) => !outgoing.includes(childId))) {
    throw new Error('条件分支包含非当前节点的后继节点')
  }
  const skippedNodes = selected ? skipUnselectedBranch(run, outgoing.filter((childId) => !selected.has(childId))) : []
  const readyNodes = markReadyChildren(run, nodeId).filter((childId) => !selected || selected.has(childId))
  updateRunStatusFromNodes(run)
  persistRun(workflowId, run, { type: 'node_completed', nodeId, payload: { readyNodes } })
  for (const childNodeId of readyNodes) {
    appendRunEvent(workflowId, { id: randomUUID(), runId, type: 'node_ready', occurredAt: Date.now(), nodeId: childNodeId })
  }
  for (const childNodeId of skippedNodes) {
    appendRunEvent(workflowId, { id: randomUUID(), runId, type: 'node_skipped', occurredAt: Date.now(), nodeId: childNodeId })
  }
  if (run.status === 'completed') {
    appendRunEvent(workflowId, { id: randomUUID(), runId, type: 'run_completed', occurredAt: Date.now() })
  }
  return run
}

/** 记录节点失败；是否可继续重试由 retryWorkflowNode 显式决定。 */
export function failWorkflowNode(
  workflowId: string,
  runId: string,
  nodeId: string,
  error: { code: string; message: string; retryable: boolean },
): WorkflowRun {
  const run = getWorkflowRun(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  const definitionNode = run.snapshot.definition.nodes.find((node) => node.id === nodeId)
  const nodeRun = getNodeRun(run, nodeId)
  if (nodeRun.status !== 'running') throw new Error(`节点未运行，不能失败: ${nodeId}`)

  nodeRun.error = deepClone(error)
  nodeRun.finishedAt = Date.now()
  const strategy = definitionNode?.onFailure ?? 'fail'
  if (strategy === 'continue' || strategy === 'route_to_error') {
    nodeRun.status = 'completed'
    const outgoing = outgoingNodeIds(run.snapshot.definition, nodeId)
    const selected = strategy === 'route_to_error'
      ? new Set(run.snapshot.definition.edges.filter((edge) => edge.from === nodeId && edge.label?.toLowerCase() === 'error').map((edge) => edge.to))
      : null
    const skippedNodes = selected ? skipUnselectedBranch(run, outgoing.filter((childId) => !selected.has(childId))) : []
    const readyNodes = markReadyChildren(run, nodeId).filter((childId) => !selected || selected.has(childId))
    updateRunStatusFromNodes(run)
    persistRun(workflowId, run, { type: 'node_failed', nodeId, payload: { error, recoveredBy: strategy, readyNodes } })
    for (const childNodeId of readyNodes) appendRunEvent(workflowId, { id: randomUUID(), runId, type: 'node_ready', occurredAt: Date.now(), nodeId: childNodeId })
    for (const childNodeId of skippedNodes) appendRunEvent(workflowId, { id: randomUUID(), runId, type: 'node_skipped', occurredAt: Date.now(), nodeId: childNodeId })
    if (run.status === 'completed') appendRunEvent(workflowId, { id: randomUUID(), runId, type: 'run_completed', occurredAt: Date.now() })
    return run
  }

  nodeRun.status = 'failed'
  updateRunStatusFromNodes(run)
  return persistRun(workflowId, run, { type: 'node_failed', nodeId, payload: { error } })
}

/** 对可重试的失败节点创建下一次尝试。 */
export function retryWorkflowNode(workflowId: string, runId: string, nodeId: string): WorkflowRun {
  const run = getWorkflowRun(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  const definitionNode = run.snapshot.definition.nodes.find((node) => node.id === nodeId)
  const nodeRun = getNodeRun(run, nodeId)
  if (!definitionNode?.retry || nodeRun.status !== 'failed' || !nodeRun.error?.retryable) {
    throw new Error('该节点当前不可重试')
  }
  if (nodeRun.attempt >= definitionNode.retry.maxAttempts) {
    throw new Error('节点已达到最大重试次数')
  }

  nodeRun.status = 'ready'
  nodeRun.error = undefined
  nodeRun.finishedAt = undefined
  run.status = 'running'
  run.finishedAt = undefined
  return persistRun(workflowId, run, { type: 'node_retry_scheduled', nodeId, payload: { nextAttempt: nodeRun.attempt + 1 } })
}

/** 请求人工审批，Run 会停在 waiting_approval，直到显式处理。 */
export function requestWorkflowApproval(workflowId: string, runId: string, nodeId: string): WorkflowRun {
  const run = getWorkflowRun(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  const node = run.snapshot.definition.nodes.find((item) => item.id === nodeId)
  const nodeRun = getNodeRun(run, nodeId)
  if (node?.kind !== 'approval' || nodeRun.status !== 'ready') throw new Error('只有就绪的 approval 节点可以请求审批')
  const config = node.config as import('@gravitas/shared').WorkflowApprovalConfig
  const assigneeIds = resolveWorkflowApprovalAssignees(run.snapshot.definition, config)

  const approval: WorkflowApprovalRecord = {
    id: randomUUID(),
    nodeId,
    status: 'pending',
    requestedAt: Date.now(),
    assigneeIds,
  }
  nodeRun.status = 'waiting_approval'
  nodeRun.startedAt = approval.requestedAt
  run.approvals.push(approval)
  run.status = 'waiting_approval'
  return persistRun(workflowId, run, { type: 'approval_requested', nodeId, payload: { approvalId: approval.id, assigneeIds } })
}

/** 审批通过后推进后继节点；拒绝会使 Run 失败且保留审批证据。 */
export function resolveWorkflowApproval(
  workflowId: string,
  runId: string,
  approvalId: string,
  decision: { approved: boolean; resolvedBy?: string; comment?: string; editedOutput?: Record<string, unknown> },
): WorkflowRun {
  const run = getWorkflowRun(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  const approval = run.approvals.find((item) => item.id === approvalId)
  if (!approval || approval.status !== 'pending') throw new Error('审批不存在或已处理')
  const nodeRun = getNodeRun(run, approval.nodeId)
  if (nodeRun.status !== 'waiting_approval') throw new Error('审批节点当前不在等待状态')
  if (!decision.resolvedBy || !approval.assigneeIds.includes(decision.resolvedBy)) {
    throw new Error('当前主体不在该审批的冻结审批人列表中')
  }

  const now = Date.now()
  approval.status = decision.approved ? 'approved' : 'rejected'
  approval.resolvedAt = now
  approval.resolvedBy = decision.resolvedBy
  approval.comment = decision.comment
  approval.editedOutput = decision.editedOutput ? deepClone(decision.editedOutput) : undefined
  nodeRun.finishedAt = now
  if (!decision.approved) {
    nodeRun.status = 'failed'
    nodeRun.error = { code: 'approval_rejected', message: decision.comment ?? '审批被拒绝', retryable: false }
    updateRunStatusFromNodes(run)
    return persistRun(workflowId, run, { type: 'approval_resolved', nodeId: approval.nodeId, payload: { approvalId, approved: false } })
  }

  nodeRun.status = 'completed'
  nodeRun.output = decision.editedOutput ? deepClone(decision.editedOutput) : {}
  const readyNodes = markReadyChildren(run, approval.nodeId)
  updateRunStatusFromNodes(run)
  persistRun(workflowId, run, { type: 'approval_resolved', nodeId: approval.nodeId, payload: { approvalId, approved: true, readyNodes } })
  for (const childNodeId of readyNodes) {
    appendRunEvent(workflowId, { id: randomUUID(), runId, type: 'node_ready', occurredAt: Date.now(), nodeId: childNodeId })
  }
  if (run.status === 'completed') appendRunEvent(workflowId, { id: randomUUID(), runId, type: 'run_completed', occurredAt: Date.now() })
  return run
}

/** 取消 Run，并将所有尚未结束的节点标记为 cancelled。 */
export function cancelWorkflowRun(workflowId: string, runId: string): WorkflowRun {
  const run = getWorkflowRun(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  if (run.status === 'completed' || run.status === 'cancelled') throw new Error(`当前 Run 状态不能取消: ${run.status}`)
  const now = Date.now()
  for (const nodeRun of Object.values(run.nodeRuns)) {
    if (!isTerminalNodeStatus(nodeRun.status)) {
      nodeRun.status = 'cancelled'
      nodeRun.finishedAt = now
    }
  }
  run.status = 'cancelled'
  run.finishedAt = now
  return persistRun(workflowId, run, { type: 'run_cancelled' })
}

/** 列出重启后仍需恢复/处理的 Run；不会自动重放有副作用的节点。 */
export function listRecoverableWorkflowRuns(): WorkflowRun[] {
  const runs: WorkflowRun[] = []
  for (const definition of listWorkflowDefinitions()) {
    for (const entry of readdirSync(getWorkflowRunsDir(definition.id), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const runId = entry.name.slice(0, -'.json'.length)
      const run = getWorkflowRun(definition.id, runId)
      if (run && (run.status === 'running' || run.status === 'waiting_approval' || run.status === 'blocked')) runs.push(run)
    }
  }
  return runs.sort((a, b) => a.updatedAt - b.updatedAt)
}

/** 按 Run ID 查找所属 Workflow，供 IPC/恢复入口使用。 */
export function findWorkflowRun(runId: string): WorkflowRun | null {
  const workflowId = findWorkflowIdForRun(runId)
  return workflowId ? getWorkflowRun(workflowId, runId) : null
}
