/**
 * 外部变化观察的用户反馈。
 *
 * 反馈只影响"要不要提醒你"，不改项目目标、不改授权、不写全局记忆。
 * 不相关 = 该来源以后不再提醒；暂不关注 = 到 snoozeUntil 之前不再提醒。
 */
import { createHash } from 'node:crypto'
import { getAuthorizedProjectWebChangeObservation, normalizeWebSourceId } from './project-web-change-observations'
import { getProjectDb } from './project-sqlite-store'

const MAX_REASON = 500
const MAX_LIST = 50
const DEFAULT_SNOOZE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export type WebObservationFeedbackVerdict = 'helpful' | 'irrelevant' | 'snooze'

const VERDICTS: readonly WebObservationFeedbackVerdict[] = ['helpful', 'irrelevant', 'snooze']

export interface WebObservationFeedback {
  schemaVersion: 1
  id: string
  projectId: string
  observationId: string
  verdict: WebObservationFeedbackVerdict
  /** 反馈当时的来源标识；之后不再回查账本，避免旧观察被清理后提醒策略失效。 */
  sourceIds: string[]
  reason: string | null
  snoozeUntil: number | null
  createdAt: number
}

export interface RecordWebObservationFeedbackInput {
  projectId: string
  observationId: string
  verdict: WebObservationFeedbackVerdict
  reason?: string | null
  snoozeDays?: number
  now?: number
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** 同一观察同一结论只保留一条；重复点击幂等，改判会留下新记录。 */
export function recordWebObservationFeedback(input: RecordWebObservationFeedbackInput): WebObservationFeedback | null {
  if (typeof input.projectId !== 'string' || typeof input.observationId !== 'string') throw new Error('反馈身份无效')
  if (!VERDICTS.includes(input.verdict)) throw new Error('反馈结论无效')
  const observation = getAuthorizedProjectWebChangeObservation(input.projectId, input.observationId)
  if (!observation) return null
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, MAX_REASON) || null : null
  const createdAt = input.now ?? Date.now()
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error('反馈时间无效')
  const snoozeUntil = input.verdict === 'snooze'
    ? createdAt + Math.max(1, Math.min(90, Math.trunc(input.snoozeDays ?? DEFAULT_SNOOZE_DAYS))) * DAY_MS
    : null
  const id = digest({ projectId: input.projectId, observationId: input.observationId, verdict: input.verdict })
  const feedback: WebObservationFeedback = {
    schemaVersion: 1,
    id,
    projectId: input.projectId,
    observationId: input.observationId,
    verdict: input.verdict,
    sourceIds: [...new Set(observation.facts.map((fact) => fact.sourceId))],
    reason,
    snoozeUntil,
    createdAt,
  }
  const database = getProjectDb()
  const existing = database.prepare('SELECT payload FROM project_web_observation_feedback WHERE id = ?').get(id) as { payload: string } | undefined
  if (existing) {
    // 同一结论重复提交不覆盖首次时间与原因，保持证据稳定。
    try {
      return JSON.parse(existing.payload) as WebObservationFeedback
    } catch {
      return null
    }
  }
  database.prepare('INSERT INTO project_web_observation_feedback (id, project_id, observation_id, verdict, snooze_until, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.projectId, input.observationId, input.verdict, snoozeUntil, createdAt, JSON.stringify(feedback))
  return feedback
}

/** 按时间倒序读取反馈；损坏行跳过。 */
export function listWebObservationFeedback(projectId: string, limit = 20): WebObservationFeedback[] {
  if (typeof projectId !== 'string' || !projectId) return []
  const rows = getProjectDb().prepare('SELECT payload FROM project_web_observation_feedback WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(projectId, Math.max(1, Math.min(MAX_LIST, Math.trunc(limit)))) as Array<{ payload: string }>
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.payload) as WebObservationFeedback]
    } catch {
      return []
    }
  })
}

/** 当前仍在生效的静音来源：不相关长期有效，暂不关注到点失效。 */
export function listMutedSourceIds(projectId: string, now = Date.now()): Set<string> {
  const muted = new Set<string>()
  for (const feedback of listWebObservationFeedback(projectId, MAX_LIST)) {
    if (feedback.verdict === 'helpful') continue
    if (feedback.verdict === 'snooze' && (feedback.snoozeUntil === null || feedback.snoozeUntil <= now)) continue
    for (const sourceId of feedback.sourceIds) muted.add(sourceId)
  }
  return muted
}

/** 全部来源都被静音时不再占用注意力；只要有一条新来源仍会提醒。 */
export function isObservationMuted(projectId: string, facts: Array<{ url: string }>, now = Date.now()): boolean {
  if (!facts.length) return false
  const muted = listMutedSourceIds(projectId, now)
  if (!muted.size) return false
  return facts.every((fact) => {
    const sourceId = normalizeWebSourceId(fact.url)
    return Boolean(sourceId && muted.has(sourceId))
  })
}
