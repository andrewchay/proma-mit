/**
 * 项目外部变化观察账本。
 *
 * 只记账：一次扫描的判断结果（事实、影响、建议、提问）落 SQLite，带稳定身份与内容哈希，
 * 重复写入幂等、内容不一致拒绝覆盖。观察记录不构成任何执行授权，也不改变项目目标。
 * 与 project-file-change-observations.ts 同一族：稳定身份 + 读时复核 + 有界保留。
 */
import { createHash } from 'node:crypto'
import type {
  ProjectWebChangeFact,
  ProjectWebChangeObservation,
  WebChangeDuplicateReason,
  WebChangeJudgment,
} from '@gravitas/shared'
import { getProject, getProjectDb } from './project-sqlite-store'

const SCHEMA_VERSION = 1
export const MAX_WEB_CHANGE_FACTS = 20
const MAX_TITLE = 300
const MAX_URL = 2000
const MAX_QUOTE = 600
const MAX_TEXT = 2000
const MAX_QUESTION = 300
const MAX_ID = 100
const MAX_TOPICS = 8
const MAX_TOPIC = 200
const MAX_RELATED = 10
/** 每个项目保留最近 500 条 / 90 天（2026-10-31 用户确认）。 */
const RETENTION_COUNT = 500
const RETENTION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000

const JUDGMENTS: readonly WebChangeJudgment[] = ['record_only', 'attention', 'decision_required', 'insufficient_evidence', 'duplicate']
const DUPLICATE_REASONS: readonly WebChangeDuplicateReason[] = ['same_source', 'same_event', 'no_new_content']
const TRACKING_PARAMS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'spm', 'ref', 'ref_src', 'from', 'share_token'])

