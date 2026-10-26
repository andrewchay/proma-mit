import { assertOwnerReviewerTextDelivery } from './project-owner-text-delivery'
import { ownerDevelopmentArtifactFromPrompt } from './project-owner-development-artifact'
import { readOwnerCommandFrozenSource } from './project-owner-employee-runtime'
import { readOwnerCommandRuntime, assertOwnerCommandPrice } from './project-owner-employee-runtime'
/** Owner业务执行侧休眠门禁：资料fence/逐请求核验/purpose。本片不发行、不派工，gate行无生产创建路径。 */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { resolveAgentRuntimeBaseUrl } from '@gravitas/shared'
import type { OwnerExecutionRevalidationRecord } from '@gravitas/shared'
import { dirname, relative, resolve, sep } from 'node:path'
import { getAgentWorkspace, getAgentWorkspaceCwd } from './agent-workspace-manager'
import { getChannelById } from './channel-manager'
import { isProtectedDevelopmentPath, normalizeRepoRelativePath, pathWithinAllowed } from './development-task-service'
import * as store from './project-sqlite-store'
import { getAgentSessionMeta } from './agent-session-manager'
import {
  hasOwnerBusinessSessionEvidence,
  assertNoOwnerBusinessSession,
} from './project-owner-task-evidence'
/**
 * 重验证/材料化/policy模块按需加载：fence对无Owner证据会话零图影响，
 * 不把channel-manager/plan-service等重依赖拉进只窄mock核心模块的旧测试图。
 */
type RevalidationModule = typeof import('./project-owner-execution-revalidation')
type MaterializationModule = typeof import('./project-owner-task-materialization')
type PolicyModule = typeof import('./project-pilot-policy')
let revalidationModule: RevalidationModule | null = null
let materializationModule: MaterializationModule | null = null
let policyModule: PolicyModule | null = null
function revalidation(): RevalidationModule { return (revalidationModule ??= require('./project-owner-execution-revalidation') as RevalidationModule) }
function materialization(): MaterializationModule { return (materializationModule ??= require('./project-owner-task-materialization') as MaterializationModule) }
function pilotPolicy(): PolicyModule { return (policyModule ??= require('./project-pilot-policy') as PolicyModule) }
import { getStoreHandle } from './knowledge-index-service'
import { resolveRetrievableScope } from './knowledge-scope-service'
import { hasApprovedOwnerAction } from './project-owner-action-approval'
import { resolvePiBaseUrl } from './adapters/pi-runtime-base-url'

/** 知识读取需经过资料fence；Owner文件写入仅在逐次审批后开放。 */
export const OWNER_TOOL_ALLOWED = new Set(['SearchKnowledge', 'ReadKnowledgeSource'])
const SNAPSHOT_MAX_DOCUMENTS = 2048

export interface OwnerGateSessionRow {
  sessionId: string
  executionId: string
  revalidationId: string
  revalidationIntegrityHash: string
  contentSnapshotHash: string
  providerAdmittedAt: number | null
  createdAt: number
}

/** Owner执行只允许工作区内的Write/Edit进入逐次审批；执行阶段还会核对批准后的完整参数指纹。 */
export function isOwnerWorkspaceFileActionCandidate(sessionId: string, toolName: string, args?: Record<string, unknown>): boolean {
  if (toolName !== 'Write' && toolName !== 'Edit') return false
  const context = resolveOwnerExecutionGateSession(sessionId)
  if (context.kind !== 'owner_business') return false
  const filePath = typeof args?.file_path === 'string' ? args.file_path.trim() : ''
  if (!filePath) return false
  const workspace = getAgentWorkspace(context.record.source.workspaceId)
  if (!workspace) return false
  const root = resolve(getAgentWorkspaceCwd(workspace, sessionId))
  const target = resolve(root, filePath)
  if (target === root || !target.startsWith(`${root}${sep}`)) return false
  try {
    const scope = developmentScopeForExecution(context)
    if (scope) {
      const relativePath = normalizeRepoRelativePath(relative(root, target).split(sep).join('/'))
      if (!pathWithinAllowed(relativePath, scope.allowedPaths) || isProtectedDevelopmentPath(relativePath)) return false
    }
    const realRoot = realpathSync(root)
    const realParent = realpathSync(dirname(target))
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) return false
    try {
      const targetStat = lstatSync(target)
      if (targetStat.isSymbolicLink() || (targetStat.isFile() && targetStat.nlink !== 1)) return false
    } catch { /* 新文件尚不存在时由Write创建。 */ }
    return true
  } catch {
    return false
  }
}

