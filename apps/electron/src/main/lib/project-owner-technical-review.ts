import { createHash } from 'node:crypto'
import { getOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { getOwnerTaskMaterializationRecord } from './project-owner-task-materialization'
import * as store from './project-sqlite-store'

export type OwnerTechnicalReviewVerdict = 'approved' | 'changes_requested' | 'blocked'
export type OwnerTechnicalReviewCriterionStatus = 'met' | 'not_met' | 'not_verified'

export interface OwnerTechnicalReviewCriterion {
  criterion: string
  status: OwnerTechnicalReviewCriterionStatus
  evidence: string
}

export interface OwnerTechnicalReviewFinding {
  severity: 'low' | 'medium' | 'high'
  description: string
  requestedChange: string
}

export interface OwnerTechnicalReviewResponse {
  schemaVersion: 1
  verdict: OwnerTechnicalReviewVerdict
  summary: string
  criteria: OwnerTechnicalReviewCriterion[]
  findings: OwnerTechnicalReviewFinding[]
  blockerReason: string | null
}

export interface OwnerTechnicalReviewEvidence extends OwnerTechnicalReviewResponse {
  projectId: string
  grantId: string
  taskId: string
  stepLinkId: string
  reworkOrdinal: number
  executorCommandId: string
  executorExecutionId: string
  reviewerCommandId: string
  reviewerExecutionId: string
  sourceHash: string
  responseSha256: string
  createdAt: number
}

interface ReviewCommandRow {
  id: string
  project_id: string
  grant_id: string
  source_task_id: string
  source_step_link_id: string
  source_hash: string
  rework_ordinal: number
  role: string
  state: string
  actual_cost_micros: number | null
  usage_evidence: string | null
  usage_record_key: string | null
  execution_id: string | null
  execution_status: string | null
  execution_command_id: string | null
  grant_task_id: string | null
  revalidation_id: string
  revalidation_revision: number
}

const MAX_RESPONSE_LENGTH = 100_000
const MAX_CRITERIA = 64
const MAX_FINDINGS = 32

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

/**
 * 严格解析 Reviewer 的 JSON 回执。自然语言猜测、Markdown 包裹、漏项和额外字段均不作为调度依据。
 * 此回执只表达技术建议，不代表业务验收、费用结算或外部验证事实。
 */
export function parseOwnerTechnicalReviewResponse(raw: string, frozenCriteria: string[]): OwnerTechnicalReviewResponse {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RESPONSE_LENGTH) throw new Error('技术评审回执为空或超出大小限制')
  if (!Array.isArray(frozenCriteria) || frozenCriteria.length === 0 || frozenCriteria.length > MAX_CRITERIA
    || frozenCriteria.some(item => !boundedText(item, 1000)) || new Set(frozenCriteria).size !== frozenCriteria.length) {
    throw new Error('冻结验收标准无效，拒绝解析技术评审')
  }

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('技术评审回执不是严格 JSON') }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ['schemaVersion', 'verdict', 'summary', 'criteria', 'findings', 'blockerReason'])) {
    throw new Error('技术评审回执字段不匹配')
  }
  if (parsed.schemaVersion !== 1 || !['approved', 'changes_requested', 'blocked'].includes(String(parsed.verdict))
    || !boundedText(parsed.summary, 2000) || !Array.isArray(parsed.criteria) || !Array.isArray(parsed.findings)
    || parsed.criteria.length !== frozenCriteria.length || parsed.findings.length > MAX_FINDINGS
    || !(parsed.blockerReason === null || boundedText(parsed.blockerReason, 2000))) {
    throw new Error('技术评审回执结构无效')
  }

  const criteriaValues = parsed.criteria as unknown[]
  const findingValues = parsed.findings as unknown[]
  const criteria: OwnerTechnicalReviewCriterion[] = criteriaValues.map((value, index) => {
    if (!isRecord(value) || !hasExactKeys(value, ['criterion', 'status', 'evidence'])
      || value.criterion !== frozenCriteria[index]
      || !['met', 'not_met', 'not_verified'].includes(String(value.status))
      || !boundedText(value.evidence, 2000)) {
      throw new Error(`技术评审标准第 ${index + 1} 项无效或顺序不匹配`)
    }
    return { criterion: value.criterion as string, status: value.status as OwnerTechnicalReviewCriterionStatus, evidence: value.evidence }
  })

  const findings: OwnerTechnicalReviewFinding[] = findingValues.map((value, index) => {
    if (!isRecord(value) || !hasExactKeys(value, ['severity', 'description', 'requestedChange'])
      || !['low', 'medium', 'high'].includes(String(value.severity))
      || !boundedText(value.description, 2000) || !boundedText(value.requestedChange, 2000)) {
      throw new Error(`技术评审 finding 第 ${index + 1} 项无效`)
    }
    return {
      severity: value.severity as OwnerTechnicalReviewFinding['severity'],
      description: value.description,
      requestedChange: value.requestedChange,
    }
  })

  const verdict = parsed.verdict as OwnerTechnicalReviewVerdict
  if (verdict === 'approved' && (criteria.some(item => item.status !== 'met') || findings.length > 0 || parsed.blockerReason !== null)) {
    throw new Error('技术评审未逐项满足冻结标准，不能给出 approved')
  }
  if (verdict === 'changes_requested' && (!criteria.some(item => item.status === 'not_met') || findings.length === 0 || parsed.blockerReason !== null)) {
    throw new Error('changes_requested 必须绑定未满足标准及具体返工 finding')
  }
  if (verdict === 'blocked' && (!boundedText(parsed.blockerReason, 2000) || findings.length > 0)) {
    throw new Error('blocked 必须提供明确 blockerReason，且不能伪装成返工 finding')
  }

  return { schemaVersion: 1, verdict, summary: parsed.summary, criteria, findings, blockerReason: parsed.blockerReason as string | null }
}

