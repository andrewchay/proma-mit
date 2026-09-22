import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const METRICS_FILE_NAME = 'metrics.jsonl'

export type ContextCacheStatus = 'hit' | 'miss' | 'unknown'
export type ContextMetricStage = 'turn_started' | 'turn_finished'

/**
 * Typed Context Compiler 的无正文运行指标。
 *
 * 每个 turn 可以写入 start/finish 两个事件；未知 cache 能力必须显式记录为 unknown，
 * 不可将其推断为命中。该文件是观测数据，不参与模型 prompt 或会话恢复。
 */
export interface ContextCompilerMetricEvent {
  version: 1
  id: string
  stage: ContextMetricStage
  at: string
  sessionId: string
  workspaceId?: string
  runtime: 'claude' | 'proma' | 'ai-sdk' | 'pi'
  provider?: string
  modelId?: string
  inputTokenEstimate?: number
  outputTokens?: number
  cacheStatus: ContextCacheStatus
  durationMs?: number
  retryCount?: number
  failureCode?: string
  ledgerSourceRevision?: string
}

export class ContextMetricsStore {
  constructor(private readonly directory: string) {}

  append(event: ContextCompilerMetricEvent): void {
    if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true })
    appendFileSync(this.path(), `${JSON.stringify(event)}\n`, 'utf8')
  }

  list(sessionId?: string): ContextCompilerMetricEvent[] {
    if (!existsSync(this.path())) return []
    try {
      return readFileSync(this.path(), 'utf8')
        .split('\n')
        .flatMap((line) => parseMetricEvent(line))
        .filter((event) => !sessionId || event.sessionId === sessionId)
    } catch {
      return []
    }
  }

  private path(): string {
    return join(this.directory, METRICS_FILE_NAME)
  }
}

function parseMetricEvent(line: string): ContextCompilerMetricEvent[] {
  if (!line.trim()) return []
  try {
    const value: unknown = JSON.parse(line)
    return isMetricEvent(value) ? [value] : []
  } catch {
    return []
  }
}

function isMetricEvent(value: unknown): value is ContextCompilerMetricEvent {
  if (!isRecord(value)) return false
  return value.version === 1
    && typeof value.id === 'string'
    && (value.stage === 'turn_started' || value.stage === 'turn_finished')
    && typeof value.at === 'string'
    && typeof value.sessionId === 'string'
    && isRuntime(value.runtime)
    && isCacheStatus(value.cacheStatus)
    && isOptionalNonNegativeInteger(value.inputTokenEstimate)
    && isOptionalNonNegativeInteger(value.outputTokens)
    && isOptionalNonNegativeInteger(value.durationMs)
    && isOptionalNonNegativeInteger(value.retryCount)
    && isOptionalString(value.provider)
    && isOptionalString(value.modelId)
    && isOptionalString(value.failureCode)
    && isOptionalString(value.ledgerSourceRevision)
}

function isRuntime(value: unknown): value is ContextCompilerMetricEvent['runtime'] {
  return value === 'claude' || value === 'proma' || value === 'ai-sdk' || value === 'pi'
}

function isCacheStatus(value: unknown): value is ContextCacheStatus {
  return value === 'hit' || value === 'miss' || value === 'unknown'
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