/** 研发Owner会话只读已确认的工作区内允许范围；拒绝链接、硬链接和非普通文件。 */
function assertOwnerDevelopmentRead(sessionId: string, args?: Record<string, unknown>): void {
  const context = resolveOwnerExecutionGateSession(sessionId)
  if (context.kind !== 'owner_business') throw new Error('Owner代码读取缺少已确认的研发范围')
  const scope = developmentScopeForExecution(context)
  if (!scope) throw new Error('Owner代码读取缺少已确认的研发范围')
  const filePath = typeof args?.file_path === 'string' ? args.file_path.trim() : ''
  if (!filePath) throw new Error('Owner代码读取需要仓库相对文件路径')
  const relativePath = normalizeRepoRelativePath(filePath)
  if (!pathWithinAllowed(relativePath, scope.allowedPaths) || isProtectedDevelopmentPath(relativePath)) throw new Error('目标文件不在Owner已确认的读取范围内')
  const workspace = getAgentWorkspace(scope.workspaceId)
  if (!workspace) throw new Error('Owner代码工作区已失效')
  const root = resolve(getAgentWorkspaceCwd(workspace, sessionId))
  const target = resolve(root, ...relativePath.split('/'))
  if (target === root || !target.startsWith(`${root}${sep}`)) throw new Error('Owner代码读取路径越出工作区')
  const realRoot = realpathSync(root)
  const realTarget = realpathSync(target)
  if (realTarget !== target || !realTarget.startsWith(`${realRoot}${sep}`)) throw new Error('Owner代码读取拒绝符号链接或工作区外路径')
  const stat = lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new Error('Owner代码读取仅允许大小受限的普通文件')
}
export type OwnerSessionGateContext =
  | { kind: 'unrestricted' }
  | { kind: 'restricted'; reason: string }
  | { kind: 'owner_business'; subject: { projectId: string; taskId?: string }; record: OwnerExecutionRevalidationRecord; executionId: string; gate: OwnerGateSessionRow | null }