export interface RecordWebChangeObservationInput {
  projectId: string
  /** 本次扫描流水 id，用于把观察回溯到原始结果。 */
  runId: string
  judgment: WebChangeJudgment
  facts: Array<{ title: string; url: string; quote?: string; publishedAt?: string | null; isInference: boolean }>
  /** 本次扫描的新来源；观察只能引用这里出现过的链接。 */
  knownSources: Array<{ url: string }>
  impact?: string | null
  suggestion?: string | null
  question?: string | null
  uncertainty?: string | null
  failureReason?: string | null
  relatedObservationIds?: string[]
  duplicateOf?: string | null
  duplicateReason?: WebChangeDuplicateReason | null
  binding: { goalRevision?: number | null; contextFingerprint?: string | null; topics: string[] }
  evaluation: { modelId?: string | null; promptVersion: number; sourcesCount: number; truncated: boolean }
  createdAt?: number
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** URL 归一化为来源标识；不合法返回 null，调用方必须拒绝而不是猜测。 */
export function normalizeWebSourceId(url: string): string | null {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  if (!trimmed || trimmed.length > MAX_URL) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  parsed.hash = ''
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key)
  }
  const query = parsed.searchParams.toString()
  const path = parsed.pathname.replace(/\/+$/, '') || '/'
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${path}${query ? `?${query}` : ''}`
}

function text(value: unknown, field: string, max: number, required: boolean): string | null {
  if (value === null || value === undefined) {
    if (required) throw new Error(`${field}不能为空`)
    return null
  }
  if (typeof value !== 'string') throw new Error(`${field}必须是文本`)
  const trimmed = value.trim()
  if (!trimmed) {
    if (required) throw new Error(`${field}不能为空`)
    return null
  }
  if (trimmed.length > max) throw new Error(`${field}不能超过 ${max} 个字符`)
  return trimmed
}

function integer(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`${field}必须是大于等于 ${min} 的整数`)
  return value
}

function normalizeFacts(input: unknown, knownSourceIds: ReadonlySet<string>): ProjectWebChangeFact[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error('观察事实必须是数组')
  if (input.length > MAX_WEB_CHANGE_FACTS) throw new Error(`单次观察最多 ${MAX_WEB_CHANGE_FACTS} 条事实`)
  const facts: ProjectWebChangeFact[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw new Error('观察事实结构无效')
    const item = raw as Record<string, unknown>
    if (typeof item.isInference !== 'boolean') throw new Error('每条事实都必须标明是事实还是推断')
    const title = text(item.title, '来源标题', MAX_TITLE, true)!
    const url = text(item.url, '来源链接', MAX_URL, true)!
    const sourceId = normalizeWebSourceId(url)
    if (!sourceId) throw new Error('来源链接必须是 http/https 地址')
    if (!knownSourceIds.has(sourceId)) throw new Error('来源链接不在本次扫描结果内，拒绝记录')
    if (seen.has(sourceId)) throw new Error('同一次观察不能重复引用同一来源')
    seen.add(sourceId)
    const quote = text(item.quote, '来源引用', MAX_QUOTE, !item.isInference) ?? ''
    const publishedRaw = item.publishedAt
    let publishedAt: string | null = null
    if (publishedRaw !== null && publishedRaw !== undefined) {
      if (typeof publishedRaw === 'string' && /^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/.test(publishedRaw.trim())) publishedAt = publishedRaw.trim()
      else throw new Error('发布时间必须是 ISO 日期或留空')
    }
    facts.push({ title, url, sourceId, publishedAt, quote, isInference: item.isInference })
  }
  return facts
}

function observationIdentity(input: { projectId: string; runId: string; judgment: WebChangeJudgment; facts: ProjectWebChangeFact[]; duplicateOf: string | null }): string {
  return digest({
    projectId: input.projectId,
    runId: input.runId,
    judgment: input.judgment,
    sourceIds: [...new Set(input.facts.map((fact) => fact.sourceId))].sort(),
    duplicateOf: input.duplicateOf,
  })
}

/** 记录一次扫描的判断结果；项目不存在返回 null，参数不合法直接拒绝。 */
export function recordProjectWebChangeObservation(input: RecordWebChangeObservationInput): ProjectWebChangeObservation | null {
  if (typeof input.projectId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(input.projectId)) throw new Error('项目 ID 无效')
  if (!getProject(input.projectId)) return null
  const runId = text(input.runId, '扫描批次', MAX_ID, true)!
  if (!JUDGMENTS.includes(input.judgment)) throw new Error('观察判定无效')
  const judgment = input.judgment
  const knownSourceIds = new Set(
    input.knownSources.map((source) => normalizeWebSourceId(source.url)).filter((value): value is string => Boolean(value)),
  )
  const facts = normalizeFacts(input.facts, knownSourceIds)

  if ((judgment === 'attention' || judgment === 'decision_required' || judgment === 'record_only') && facts.length === 0) {
    throw new Error('该判定必须至少引用一条来源')
  }
  const question = text(input.question, '待决问题', MAX_QUESTION, judgment === 'decision_required')
  const failureReason = text(input.failureReason, '失败原因', MAX_TEXT, judgment === 'insufficient_evidence')
  const duplicateOf = text(input.duplicateOf, '重复指向的观察', MAX_ID, judgment === 'duplicate')
  if (judgment === 'duplicate') {
    if (!input.duplicateReason || !DUPLICATE_REASONS.includes(input.duplicateReason)) throw new Error('重复观察必须给出重复原因')
    const existing = duplicateOf ? getStoredObservation(input.projectId, duplicateOf) : null
    if (!existing) throw new Error('重复指向的观察不存在')
  } else if (duplicateOf || input.duplicateReason) {
    throw new Error('只有重复观察才能携带重复来源')
  }

  const relatedObservationIds = [...new Set(input.relatedObservationIds ?? [])]
  if (relatedObservationIds.length > MAX_RELATED) throw new Error(`关联观察最多 ${MAX_RELATED} 条`)
  for (const id of relatedObservationIds) {
    if (typeof id !== 'string' || !getStoredObservation(input.projectId, id)) throw new Error('关联观察不存在于本项目')
  }

  const topics = input.binding.topics.map((topic) => text(topic, '扫描主题', MAX_TOPIC, true)!)
  if (topics.length > MAX_TOPICS) throw new Error(`扫描主题最多 ${MAX_TOPICS} 个`)
  const goalRevision = input.binding.goalRevision === null || input.binding.goalRevision === undefined
    ? null : integer(input.binding.goalRevision, '目标版本', 1)
  const contextFingerprint = text(input.binding.contextFingerprint, '上下文指纹', MAX_ID, false)
  const promptVersion = integer(input.evaluation.promptVersion, '提示词版本', 1)
  const sourcesCount = integer(input.evaluation.sourcesCount, '来源数量', 0)
  const modelId = text(input.evaluation.modelId, '判断模型', MAX_ID, false)
  if (typeof input.evaluation.truncated !== 'boolean') throw new Error('必须标明上下文是否被截断')

  const createdAt = input.createdAt ?? Date.now()
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error('观察时间无效')

  const id = observationIdentity({ projectId: input.projectId, runId, judgment, facts, duplicateOf })
  const content = {
    schemaVersion: SCHEMA_VERSION as 1,
    projectId: input.projectId,
    runId,
    judgment,
    facts,
    impact: text(input.impact, '潜在影响', MAX_TEXT, false),
    suggestion: text(input.suggestion, '建议动作', MAX_TEXT, false),
    question,
    uncertainty: text(input.uncertainty, '不确定性说明', MAX_TEXT, false),
    failureReason,
    relatedObservationIds,
    duplicateOf,
    duplicateReason: judgment === 'duplicate' ? input.duplicateReason ?? null : null,
    binding: { goalRevision, contextFingerprint, topics },
    evaluation: { modelId, promptVersion, sourcesCount, truncated: input.evaluation.truncated },
  }
  const contentHash = digest(content)
  const database = getProjectDb()
  // 同一批次的重复写入只做一致性核对：时间以首次落库为准，不改写既有证据。
  const existing = getStoredObservation(input.projectId, id)
  if (existing) {
    if (existing.contentHash !== contentHash) throw new Error('同一扫描批次的观察内容不一致，拒绝覆盖')
    return existing
  }
  const observation: ProjectWebChangeObservation = { id, createdAt, ...content, contentHash }
  const payload = JSON.stringify(observation)
  database.prepare('INSERT OR IGNORE INTO project_web_change_observations (id, project_id, run_id, judgment, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, input.projectId, runId, judgment, createdAt, payload)
  const stored = database.prepare('SELECT payload FROM project_web_change_observations WHERE id = ?').get(id) as { payload: string } | undefined
  if (!stored || stored.payload !== payload) throw new Error('同一扫描批次的观察内容不一致，拒绝覆盖')
  pruneProjectWebChangeObservations(input.projectId)
  return observation
}

function getStoredObservation(projectId: string, id: string): ProjectWebChangeObservation | null {
  const row = getProjectDb().prepare('SELECT payload FROM project_web_change_observations WHERE project_id = ? AND id = ?').get(projectId, id) as { payload: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.payload) as ProjectWebChangeObservation
  } catch {
    return null
  }
}

/**
 * 读时复核：身份、内容哈希、字段结构、项目归属任一不符即返回 null。
 * 观察只在本项目内可用；项目删除后记录同步清理，取用自然失败。
 */
export function getAuthorizedProjectWebChangeObservation(projectId: string, id: string): ProjectWebChangeObservation | null {
  if (typeof projectId !== 'string' || typeof id !== 'string' || !id) return null
  const value = getStoredObservation(projectId, id)
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.projectId !== projectId) return null
  if (!JUDGMENTS.includes(value.judgment) || !Array.isArray(value.facts) || !Array.isArray(value.relatedObservationIds)) return null
  if (observationIdentity({ projectId: value.projectId, runId: value.runId, judgment: value.judgment, facts: value.facts, duplicateOf: value.duplicateOf }) !== value.id) return null
  const { id: actualId, contentHash, createdAt: _createdAt, ...content } = value
  if (actualId !== id || digest(content) !== contentHash) return null
  if (value.facts.some((fact) => normalizeWebSourceId(fact.url) !== fact.sourceId)) return null
  return value
}

/** 按时间倒序读取本项目观察；损坏行直接跳过，不猜测修复。 */
export function listProjectWebChangeObservations(projectId: string, limit = 20): ProjectWebChangeObservation[] {
  if (typeof projectId !== 'string' || !projectId) return []
  const rows = getProjectDb().prepare('SELECT payload FROM project_web_change_observations WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(projectId, Math.max(1, Math.min(200, Math.trunc(limit)))) as Array<{ payload: string }>
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.payload) as ProjectWebChangeObservation]
    } catch {
      return []
    }
  })
}

/** 按保留策略裁剪：先按时间窗，再按条数。返回删除条数。 */
export function pruneProjectWebChangeObservations(projectId: string, now = Date.now()): number {
  const database = getProjectDb()
  const expired = database.prepare('DELETE FROM project_web_change_observations WHERE project_id = ? AND created_at < ?').run(projectId, now - RETENTION_WINDOW_MS).changes
  const overflow = database.prepare('DELETE FROM project_web_change_observations WHERE project_id = ? AND id NOT IN (SELECT id FROM project_web_change_observations WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)')
    .run(projectId, projectId, RETENTION_COUNT).changes
  return expired + overflow
}
