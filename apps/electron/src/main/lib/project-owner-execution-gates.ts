/** Owner业务执行侧休眠门禁：资料fence/逐请求核验/purpose。本片不发行、不派工，gate行无生产创建路径。 */
import { createHash, randomUUID } from 'node:crypto'
import type { OwnerExecutionRevalidationRecord } from '@gravitas/shared'
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

/** 仅这两个知识工具可经fence放行；其余工具与MCP资源读取恒拒。 */
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
export type OwnerSessionGateContext =
  | { kind: 'unrestricted' }
  | { kind: 'restricted'; reason: string }
  | { kind: 'owner_business'; subject: { projectId: string; taskId?: string }; record: OwnerExecutionRevalidationRecord; gate: OwnerGateSessionRow | null }

type OwnerBusinessChain = { kind: 'owner_business'; subject: { projectId: string; taskId?: string }; record: OwnerExecutionRevalidationRecord; executionId: string; gate: OwnerGateSessionRow | null }
function resolveOwnerBusinessChain(sessionId: string): { kind: 'restricted'; reason: string } | OwnerBusinessChain {
  try {
    const execution = (store.getProjectDb().prepare("SELECT id, entity_id FROM agent_executions WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC").all(sessionId) as Array<{ id: string; entity_id: string }>)
      .find(row => store.hasOwnerBusinessExecutionEvidence(row.id))
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
  if (!hasOwnerBusinessSessionEvidence(sessionId)) return { kind: 'unrestricted' }
  const chain = resolveOwnerBusinessChain(sessionId)
  if (chain.kind !== 'owner_business') return chain
  if (!chain.gate || chain.gate.executionId !== chain.executionId || chain.gate.revalidationId !== chain.record.id || chain.gate.revalidationIntegrityHash !== chain.record.integrityHash) return { kind: 'restricted', reason: 'Owner会话门禁未准入或已过期，工具执行拒绝' }
  return chain
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
  if (!hasOwnerBusinessSessionEvidence(sessionId)) throw new Error('会话无Owner业务用途，不需要门禁准入')
  const context = resolveOwnerBusinessChain(sessionId)
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
/** purpose感知工具谓词：无Owner证据=现状行为；有证据时仅知识工具可经fence，其余/MCP资源恒拒。 */
export function assertToolAllowedForSessionPurpose(sessionId: string, toolName: string, args?: Record<string, unknown>): void {
  const context = resolveOwnerExecutionGateSession(sessionId)
  if (context.kind === 'unrestricted') return
  if (!OWNER_TOOL_ALLOWED.has(toolName)) assertNoOwnerBusinessSession(sessionId)
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
export function assertOwnerExecutionRequestGate(input: { commandPurpose: string; grantExpiresAt: number | null; sessionId: string; runtime: string; modelId: string; permissionMode: string; cwd: string; baseUrl: string }): void {
  if (input.commandPurpose === 'controlled_task') return
  if (input.commandPurpose !== 'owner_business_execution') throw new Error(`未知Pilot命令用途：${input.commandPurpose}`)
  const context = resolveOwnerExecutionGateSession(input.sessionId)
  if (context.kind !== 'owner_business') throw new Error('Owner用途请求缺少有效门禁会话')
  const policy = pilotPolicy().getPilotPolicy(context.subject.projectId)
  const record = context.record
  if (policy?.ownerExecutionRevalidation?.id !== record.id || policy.ownerExecutionRevalidation.integrityHash !== record.integrityHash) throw new Error('Owner逐请求核验失败：策略v2引用不一致')
  if (record.source.budget.expiresAt <= Date.now()) throw new Error('Owner预算期限已过期，新请求拒绝（对账不受影响）')
  if (context.gate!.providerAdmittedAt === null) store.getProjectDb().prepare('UPDATE project_owner_execution_gate_sessions SET provider_admitted_at = ? WHERE session_id = ?').run(Date.now(), input.sessionId)
  const source = record.source
  // 参数一致性（runtime/permission/cwd/baseUrl）由调用方在boundary比对集内完成；此处只核模型与期限。
  if (input.modelId !== source.modelId) throw new Error('Owner请求模型与v2冻结值不一致')
}