type OwnerBusinessChain = { kind: 'owner_business'; subject: { projectId: string; taskId?: string }; record: OwnerExecutionRevalidationRecord; executionId: string; gate: OwnerGateSessionRow | null }
function developmentScopeForExecution(context: OwnerBusinessChain) {
  const execution = store.getAgentExecution(context.executionId)
  return execution ? context.record.source.tasks.find(task => task.taskId === execution.entityId)?.developmentScope : undefined
}
function resolveOwnerBusinessChain(sessionId: string): { kind: 'restricted'; reason: string } | OwnerBusinessChain {
  try {
    const execution = (store.getProjectDb().prepare("SELECT id, entity_id, owner_command_id FROM agent_executions WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC").all(sessionId) as Array<{ id: string; entity_id: string; owner_command_id: string | null }>)
      .find(row => store.hasOwnerBusinessExecutionEvidence(row.id) || Boolean(row.owner_command_id))
    if (!execution) return { kind: 'restricted', reason: 'Owner业务会话无运行中execution，工具执行拒绝' }
    const task = store.getTask(execution.entity_id)
    if (!task?.ownerStepLinkId) return { kind: 'restricted', reason: 'Owner任务标记缺失，工具执行拒绝' }
    const linkRow = store.getProjectDb().prepare('SELECT materialization_id, project_id FROM project_owner_task_step_links WHERE id = ? AND task_id = ?').get(task.ownerStepLinkId, task.id) as { materialization_id: string; project_id: string } | undefined
    if (!linkRow) return { kind: 'restricted', reason: 'Owner步骤关联缺失，工具执行拒绝' }
    const batch = materialization().getOwnerTaskMaterializationRecord(linkRow.project_id, linkRow.materialization_id)
    const subject = { projectId: batch.projectId, ...(batch.taskId ? { taskId: batch.taskId } : {}) }
    const view = revalidation().getOwnerExecutionRevalidation(subject)
    if (view.status !== 'current' || !view.revalidation) return { kind: 'restricted', reason: `Owner重验证来源非current（${view.status}），工具执行拒绝` }
    const record = view.revalidation
    const gate = store.getProjectDb().prepare('SELECT * FROM project_owner_execution_gate_sessions WHERE session_id = ?').get(sessionId) as { session_id: string; execution_id: string; revalidation_id: string; revalidation_integrity_hash: string; content_snapshot_hash: string; provider_admitted_at: number | null; created_at: number } | undefined
    return { kind: 'owner_business', subject, record, executionId: execution.id, gate: gate ? { sessionId: gate.session_id, executionId: gate.execution_id, revalidationId: gate.revalidation_id, revalidationIntegrityHash: gate.revalidation_integrity_hash, contentSnapshotHash: gate.content_snapshot_hash, providerAdmittedAt: gate.provider_admitted_at, createdAt: gate.created_at } : null }
  } catch (error) {
    return { kind: 'restricted', reason: error instanceof Error ? error.message : 'Owner门禁链核验失败' }
  }
}
/** 公开谓词上下文：owner_business要求已准入gate；未准入/已过期=restricted（admit内部用chain直连）。 */
export function resolveOwnerExecutionGateSession(sessionId: string): OwnerSessionGateContext {
  const hasCommandLink = Boolean(store.getProjectDb().prepare('SELECT 1 FROM agent_executions WHERE session_id=? AND owner_command_id IS NOT NULL LIMIT 1').get(sessionId))
  if (!hasOwnerBusinessSessionEvidence(sessionId) && !hasCommandLink) return { kind: 'unrestricted' }
  const chain = resolveOwnerBusinessChain(sessionId)
  if (chain.kind !== 'owner_business') return chain
  if (!chain.gate || chain.gate.executionId !== chain.executionId || chain.gate.revalidationId !== chain.record.id || chain.gate.revalidationIntegrityHash !== chain.record.integrityHash) return { kind: 'restricted', reason: 'Owner会话门禁未准入或已过期，工具执行拒绝' }
  return chain
}

/** 工具目录必须与当前用途契约一致；null表示普通会话，受限Owner绝不加载MCP或其他工具。 */
export function getOwnerExecutionToolNames(sessionId: string): ReadonlySet<string> | null {
  const context = resolveOwnerExecutionGateSession(sessionId)
  if (context.kind === 'unrestricted') return null
  if (context.kind !== 'owner_business') return new Set()
  const fileActions = context.record.source.textDeliveryVersion === 1 ? [] : ['Write', 'Edit']
  return new Set([...OWNER_TOOL_ALLOWED, ...(developmentScopeForExecution(context) ? ['Read'] : []), ...fileActions])
}