function isKnownSettledCommand(row: ReviewCommandRow): boolean {
  if (row.state !== 'settled' || row.actual_cost_micros === null || !row.usage_evidence || !row.usage_record_key
    || row.execution_status !== 'completed' || !row.execution_id || row.execution_command_id !== row.id) return false
  try {
    const evidence: unknown = JSON.parse(row.usage_evidence)
    return isRecord(evidence) && evidence.source !== 'unknown'
  } catch {
    return false
  }
}

function readReviewCommand(reviewerCommandId: string): ReviewCommandRow | null {
  return store.getProjectDb().prepare(`SELECT c.id, c.project_id, c.grant_id, c.source_task_id, c.source_step_link_id,
      c.source_hash, c.rework_ordinal, c.role, c.state, c.actual_cost_micros, c.usage_evidence, c.usage_record_key,
      c.execution_id, e.status AS execution_status, e.owner_command_id AS execution_command_id,
      g.task_id AS grant_task_id, g.revalidation_id, g.revalidation_revision
    FROM project_owner_execution_commands c
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    LEFT JOIN agent_executions e ON e.id=c.execution_id
    WHERE c.id=?`).get(reviewerCommandId) as ReviewCommandRow | undefined ?? null
}

function readKnownExecutorCommand(row: ReviewCommandRow): ReviewCommandRow {
  const rows = store.getProjectDb().prepare(`SELECT c.id, c.project_id, c.grant_id, c.source_task_id, c.source_step_link_id,
      c.source_hash, c.rework_ordinal, c.role, c.state, c.actual_cost_micros, c.usage_evidence, c.usage_record_key,
      c.execution_id, e.status AS execution_status, e.owner_command_id AS execution_command_id,
      g.task_id AS grant_task_id, g.revalidation_id, g.revalidation_revision
    FROM project_owner_execution_commands c
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    LEFT JOIN agent_executions e ON e.id=c.execution_id
    WHERE c.project_id=? AND c.grant_id=? AND c.source_task_id=? AND c.source_step_link_id=?
      AND c.role='executor' AND c.rework_ordinal=?`).all(
    row.project_id, row.grant_id, row.source_task_id, row.source_step_link_id, row.rework_ordinal,
  ) as ReviewCommandRow[]
  if (rows.length !== 1) throw new Error('对应返工轮次必须恰有一条 Executor 命令')
  const executor = rows[0]!
  if (!isKnownSettledCommand(executor) || executor.source_hash !== row.source_hash
    || executor.revalidation_id !== row.revalidation_id || executor.revalidation_revision !== row.revalidation_revision) {
    throw new Error('对应 Executor 结果、费用或冻结来源无法核验')
  }
  return executor
}

