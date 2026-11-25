import { findOwnerItemizedBudgetIssue, findOwnerDeliveredBudgetIssue, ownerGoalRequiresItemizedBudget } from './project-owner-budget-deliverable'
import { findOwnerDeliveredRosterConflict, findOwnerRosterScenarioConflict } from './project-owner-roster-scenario'
import { listProjectOwnerGoalHistory } from './project-owner-goal-service'
import { assertOwnerReviewerTextDelivery } from './project-owner-text-delivery'
import { isOwnerDevelopmentValidationArtifact, ownerDevelopmentArtifactFromPrompt } from './project-owner-development-artifact'
import { containsOwnerValidationEvidenceQuote, isOwnerValidationEvidenceExpired, resolveOwnerValidationMetadataQuote } from './development-validation-acceptance'
import type { OwnerDevelopmentValidationArtifact } from './project-owner-development-artifact'
import type { OwnerDevelopmentDeliveryArtifact } from '@gravitas/shared'
import { ownerDevelopmentValidationId } from './development-validation-attempt'
import { ownerTaskDeliveryKind, readOwnerCommandFrozenSource } from './project-owner-employee-runtime'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { createHash } from 'node:crypto'
import { getOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { getOwnerTaskMaterializationRecord } from './project-owner-task-materialization'
import * as store from './project-sqlite-store'
import { ownerSnapshotHasFilePathQuote, readOwnerMetadataQuote, resolveOwnerIndentationQuote, resolveOwnerTypographyQuote } from './project-owner-quote'
import { OWNER_REVIEW_CRITERION_MAX_LENGTH } from './project-owner-criteria-trace'

export type OwnerTechnicalReviewVerdict = 'approved' | 'changes_requested' | 'blocked'
export type OwnerTechnicalReviewCriterionStatus = 'met' | 'not_met' | 'not_verified'

export interface OwnerTechnicalReviewCriterion {
  criterion: string
  status: OwnerTechnicalReviewCriterionStatus
  evidence: string
  quote?: string | null
}

export interface OwnerTechnicalReviewFinding {
  severity: 'low' | 'medium' | 'high'
  description: string
  requestedChange: string
}

export interface OwnerTechnicalReviewResponse {
  schemaVersion: 1 | 2 | 3
  artifactHash?: string
  verdict: OwnerTechnicalReviewVerdict
  summary: string
  criteria: OwnerTechnicalReviewCriterion[]
  findings: OwnerTechnicalReviewFinding[]
  blockerReason: string | null
}

export interface OwnerTechnicalReviewEvidence extends OwnerTechnicalReviewResponse {
  artifactVerified?: boolean
  developmentArtifact?: OwnerDevelopmentDeliveryArtifact
  validationEvidence?: OwnerDevelopmentValidationArtifact[]
  validationEvidenceVerified?: boolean
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

export function assertOwnerDevelopmentValidationForVerdict(
  verdict: OwnerTechnicalReviewVerdict,
  evidence: OwnerDevelopmentValidationArtifact[],
): void {
  if (verdict === 'approved' && evidence.some(item => item.attemptState !== 'completed' || item.freshness !== 'fresh'
    || isOwnerValidationEvidenceExpired(item)
    || item.status !== 'passed' || item.exitCode !== 0 || item.timedOut !== false || item.outputTruncated !== false
    || !item.rawOutputSha256 || !Number.isSafeInteger(item.rawOutputByteLength))) {
    throw new Error('Owner代码验证存在失败、截断、过期或未知证据，Reviewer不能批准')
  }
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
export const OWNER_TEXT_HANDOFF_HEADER = 'Owner文本上游成果交接 v2。'
export const OWNER_REVIEW_BINDING_HEADER = 'Owner技术评审成果绑定 v1。'

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

function artifactContainsQuote(content: string | undefined, quote: string): boolean {
  if (!content) return false
  try {
    const parsed: unknown = JSON.parse(content)
    if (isRecord(parsed) && Array.isArray(parsed.files)) {
      const metadata = readOwnerMetadataQuote(quote)
      if (metadata) return metadata.kind === 'path' && metadata.exact === quote && ownerSnapshotHasFilePathQuote(parsed.files, quote)
      return parsed.files.some(file => isRecord(file)
        && [file.oldContent, file.newContent].some(body => typeof body === 'string' && body.includes(quote)))
    }
  } catch {
    // 文本成果沿用原文包含校验。
  }
  return content.includes(quote)
}

/** 多字段引文须逐字出现于唯一一项冻结文件元数据。 */
function resolveOwnerFileMetadataExcerpt(content: string, quote: string): string | undefined {
  const excerpt = quote.startsWith('newSha256":') ? '"' + quote : quote
  if (!/^"file":\{"path":"(?:[^"\\\r\n]|\\.)+"/.test(excerpt)
    && !/^"newSha256":"[a-f0-9]{64}"/.test(excerpt)) return undefined
  let snapshot: unknown
  try { snapshot = JSON.parse(content) } catch { return undefined }
  if (!isRecord(snapshot) || !Array.isArray(snapshot.files)) return undefined
  const files = snapshot.files.flatMap((entry: unknown) => {
    if (!isRecord(entry) || !isRecord(entry.file) || typeof entry.file.path !== 'string' || entry.file.changeType === 'delete') return []
    return JSON.stringify({ file: entry.file }).includes(excerpt) ? [entry.file.path] : []
  })
  if (files.length !== 1) return undefined
  const pathQuote = `"path":${JSON.stringify(files[0])}`
  return artifactContainsQuote(content, pathQuote) ? pathQuote : undefined
}

/** 解除一次 JSON 转义后只接受唯一仍存在的源码文件。 */
function resolveOwnerEscapedSourceQuote(content: string, quote: string): string | undefined {
  const decoded = quote.replace(/\\"/g, '"')
  if (decoded === quote) return undefined
  let snapshot: unknown
  try { snapshot = JSON.parse(content) } catch { return undefined }
  if (!isRecord(snapshot) || !Array.isArray(snapshot.files)) return undefined
  const matches = snapshot.files.filter((entry: unknown) => isRecord(entry) && isRecord(entry.file)
    && entry.file.changeType !== 'delete' && typeof entry.newContent === 'string' && entry.newContent.includes(decoded))
  return matches.length === 1 ? decoded : undefined
}

/** 只去掉包住整个回执的 Markdown 围栏，保留原文及摘要供审计。 */
export function unwrapReviewReceipt(raw: string): string {
  return /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(raw)?.[1] ?? raw
}

/** 还原可核对的逐字引用，或将代码评审中未验证项的无效引用置空。原回执由记录服务保留。 */
export function normalizeOwnerTechnicalReviewQuotes(receipt: string, artifactContent: string | undefined, validationEvidence?: OwnerDevelopmentValidationArtifact[]): string {
  if (artifactContent === undefined || receipt.length > MAX_RESPONSE_LENGTH) return receipt
  let value: unknown
  try { value = JSON.parse(receipt) } catch { return receipt }
  if (!isRecord(value) || !Array.isArray(value.criteria)) return receipt
  let changed = false
  const criteria = value.criteria.map((item: unknown) => {
    if (!isRecord(item)) return item
    if (!Object.hasOwn(item, 'quote') && boundedText(item.evidence, 1000) && artifactContainsQuote(artifactContent, item.evidence)) {
      changed = true
      return { ...item, quote: item.evidence }
    }
    if (typeof item.quote !== 'string' || !item.quote || artifactContainsQuote(artifactContent, item.quote)
      || value.schemaVersion === 3 && item.status === 'met' && containsOwnerValidationEvidenceQuote(validationEvidence, item.quote)) return item
    const exact = value.schemaVersion === 3
      ? resolveOwnerIndentationQuote(item.quote, quote => artifactContainsQuote(artifactContent, quote)) : null
    const metadata = value.schemaVersion === 3 ? readOwnerMetadataQuote(item.quote) : null
    const verifiedMetadata = metadata && (metadata.kind === 'path' ? artifactContainsQuote(artifactContent, metadata.exact)
      : item.status === 'met' && containsOwnerValidationEvidenceQuote(validationEvidence, metadata.exact)) ? metadata.exact : null
    // 评审可直接引用路径。仅当它精确等于冻结快照里仍存在的文件时，转换成路径字段引用。
    const pathQuote = value.schemaVersion === 3 && !metadata ? `"path":${JSON.stringify(item.quote)}` : null
    const verifiedPath = pathQuote && artifactContainsQuote(artifactContent, pathQuote) ? pathQuote : null
    const verifiedDecoded = value.schemaVersion === 3 ? resolveOwnerEscapedSourceQuote(artifactContent, item.quote) : undefined
    const extraReference = value.schemaVersion === 3 && item.status === 'met'
      ? resolveOwnerFileMetadataExcerpt(artifactContent, item.quote) ?? resolveOwnerValidationMetadataQuote(validationEvidence, item.quote)
      : undefined
    const typography = resolveOwnerTypographyQuote(artifactContent, item.quote)
    const quote = exact ?? verifiedMetadata ?? verifiedPath ?? verifiedDecoded ?? extraReference
      ?? (typography && artifactContainsQuote(artifactContent, typography) ? typography : null)
    if (quote === null && !(value.schemaVersion === 3 && value.verdict === 'blocked'
      && item.status === 'not_verified' && boundedText(item.quote, 1000))) return item
    changed = true
    return { ...item, quote }
  })
  return changed ? JSON.stringify({ ...value, criteria }) : receipt
}

/** 仅补齐末项精确文件路径引文的外层引号，原有 JSON 内容和证据均不改变。 */
function closeOwnerReviewPathQuote(receipt: string, artifactContent: string): string {
  const suffix = /("quote"\s*:\s*)("(?:[^"\\]|\\.)*\\")(\s*}\s*\]\s*,\s*"findings"\s*:\s*\[\s*\]\s*,\s*"blockerReason"\s*:\s*null\s*}\s*)$/.exec(receipt)
  if (!suffix) return receipt
  try {
    const quote: unknown = JSON.parse(suffix[2]! + '"')
    if (typeof quote !== 'string' || !quote.startsWith('"path":') || !artifactContainsQuote(artifactContent, quote)) return receipt
    const candidate = receipt.slice(0, suffix.index) + suffix[1] + suffix[2] + '"' + suffix[3]
    const parsed: unknown = JSON.parse(candidate)
    if (!isRecord(parsed) || parsed.schemaVersion !== 3 || parsed.verdict !== 'approved' || !Array.isArray(parsed.criteria)) return receipt
    const last: unknown = parsed.criteria.at(-1)
    if (!isRecord(last) || last.quote !== quote) return receipt
    return candidate
  } catch { return receipt }
}

/** 历史回执和实时评审共同使用相同的长度限制及引用核对规则。 */
export function normalizeOwnerTechnicalReviewReceipt(raw: string, artifactContent: string | undefined, validationEvidence?: OwnerDevelopmentValidationArtifact[], binding?: { prompt: string; hash: string }): string {
  if (artifactContent === undefined || raw.length > MAX_RESPONSE_LENGTH) return raw
  let receipt = unwrapReviewReceipt(raw)
  // 标记位只接受主进程生成的固定开头。目标、资料或成果正文中的同名字符串没有绑定语义。
  if (binding && /^[a-f0-9]{64}$/.test(binding.hash) && (
    binding.prompt.startsWith(OWNER_REVIEW_BINDING_HEADER + '\n\n') ||
    binding.prompt.startsWith(OWNER_TEXT_HANDOFF_HEADER + '\n\n' + OWNER_REVIEW_BINDING_HEADER + '\n\n')
  )) {
    let response: unknown
    try { response = JSON.parse(receipt) } catch {
      if (validationEvidence?.length) {
        receipt = closeOwnerReviewPathQuote(receipt, artifactContent)
        try { response = JSON.parse(receipt) } catch { /* 由严格解析器报错。 */ }
      }
    }
    if (isRecord(response) && (response.schemaVersion === 2 || response.schemaVersion === 3) && !Object.hasOwn(response, 'artifactHash')) {
      receipt = JSON.stringify({ ...response, artifactHash: binding.hash })
    }
  }
  return normalizeOwnerTechnicalReviewQuotes(receipt, artifactContent, validationEvidence)
}

/**
 * 严格解析 Reviewer 的 JSON 回执。自然语言猜测、Markdown 包裹、漏项和额外字段均不作为调度依据。
 * 此回执只表达技术建议，不代表业务验收、费用结算或外部验证事实。
 */
export function parseOwnerTechnicalReviewResponse(raw: string, frozenCriteria: string[], expectedArtifactHash?: string, artifactContent?: string, artifactKind: 'text' | 'development' = 'text', validationEvidence?: OwnerDevelopmentValidationArtifact[]): OwnerTechnicalReviewResponse {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RESPONSE_LENGTH) throw new Error('技术评审回执为空或超出大小限制')
  if (!Array.isArray(frozenCriteria) || frozenCriteria.length === 0 || frozenCriteria.length > MAX_CRITERIA
    || frozenCriteria.some(item => !boundedText(item, OWNER_REVIEW_CRITERION_MAX_LENGTH)) || new Set(frozenCriteria).size !== frozenCriteria.length) {
    throw new Error('冻结验收标准无效，拒绝解析技术评审')
  }

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('技术评审回执不是严格 JSON') }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ['schemaVersion', 'verdict', 'summary', 'criteria', 'findings', 'blockerReason', ...(expectedArtifactHash ? ['artifactHash'] : [])])) {
    throw new Error('技术评审回执字段不匹配')
  }
  const expectedSchemaVersion = expectedArtifactHash ? artifactKind === 'development' ? 3 : 2 : 1
  if (expectedArtifactHash && (!/^[a-f0-9]{64}$/.test(expectedArtifactHash) || parsed.artifactHash !== expectedArtifactHash)) throw new Error('技术评审未绑定准确成果版本')
  if (parsed.schemaVersion !== expectedSchemaVersion || !['approved', 'changes_requested', 'blocked'].includes(String(parsed.verdict))
    || !boundedText(parsed.summary, 2000) || !Array.isArray(parsed.criteria) || !Array.isArray(parsed.findings)
    || parsed.criteria.length !== frozenCriteria.length || parsed.findings.length > MAX_FINDINGS
    || !(parsed.blockerReason === null || boundedText(parsed.blockerReason, 2000))) {
    throw new Error('技术评审回执结构无效')
  }

  const criteriaValues = parsed.criteria as unknown[]
  const findingValues = parsed.findings as unknown[]
  const criteria: OwnerTechnicalReviewCriterion[] = criteriaValues.map((value, index) => {
    if (!isRecord(value) || !hasExactKeys(value, ['criterion', 'status', 'evidence', ...(expectedArtifactHash ? ['quote'] : [])])
      || value.criterion !== frozenCriteria[index]
      || !['met', 'not_met', 'not_verified'].includes(String(value.status))
      || !boundedText(value.evidence, 2000)) {
      throw new Error(`技术评审标准第 ${index + 1} 项无效或顺序不匹配`)
    }
    if (expectedArtifactHash && (value.quote !== null && !boundedText(value.quote, 1000) || value.status === 'met' && !boundedText(value.quote, 1000) || typeof value.quote === 'string' && artifactContent !== undefined && !artifactContainsQuote(artifactContent, value.quote) && !(artifactKind === 'development' && value.status === 'met' && containsOwnerValidationEvidenceQuote(validationEvidence, value.quote)))) throw new Error('技术评审原文依据与完整成果不匹配')
    return { criterion: value.criterion as string, status: value.status as OwnerTechnicalReviewCriterionStatus, evidence: value.evidence, ...(expectedArtifactHash ? { quote: value.quote as string | null } : {}) }
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

  return { schemaVersion: expectedSchemaVersion, ...(expectedArtifactHash ? { artifactHash: expectedArtifactHash } : {}), verdict, summary: parsed.summary, criteria, findings, blockerReason: parsed.blockerReason as string | null }
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

function readFrozenCriteriaSource(row: ReviewCommandRow) {
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
  return { criteria: link.projection.acceptanceCriteria, goalRevision: batch.preview.preparation.source.goalRevision }
}

function toEvidence(row: ReviewCommandRow, executor: ReviewCommandRow, response: OwnerTechnicalReviewResponse, rawResponse: string, createdAt: number, validationEvidence?: OwnerDevelopmentValidationArtifact[]): OwnerTechnicalReviewEvidence {
  const responseSha256 = createHash('sha256').update(rawResponse, 'utf8').digest('hex')
  return {
    ...response,
    ...(validationEvidence ? { validationEvidence, validationEvidenceVerified: true } : {}),
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

/** 只核对明确写出保留人数、且逐个列全 A–D 座位的换桌表。 */
export function findOwnerTableRotationConflict(markdown: string): string | null {
  const content = markdown.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*(?:\r?$|(?![\s\S]))/gm, '')
  const rules = [...content.matchAll(/每桌(?:须|需|应)?保?留原组[ \t]*([0-4])[ \t]*人/g)]
  if (rules.length !== 1) return null
  const expected = Number(rules[0]![1])
  const lines = content.split(/\r?\n/)
  const headers = lines.flatMap((line, index) => /^\s*\|\s*原桌位\s*\|[^|]*(?:去向|目标桌)[^|]*\|\s*$/.test(line) ? [index] : [])
  if (headers.length !== 1 || !/^\s*\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*$/.test(lines[headers[0]! + 1] ?? '')) return null

  const tables = new Map<string, Map<string, string>>()
  for (const line of lines.slice(headers[0]! + 2)) {
    if (!line.trimStart().startsWith('|')) break
    const row = /^\s*\|\s*(\d+)\s*桌\s*([A-D](?:\s*\/\s*[A-D])*)\s*\|\s*(\d+)\s*桌\s*\|\s*$/.exec(line)
    if (!row) return null
    const [, origin, seats, destination] = row
    const assignments = tables.get(origin!) ?? new Map<string, string>()
    for (const seat of seats!.split(/\s*\/\s*/)) {
      if (assignments.has(seat)) return null
      assignments.set(seat, destination!)
    }
    tables.set(origin!, assignments)
  }
  if (tables.size < 2 || [...tables.values()].some(seats => seats.size !== 4 || [...seats.values()].some(table => !tables.has(table)))) return null
  const mismatches = [...tables].flatMap(([table, seats]) => {
    const stays = [...seats.values()].filter(destination => destination === table).length
    return stays === expected ? [] : [`${table} 桌实际保留 ${stays} 人`]
  })
  return mismatches.length ? `换桌表与正文冲突。正文要求每桌保留原组 ${expected} 人，表中${mismatches.join('、')}。请对齐规则和去向后重新评审。` : null
}

function readOwnerTableRotationConflict(text: string | undefined, development: boolean): string | null {
  if (!text) return null
  if (!development) return findOwnerTableRotationConflict(text)
  const snapshot = JSON.parse(text) as { files?: Array<{ file?: { path?: string }; newContent?: string | null }> }
  for (const file of snapshot.files ?? []) {
    if (!file.file?.path?.toLowerCase().endsWith('.md') || !file.newContent) continue
    const conflict = findOwnerTableRotationConflict(file.newContent)
    if (conflict) return conflict
  }
  return null
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
  const frozenSource = readOwnerCommandFrozenSource(row.id).source
  const development = ownerTaskDeliveryKind(frozenSource, row.source_task_id) === 'development'
  const reviewerExecution = store.getAgentExecution(reviewerExecutionId)
  const developmentArtifact = development && reviewerExecution?.prompt
    ? ownerDevelopmentArtifactFromPrompt(reviewerExecution.prompt) : null
  const textArtifact = development ? null : assertOwnerReviewerTextDelivery(row.id)
  if (development && (!developmentArtifact
    || developmentArtifact.executorCommandId !== executor.id || developmentArtifact.executorExecutionId !== executor.execution_id)) {
    throw new Error('Owner代码Reviewer没有收到准确Executor快照')
  }
  const artifactHash = developmentArtifact?.contentHash ?? textArtifact?.contentSha256
  const artifactContent = developmentArtifact?.content ?? textArtifact?.content
  let validationEvidence: OwnerDevelopmentValidationArtifact[] | undefined
  if (development) {
    const frozenTask = frozenSource.tasks.find(task => task.taskId === row.source_task_id && task.linkId === row.source_step_link_id)
    const { readOwnerDocumentReviewValidation } = require('./project-owner-document-review-retry') as typeof import('./project-owner-document-review-retry')
    const documentValidation = developmentArtifact
      ? readOwnerDocumentReviewValidation(row.id, executor.id, developmentArtifact.contentHash) : null
    const expectedCommands = documentValidation ? [documentValidation.command] : frozenTask?.developmentScope?.verificationCommands ?? []
    if (documentValidation && ownerExecutionHash(developmentArtifact?.validationEvidence?.[0]) !== ownerExecutionHash(documentValidation))
      throw new Error('Markdown复核收到的文件验证和本地回执不一致')
    validationEvidence = developmentArtifact?.validationEvidence
    if (!developmentArtifact || !validationEvidence || expectedCommands.length === 0
      || validationEvidence.length !== expectedCommands.length
      || validationEvidence.some((item, index) => item.command !== expectedCommands[index]
        || item.validationId !== (documentValidation?.validationId ?? ownerDevelopmentValidationId(executor.id, expectedCommands[index]!, developmentArtifact.contentHash)))) {
      throw new Error('Owner代码Reviewer缺少完整且绑定冻结命令的验证回执')
    }
  }
  let receiptJson = artifactHash ? normalizeOwnerTechnicalReviewReceipt(rawResponse, artifactContent, validationEvidence,
    reviewerExecution?.prompt ? { prompt: reviewerExecution.prompt, hash: artifactHash } : undefined) : rawResponse
  const { criteria, goalRevision } = readFrozenCriteriaSource(row)
  const parseReceipt = (receipt: string) => parseOwnerTechnicalReviewResponse(receipt, criteria, artifactHash, artifactContent, development ? 'development' : 'text', validationEvidence)
  let response = parseReceipt(receiptJson)
  if (response.verdict === 'approved' && artifactContent) {
    const budgetCriterion = criteria.findIndex(text => /(?:预算.*合计|合计.*预算|itemized budget)/i.test(text))
    const scenarioCriterion = criteria.findIndex(text => /候补|递补/.test(text) && /示例|例子|走查|人数/.test(text))
    const goal = listProjectOwnerGoalHistory(row.project_id, row.grant_task_id ?? undefined).find(item => item.revision === goalRevision)?.goal
    const budgetIssue = goal && budgetCriterion >= 0 && ownerGoalRequiresItemizedBudget(goal)
      ? development ? findOwnerDeliveredBudgetIssue(goal, [{ content: artifactContent, fileSnapshot: true }], false) : findOwnerItemizedBudgetIssue(goal, artifactContent)
      : null
    const scenarioIssue = goal && scenarioCriterion >= 0
      ? development ? findOwnerDeliveredRosterConflict(goal, [{ content: artifactContent, fileSnapshot: true }], false) : findOwnerRosterScenarioConflict(goal, artifactContent)
      : null
    const issue = budgetIssue ?? scenarioIssue
    if (issue) {
      const criterionIndex = budgetIssue ? budgetCriterion : scenarioCriterion
      receiptJson = JSON.stringify({ ...response, verdict: 'changes_requested', summary: issue,
        criteria: response.criteria.map((item, index) => index === criterionIndex ? {
          ...item, status: 'not_met', evidence: issue, ...(response.schemaVersion !== 1 ? { quote: null } : {}),
        } : item),
        findings: [{ severity: 'high', description: issue, requestedChange: budgetIssue
          ? '提供可复算的逐项预算和合计。若用户允许估算，标明各项估算依据；缺少无法合理估算的输入时请明确提出。'
          : '复算签到与候补示例，按确认发生的时点更新名单和可用席位，并让正文和核对表一致。' }],
      })
      response = parseReceipt(receiptJson)
    }
  }
  const conflict = response.verdict === 'approved' ? readOwnerTableRotationConflict(artifactContent, development) : null
  if (conflict) {
    receiptJson = JSON.stringify({ ...response, verdict: 'blocked', summary: '本地核对发现换桌规则与表格不一致。', blockerReason: conflict,
      criteria: response.criteria.map(item => ({ ...item, status: 'not_verified', evidence: conflict, ...(response.schemaVersion !== 1 ? { quote: null } : {}) })) })
    response = parseReceipt(receiptJson)
  }
  if (validationEvidence) assertOwnerDevelopmentValidationForVerdict(response.verdict, validationEvidence)
  const evidence = toEvidence(row, executor, response, receiptJson, createdAt, validationEvidence)
  const originalResponse = receiptJson === rawResponse ? null : rawResponse
  const originalResponseSha256 = originalResponse === null ? null : createHash('sha256').update(originalResponse, 'utf8').digest('hex')
  const database = store.getProjectDb()
  const validationEvidenceJson = JSON.stringify(validationEvidence ?? [])
  const validationEvidenceSha256 = createHash('sha256').update(validationEvidenceJson, 'utf8').digest('hex')
  const existing = database.prepare('SELECT response_sha256, validation_evidence_sha256, original_response_sha256 FROM project_owner_technical_reviews WHERE reviewer_command_id=?').get(row.id) as { response_sha256: string; validation_evidence_sha256: string; original_response_sha256: string | null } | undefined
  if (existing) {
    if (existing.response_sha256 !== evidence.responseSha256 || existing.validation_evidence_sha256 !== validationEvidenceSha256 || existing.original_response_sha256 !== originalResponseSha256) throw new Error('Owner 技术评审 command 已记录不同回执或验证来源，拒绝覆盖')
    return evidence
  }
  database.prepare(`INSERT INTO project_owner_technical_reviews
    (reviewer_command_id, project_id, grant_id, task_id, step_link_id, rework_ordinal,
     executor_command_id, executor_execution_id, reviewer_execution_id, source_hash, verdict,
     validation_evidence_json, validation_evidence_sha256, response_json, response_sha256, original_response_text, original_response_sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.project_id, row.grant_id, row.source_task_id, row.source_step_link_id, row.rework_ordinal,
      executor.id, executor.execution_id, row.execution_id, row.source_hash, response.verdict, validationEvidenceJson, validationEvidenceSha256,
      receiptJson, evidence.responseSha256, originalResponse, originalResponseSha256, createdAt)
  return evidence
}

export function listOwnerTechnicalReviewEvidence(projectId: string, taskId?: string, reviewerCommandIds?: string[], counterSupplement?: false | string): OwnerTechnicalReviewEvidence[] {
  if (!projectId.trim() || (taskId !== undefined && !taskId.trim())) throw new Error('Owner 技术评审查询主体无效')
  const rows = store.getProjectDb().prepare(`SELECT reviewer_command_id, project_id, grant_id, task_id, step_link_id, rework_ordinal,
      executor_command_id, executor_execution_id, reviewer_execution_id, source_hash, verdict,
      validation_evidence_json, validation_evidence_sha256, response_json, response_sha256, original_response_text, original_response_sha256, created_at
    FROM project_owner_technical_reviews WHERE project_id=? AND (? IS NULL OR task_id=?)
      AND (? IS NULL OR reviewer_command_id IN (SELECT value FROM json_each(?)))
      AND (? IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM project_owner_document_review_retries d
        JOIN project_owner_technical_reviews current_review ON current_review.reviewer_command_id=d.reviewer_id
        WHERE d.previous_reviewer_id=project_owner_technical_reviews.reviewer_command_id
      ))
    ORDER BY created_at, reviewer_command_id`)
    .all(projectId, taskId ?? null, taskId ?? null, reviewerCommandIds ? 1 : null, JSON.stringify(reviewerCommandIds ?? []), reviewerCommandIds ? 1 : null) as Array<{
      reviewer_command_id: string; project_id: string; grant_id: string; task_id: string; step_link_id: string; rework_ordinal: number
      executor_command_id: string; executor_execution_id: string; reviewer_execution_id: string; source_hash: string
      validation_evidence_json: string; validation_evidence_sha256: string
      verdict: OwnerTechnicalReviewVerdict; response_json: string; response_sha256: string; created_at: number
      original_response_text: string | null; original_response_sha256: string | null
    }>
  return rows.map(row => {
    if (!/^[a-f0-9]{64}$/.test(row.response_sha256) || createHash('sha256').update(row.response_json, 'utf8').digest('hex') !== row.response_sha256) {
      throw new Error('Owner 技术评审记录完整性校验失败')
    }
    if (row.original_response_sha256 !== (row.original_response_text === null ? null : createHash('sha256').update(row.original_response_text, 'utf8').digest('hex'))) {
      throw new Error('Owner原始评审回执完整性校验失败')
    }
    let raw: unknown
    try { raw = JSON.parse(row.response_json) } catch { throw new Error('Owner 技术评审记录不是有效 JSON') }
    if (!isRecord(raw) || raw.verdict !== row.verdict) throw new Error('Owner 技术评审记录与索引状态不一致')
    const criteriaValues = Array.isArray(raw.criteria) ? raw.criteria as unknown[] : []
    const frozenCriteria = criteriaValues.map(item => isRecord(item) && typeof item.criterion === 'string' ? item.criterion : '')
    const artifactKind = raw.schemaVersion === 3 ? 'development' : 'text'
    const artifactHash = (raw.schemaVersion === 2 || raw.schemaVersion === 3) && typeof raw.artifactHash === 'string' ? raw.artifactHash : undefined
    let artifactVerified: boolean | undefined, artifactContent: string | undefined, developmentArtifact: OwnerDevelopmentDeliveryArtifact | undefined
    if (artifactHash) {
      try {
        if (artifactKind === 'development') {
          const execution = store.getAgentExecution(row.reviewer_execution_id)
          const artifact = execution?.prompt ? ownerDevelopmentArtifactFromPrompt(execution.prompt) : null
          artifactVerified = artifact?.contentHash === artifactHash
          if (artifactVerified) {
            artifactContent = artifact!.content
            const frozen = readOwnerCommandFrozenSource(row.reviewer_command_id).source
            developmentArtifact = {
              projectId: row.project_id, grantId: row.grant_id, taskId: row.task_id, stepLinkId: row.step_link_id,
              sourceHash: row.source_hash, planRevision: frozen.planRevision, reworkOrdinal: row.rework_ordinal,
              ...artifact!, validationEvidence: artifact!.validationEvidence ?? [],
            }
          }
        } else {
          const artifact = assertOwnerReviewerTextDelivery(row.reviewer_command_id)
          artifactVerified = artifact?.contentSha256 === artifactHash
          if (artifactVerified) artifactContent = artifact!.content
        }
      }
      catch { artifactVerified = false }
    }
    const response = parseOwnerTechnicalReviewResponse(row.response_json, frozenCriteria, artifactHash, artifactContent, artifactKind, developmentArtifact?.validationEvidence)
    if (!/^[a-f0-9]{64}$/.test(row.validation_evidence_sha256)
      || createHash('sha256').update(row.validation_evidence_json, 'utf8').digest('hex') !== row.validation_evidence_sha256) {
      throw new Error('Owner验证回执记录完整性校验失败')
    }
    let validationEvidence: unknown
    try { validationEvidence = JSON.parse(row.validation_evidence_json) } catch { throw new Error('Owner验证回执不是有效JSON') }
    if (!Array.isArray(validationEvidence) || validationEvidence.some(item => !isOwnerDevelopmentValidationArtifact(item))) throw new Error('Owner验证回执结构无效')
    const review: OwnerTechnicalReviewEvidence = {
      ...response,
      ...(developmentArtifact && artifactVerified ? { developmentArtifact } : {}),
      ...(artifactKind === 'development' ? { validationEvidence: validationEvidence as OwnerDevelopmentValidationArtifact[], validationEvidenceVerified: true } : {}),
      ...(artifactVerified === undefined ? {} : { artifactVerified }),
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
    if (counterSupplement === false || !developmentArtifact || response.verdict !== 'blocked') return review
    const { applyOwnerCounterSupplement } = require('./project-owner-counter-supplement') as typeof import('./project-owner-counter-supplement')
    return applyOwnerCounterSupplement(review, counterSupplement)
  })
}