function frozenSourceIds(record: OwnerExecutionRevalidationRecord): string[] {
  return [...new Set(record.source.knowledgeSources.map(source => source.id))]
}
/** 准入/读取共用：冻结集合内已索引文档的快照指纹；只证准入时刻=校验时刻，不冒充内容认证。 */
export function computeOwnerKnowledgeSnapshotHash(sourceIds: readonly string[]): string {
  if (!sourceIds.length) return createHash('sha256').update('[]').digest('hex')
  const handle = getStoreHandle()
  if (!handle) throw new Error('知识索引库未打开，Owner资料fence无法核验')
  const tuples: Array<[string, string, string]> = []
  for (const sourceId of sourceIds) {
    for (const doc of handle.knowledge.listDocumentsBySource(sourceId)) {
      tuples.push([sourceId, doc.relativePath, doc.contentHash])
      if (tuples.length > SNAPSHOT_MAX_DOCUMENTS) throw new Error('Owner冻结资料文档数超出门禁上限，拒绝准入')
    }
  }
  tuples.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]))
  return createHash('sha256').update(JSON.stringify(tuples)).digest('hex')
}
/** 仅供未来claim链调用+测试；本片无生产调用方。准入要求完整权威链current并冻结内容快照。 */
export function admitOwnerExecutionGateSession(executionId: string, sessionId: string): OwnerGateSessionRow {
  const database = store.getProjectDb()
  if (database.isTransactionActive()) throw new Error('Owner门禁准入拒绝未提交外层事务')
  // 无Owner证据且无owner命令执行时chain返回unrestricted；可核验owner命令执行（豁免）同样走准入。
  const hasEvidence = hasOwnerBusinessSessionEvidence(sessionId)
  const context = resolveOwnerBusinessChain(sessionId)
  if (!hasEvidence && context.kind !== 'owner_business') throw new Error('会话无Owner业务用途，不需要门禁准入')
  if (context.kind === 'restricted') throw new Error(`Owner门禁准入失败：${context.reason}`)
  if (context.gate) {
    if (context.gate.executionId !== executionId) throw new Error('Owner门禁已准入其他执行身份')
    return context.gate
  }
  const snapshot = computeOwnerKnowledgeSnapshotHash(frozenSourceIds(context.record))
  const timestamp = Date.now()
  database.prepare('INSERT INTO project_owner_execution_gate_sessions(session_id,execution_id,revalidation_id,revalidation_integrity_hash,content_snapshot_hash,provider_admitted_at,created_at) VALUES(?,?,?,?,?,NULL,?)').run(sessionId, executionId, context.record.id, context.record.integrityHash, snapshot, timestamp)
  return { sessionId, executionId, revalidationId: context.record.id, revalidationIntegrityHash: context.record.integrityHash, contentSnapshotHash: snapshot, providerAdmittedAt: null, createdAt: timestamp }
}
/** 记录一次被fence放行的ReadKnowledgeSource授权（出处级，不存正文）。 */
function recordKnowledgeReadPermission(context: Extract<OwnerSessionGateContext, { kind: 'owner_business' }>, sourceId: string, knowledgeBaseId: string | null, documentId: string | null, contentHash: string | null): void {
  // 出处级审计：只存IDs/hash/时间戳，不存正文；id由随机UUID保证非NULL主键。
  store.getProjectDb().prepare('INSERT INTO project_owner_execution_knowledge_reads(id,session_id,execution_id,revalidation_id,source_id,knowledge_base_id,document_id,content_hash,char_start,char_end,read_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?)').run(randomUUID(), context.gate!.sessionId, context.gate!.executionId, context.record.id, sourceId, knowledgeBaseId, documentId, contentHash, Date.now())
}
/** purpose感知工具谓词：Owner知识读取走资料fence，工作区Write/Edit须先通过逐次审批。 */
export function assertToolAllowedForSessionPurpose(sessionId: string, toolName: string, args?: Record<string, unknown>): void {
  const context = resolveOwnerExecutionGateSession(sessionId)
  if (context.kind === 'unrestricted') return
  if (context.kind === 'owner_business' && toolName === 'Read') {
    assertOwnerDevelopmentRead(sessionId, args)
    return
  }
  if (!OWNER_TOOL_ALLOWED.has(toolName)) {
    if (context.kind === 'restricted') throw new Error(context.reason)
    if (context.kind === 'owner_business') {
      if (context.record.source.textDeliveryVersion !== 1
        && isOwnerWorkspaceFileActionCandidate(sessionId, toolName, args)
        && hasApprovedOwnerAction(sessionId, { toolName, toolInput: args ?? {} })) return
      throw new Error('Owner业务会话仅允许工作区内Write/Edit经逐次人工审批后执行')
    }
    assertNoOwnerBusinessSession(sessionId)
    return
  }
  if (context.kind === 'restricted') throw new Error(context.reason)
  // Owner业务会话：知识工具走fence（准入+快照重验+三层交集）。
  const policy = pilotPolicy().getPilotPolicy(context.subject.projectId)
  if (policy?.state !== 'paused' || policy.ownerExecutionRevalidation?.id !== context.record.id) assertNoOwnerBusinessSession(sessionId)
  const frozen = new Set(frozenSourceIds(context.record))
  // 快照重验先于范围交集：内容漂移=门禁级失效，与具体工具无关。
  const current = computeOwnerKnowledgeSnapshotHash([...frozen])
  if (current !== context.gate!.contentSnapshotHash) throw new Error('Owner资料内容快照已漂移，读取拒绝；请重新走门禁准入')
  const meta = getAgentSessionMeta(sessionId)
  const liveSourceIds = meta ? resolveRetrievableScope({
    sessionId,
    sessionMeta: { knowledgeScopeMode: meta.knowledgeScopeMode, explicitKnowledgeBaseIds: meta.explicitKnowledgeBaseIds, projectId: meta.projectId, workspaceId: meta.workspaceId },
  }).sources.map(source => source.id) : []
  const allowed = liveSourceIds.filter(sourceId => frozen.has(sourceId))
  if (toolName === 'ReadKnowledgeSource') {
    // 工具schema是documentId；解析回真实source再比对冻结白名单。
    const documentId = typeof args?.documentId === 'string' ? args.documentId.trim() : ''
    const handle = getStoreHandle()
    const doc = documentId && handle ? handle.knowledge.getDocument(documentId) : null
    const sourceId = doc?.sourceId ?? ''
    if (!sourceId || !frozen.has(sourceId) || !allowed.includes(sourceId)) throw new Error('目标资料不在Owner冻结白名单内，读取拒绝')
    recordKnowledgeReadPermission(context, sourceId, doc?.knowledgeBaseId ?? null, doc?.id ?? null, doc?.contentHash ?? null)
  }
  if (!allowed.length) throw new Error('Owner冻结资料集合与当前会话范围无交集，读取拒绝')
}
/** 逐请求Owner分支（休眠）：旧guard先行拒绝后本函数对controlled_task用途立即返回；owner用途须全链核验。 */
export function assertOwnerExecutionRequestGate(input: { commandPurpose: string; sessionId: string; runtime: string; modelId: string; permissionMode: string; cwd: string; baseUrl: string; requestUrl: string }): void {
  if (input.commandPurpose === 'controlled_task') return
  if (input.commandPurpose !== 'owner_business_execution') throw new Error(`未知Pilot命令用途：${input.commandPurpose}`)
  const context = resolveOwnerExecutionGateSession(input.sessionId)
  if (context.kind !== 'owner_business' || !context.gate) throw new Error('Owner用途请求缺少有效门禁会话')
  const policy = pilotPolicy().getPilotPolicy(context.subject.projectId)
  const record = context.record, execution = store.getAgentExecution(context.executionId)
  const command = execution?.ownerCommandId && store.getProjectDb().prepare('SELECT grant_id, project_id, execution_id, employee_id, state, role, source_task_id, source_step_link_id, rework_ordinal FROM project_owner_execution_commands WHERE id=?').get(execution.ownerCommandId) as { grant_id: string; project_id: string; execution_id: string; employee_id: string; state: string; role: string; source_task_id: string; source_step_link_id: string; rework_ordinal: number } | undefined
  const grant = command && store.getProjectDb().prepare('SELECT state, expires_at, channel_id, model_id, workspace_id, runtime FROM project_owner_execution_grants WHERE id=? AND project_id=?').get(command.grant_id, context.subject.projectId) as { state: string; expires_at: number; channel_id: string; model_id: string; workspace_id: string; runtime: string } | undefined
  const employee = command ? store.getAgentEmployee(command.employee_id) : undefined
  const runtime = execution?.ownerCommandId ? readOwnerCommandRuntime(execution.ownerCommandId) : null
  if (command && command.role === 'reviewer' && execution?.ownerCommandId) {
    const frozen = readOwnerCommandFrozenSource(execution.ownerCommandId).source
    if (frozen.executionKind === 'development') {
      const artifact = ownerDevelopmentArtifactFromPrompt(execution.prompt ?? '')
      const executors = store.getProjectDb().prepare(`SELECT id, execution_id FROM project_owner_execution_commands
        WHERE grant_id=? AND source_task_id=? AND source_step_link_id=? AND role='executor' AND rework_ordinal=?`).all(
        command.grant_id, command.source_task_id, command.source_step_link_id, command.rework_ordinal,
      ) as Array<{ id: string; execution_id: string | null }>
      if (!artifact || executors.length !== 1 || artifact.executorCommandId !== executors[0]!.id
        || artifact.executorExecutionId !== executors[0]!.execution_id) throw new Error('Owner代码Reviewer请求未绑定准确冻结快照')
    } else {
      assertOwnerReviewerTextDelivery(execution.ownerCommandId)
    }
  }
  if (runtime) assertOwnerCommandPrice(runtime)
  const channel = runtime ? getChannelById(runtime.channelId) : null
  const workspace = grant ? getAgentWorkspace(grant.workspace_id) : undefined
  if (!policy?.ownerExecutionRevalidation || policy.ownerExecutionRevalidation.id !== record.id
    || policy.ownerExecutionRevalidation.integrityHash !== record.integrityHash
    || !execution || execution.status !== 'running' || execution.sessionId !== input.sessionId
    || !command || command.project_id !== context.subject.projectId || command.execution_id !== execution.id || command.state !== 'running'
    || !grant || grant.state !== 'active' || grant.expires_at <= Date.now()
    || grant.runtime !== input.runtime || record.source.runtime !== input.runtime
    || !runtime || input.modelId !== runtime.modelId || runtime.runtime !== input.runtime || input.permissionMode !== 'safe'
    || !employee?.enabled || employee.runtime !== runtime.runtime || employee.channelId !== runtime.channelId || employee.modelId !== runtime.modelId
    || !channel?.enabled || !workspace || workspace.id !== record.source.workspaceId || grant.workspace_id !== record.source.workspaceId) {
    throw new Error('Owner逐请求核验失败：执行、授权、员工或冻结来源不匹配')
  }
  const expectedCwd = getAgentWorkspaceCwd(workspace, input.sessionId)
  const expectedBaseUrl = runtime.runtime === 'pi' ? resolvePiBaseUrl(channel.provider, channel.baseUrl) : resolveAgentRuntimeBaseUrl(channel.provider, 'ai-sdk', channel.baseUrl)
  let expected: URL, actual: URL, base: URL
  try { expected = new URL(expectedBaseUrl); actual = new URL(input.requestUrl); base = new URL(input.baseUrl) } catch { throw new Error('Owner请求URL无效') }
  const basePath = expected.pathname.replace(/\/+$/, '')
  if (resolve(input.cwd) !== resolve(expectedCwd) || base.origin !== expected.origin || base.pathname.replace(/\/+$/, '') !== basePath
    || actual.origin !== expected.origin || !(actual.pathname === basePath || actual.pathname.startsWith(`${basePath}/`))) {
    throw new Error('Owner逐请求Runtime、工作区或渠道出口不匹配')
  }
  if (record.source.budget.expiresAt <= Date.now()) throw new Error('Owner预算期限已过期，新请求拒绝（对账不受影响）')
  if (context.gate.providerAdmittedAt === null) store.getProjectDb().prepare('UPDATE project_owner_execution_gate_sessions SET provider_admitted_at = ? WHERE session_id = ?').run(Date.now(), input.sessionId)
}