function listFrozenCriteria(row: ReviewCommandRow): string[] {
  const view = getOwnerExecutionRevalidation({ projectId: row.project_id, ...(row.grant_task_id ? { taskId: row.grant_task_id } : {}) })
  const record = view.revalidation
  if (view.status !== 'current' || !record || record.id !== row.revalidation_id || record.revision !== row.revalidation_revision) {
    throw new Error('Owner 重验证来源已漂移，技术评审不能作为调度依据')
  }
  const task = record.source.tasks.find(item => item.taskId === row.source_task_id && item.linkId === row.source_step_link_id)
  if (!task) throw new Error('Owner 技术评审任务不在当前冻结来源中')
  const batch = getOwnerTaskMaterializationRecord(row.project_id, record.source.materialization.id)
  const link = batch.links.find(item => item.id === row.source_step_link_id && item.taskId === row.source_task_id)
  if (!link || link.integrityHash !== task.linkIntegrityHash) throw new Error('Owner 技术评审步骤链接无法核验')
  return link.projection.acceptanceCriteria
}

function toEvidence(row: ReviewCommandRow, executor: ReviewCommandRow, response: OwnerTechnicalReviewResponse, rawResponse: string, createdAt: number): OwnerTechnicalReviewEvidence {
  const responseSha256 = createHash('sha256').update(rawResponse, 'utf8').digest('hex')
  return {
    ...response,
    projectId: row.project_id,
    grantId: row.grant_id,
    taskId: row.source_task_id,
    stepLinkId: row.source_step_link_id,
    reworkOrdinal: row.rework_ordinal,
    executorCommandId: executor.id,
    executorExecutionId: executor.execution_id!,
    reviewerCommandId: row.id,
    reviewerExecutionId: row.execution_id!,
    sourceHash: row.source_hash,
    responseSha256,
    createdAt,
  }
}

