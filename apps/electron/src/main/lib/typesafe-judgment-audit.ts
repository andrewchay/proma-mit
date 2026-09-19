import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TypeSafeRecommendationFeedback } from '@gravitas/shared'
import { getConfigDir } from './config-paths'

const MAX_AUDIT_BYTES = 5 * 1024 * 1024

export type TypeSafeDecisionKind = 'skill_shadow' | 'chat_agent_route' | 'connection_test'

export interface TypeSafeDecisionAuditInput {
  decisionId?: string
  kind: TypeSafeDecisionKind
  status: 'success' | 'unavailable' | 'skipped'
  model: string
  latencyMs: number
  contextId?: string
  selected?: string
  probability?: number
  confidence?: number
  probabilities?: Record<string, number>
  inputTokens?: number
  outputTokens?: number
  reasonCode?: string
  mode?: 'shadow' | 'active'
}

function getAuditDir(): string {
  const dir = join(getConfigDir(), 'typesafe')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function getAuditPath(): string {
  return join(getAuditDir(), 'decisions.jsonl')
}

function rotateIfNeeded(path: string): void {
  if (!existsSync(path) || statSync(path).size < MAX_AUDIT_BYTES) return
  const rotated = `${path}.1`
  rmSync(rotated, { force: true })
  renameSync(path, rotated)
}

function hashContextId(value: string | undefined): string | undefined {
  if (!value) return undefined
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function appendAudit(record: Record<string, unknown>): void {
  try {
    const path = getAuditPath()
    rotateIfNeeded(path)
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    // 审计是 best-effort 观测，不得影响 Chat/Agent 主流程或故障回退。
    console.warn('[TypeSafe] 写入本地判断审计失败:', error)
  }
}

export function recordTypeSafeDecision(input: TypeSafeDecisionAuditInput): string {
  const decisionId = input.decisionId ?? randomUUID()
  appendAudit({
    event: 'decision',
    timestamp: new Date().toISOString(),
    ...input,
    decisionId,
    contextId: hashContextId(input.contextId),
  })
  return decisionId
}

export function recordTypeSafeRecommendationFeedback(
  feedback: TypeSafeRecommendationFeedback,
): void {
  appendAudit({
    event: 'recommendation_feedback',
    timestamp: new Date().toISOString(),
    decisionId: feedback.decisionId,
    action: feedback.action,
  })
}