/** 仅在Owner Reviewer命令已知结算且来源current时保存；调用方不能提交角色、费用或业务状态。 */
export function recordOwnerTechnicalReviewEvidence(reviewerCommandId: string, reviewerExecutionId: string, rawResponse: string, createdAt = Date.now()): OwnerTechnicalReviewEvidence {
  if (!reviewerCommandId.trim() || !reviewerExecutionId.trim() || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('Owner 技术评审回执身份或时间无效')
  }
  const row = readReviewCommand(reviewerCommandId)
  if (!row || row.role !== 'reviewer' || row.execution_id !== reviewerExecutionId || !isKnownSettledCommand(row)) {
    throw new Error('Reviewer command/execution 未完成可信结算，拒绝保存技术评审')
  }
  const openStop = store.getProjectDb().prepare('SELECT 1 FROM project_owner_execution_stop_escalations WHERE command_id=? AND resolved_at IS NULL').get(row.id)
  if (openStop) throw new Error('Owner Reviewer 存在未解决的停止升级，拒绝技术评审续派')
  const executor = readKnownExecutorCommand(row)
  if (store.getProjectDb().prepare('SELECT 1 FROM project_owner_execution_stop_escalations WHERE command_id=? AND resolved_at IS NULL').get(executor.id)) {
    throw new Error('Owner Executor 存在未解决的停止升级，拒绝技术评审续派')
  }
  const response = parseOwnerTechnicalReviewResponse(rawResponse, listFrozenCriteria(row))
  const evidence = toEvidence(row, executor, response, rawResponse, createdAt)
  const database = store.getProjectDb()
  const existing = database.prepare('SELECT response_sha256 FROM project_owner_technical_reviews WHERE reviewer_command_id=?').get(row.id) as { response_sha256: string } | undefined
  if (existing) {
    if (existing.response_sha256 !== evidence.responseSha256) throw new Error('Owner 技术评审 command 已记录不同回执，拒绝覆盖')
    return evidence
  }
  database.prepare(`INSERT INTO project_owner_technical_reviews
    (reviewer_command_id, project_id, grant_id, task_id, step_link_id, rework_ordinal,
     executor_command_id, executor_execution_id, reviewer_execution_id, source_hash, verdict,
     response_json, response_sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.project_id, row.grant_id, row.source_task_id, row.source_step_link_id, row.rework_ordinal,
      executor.id, executor.execution_id, row.execution_id, row.source_hash, response.verdict,
      rawResponse, evidence.responseSha256, createdAt)
  return evidence
}

export function listOwnerTechnicalReviewEvidence(projectId: string, taskId?: string): OwnerTechnicalReviewEvidence[] {
  if (!projectId.trim() || (taskId !== undefined && !taskId.trim())) throw new Error('Owner 技术评审查询主体无效')
  const rows = store.getProjectDb().prepare(`SELECT reviewer_command_id, project_id, grant_id, task_id, step_link_id, rework_ordinal,
      executor_command_id, executor_execution_id, reviewer_execution_id, source_hash, verdict,
      response_json, response_sha256, created_at
    FROM project_owner_technical_reviews WHERE project_id=? AND (? IS NULL OR task_id=?) ORDER BY created_at, reviewer_command_id`)
    .all(projectId, taskId ?? null, taskId ?? null) as Array<{
      reviewer_command_id: string; project_id: string; grant_id: string; task_id: string; step_link_id: string; rework_ordinal: number
      executor_command_id: string; executor_execution_id: string; reviewer_execution_id: string; source_hash: string
      verdict: OwnerTechnicalReviewVerdict; response_json: string; response_sha256: string; created_at: number
    }>
  return rows.map(row => {
    if (!/^[a-f0-9]{64}$/.test(row.response_sha256) || createHash('sha256').update(row.response_json, 'utf8').digest('hex') !== row.response_sha256) {
      throw new Error('Owner 技术评审记录完整性校验失败')
    }
    let raw: unknown
    try { raw = JSON.parse(row.response_json) } catch { throw new Error('Owner 技术评审记录不是有效 JSON') }
    if (!isRecord(raw) || raw.verdict !== row.verdict) throw new Error('Owner 技术评审记录与索引状态不一致')
    const criteriaValues = Array.isArray(raw.criteria) ? raw.criteria as unknown[] : []
    const frozenCriteria = criteriaValues.map(item => isRecord(item) && typeof item.criterion === 'string' ? item.criterion : '')
    const response = parseOwnerTechnicalReviewResponse(row.response_json, frozenCriteria)
    return {
      ...response,
      projectId: row.project_id,
      grantId: row.grant_id,
      taskId: row.task_id,
      stepLinkId: row.step_link_id,
      reworkOrdinal: row.rework_ordinal,
      executorCommandId: row.executor_command_id,
      executorExecutionId: row.executor_execution_id,
      reviewerCommandId: row.reviewer_command_id,
      reviewerExecutionId: row.reviewer_execution_id,
      sourceHash: row.source_hash,
      responseSha256: row.response_sha256,
      createdAt: row.created_at,
    }
  })
}
