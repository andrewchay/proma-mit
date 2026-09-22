import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ContextItem, ContextItemKind, ContextVisibility } from '@gravitas/shared'

const LEDGER_FILE_NAME = 'ledger.jsonl'
const SUMMARY_FILE_NAME = 'summaries.jsonl'

interface ContextLedgerRecord {
  version: 1
  item: Omit<ContextItem, 'summary'>
}

interface ContextSummaryRecord {
  version: 1
  itemId: string
  itemVersion: number
  summary: string
}

export interface ContextLedgerFilter {
  sessionId?: string
  kind?: ContextItemKind
  visibility?: ContextVisibility
}

export interface ToolObservationInput {
  eventId: string
  sessionId: string
  workspaceId?: string
  toolName: string
  result: string
  summary?: string
  tags?: string[]
  createdAt?: string
}

export interface SessionMessageInput {
  eventId: string
  sessionId: string
  workspaceId?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  summary?: string
  createdAt?: string
}

export interface ArtifactInput {
  artifactId: string
  sourceEventId: string
  sessionId: string
  workspaceId?: string
  title: string
  content: string
  summary?: string
  createdAt?: string
}

/**
 * 工作区范围的 append-only 上下文账本。
 *
 * 原文事实与派生摘要分别写入 JSONL；读取时再以 itemId/version 关联，避免摘要覆盖事实。
 */
export class ContextLedgerStore {
  constructor(private readonly directory: string) {}

  append(item: ContextItem): ContextItem {
    const existing = this.list().find((candidate) => (
      candidate.source.id === item.source.id && candidate.version === item.version
    ))
    if (existing) return existing

    this.ensureDirectory()
    const { summary, ...rawItem } = item
    const record: ContextLedgerRecord = { version: 1, item: rawItem }
    appendFileSync(this.ledgerPath(), `${JSON.stringify(record)}\n`, 'utf8')

    if (summary) {
      const summaryRecord: ContextSummaryRecord = {
        version: 1,
        itemId: item.id,
        itemVersion: item.version,
        summary,
      }
      appendFileSync(this.summaryPath(), `${JSON.stringify(summaryRecord)}\n`, 'utf8')
    }

    return cloneItem(item)
  }

  list(filter: ContextLedgerFilter = {}): ContextItem[] {
    const summaries = this.readSummaries()
    return this.readRecords()
      .map(({ item }) => ({
        ...item,
        summary: summaries.get(summaryKey(item.id, item.version)),
      }))
      .filter((item) => matchesFilter(item, filter))
      .map(cloneItem)
  }

  sourceRevision(): string {
    const serializedItems = JSON.stringify(this.list())
    return `sha256:${createHash('sha256').update(serializedItems).digest('hex')}`
  }

  private ensureDirectory(): void {
    if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true })
  }

  private ledgerPath(): string {
    return join(this.directory, LEDGER_FILE_NAME)
  }

  private summaryPath(): string {
    return join(this.directory, SUMMARY_FILE_NAME)
  }

  private readRecords(): ContextLedgerRecord[] {
    if (!existsSync(this.ledgerPath())) return []
    return readJsonLines(this.ledgerPath()).flatMap((value) => isContextLedgerRecord(value) ? [value] : [])
  }

  private readSummaries(): Map<string, string> {
    if (!existsSync(this.summaryPath())) return new Map()
    return new Map(readJsonLines(this.summaryPath()).flatMap((value) => {
      if (!isContextSummaryRecord(value)) return []
      return [[summaryKey(value.itemId, value.itemVersion), value.summary] as const]
    }))
  }
}

/** 将已完成工具调用转换为可追溯、默认对模型可见的上下文事实。 */
export function recordToolObservation(store: ContextLedgerStore, input: ToolObservationInput): ContextItem {
  const timestamp = input.createdAt ?? new Date().toISOString()
  return store.append({
    id: contextItemId('tool_observation', input.eventId),
    kind: 'tool_observation',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: `工具 ${input.toolName} 的结果：\n${input.result}`,
    summary: input.summary,
    tags: input.tags ?? [input.toolName],
    visibility: 'model',
    mutability: 'append_only',
    confidence: 'high',
    source: {
      kind: 'tool_result',
      id: input.eventId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    },
    evidence: [{
      kind: 'tool_result',
      sourceId: input.eventId,
      locator: input.toolName,
      verified: true,
    }],
  })
}

/** 将原始会话消息登记为事实或待验证 Agent 状态，不替代现有 session JSONL。 */
export function recordSessionMessage(store: ContextLedgerStore, input: SessionMessageInput): ContextItem {
  const timestamp = input.createdAt ?? new Date().toISOString()
  const isUser = input.role === 'user'
  const isSystem = input.role === 'system'
  return store.append({
    id: contextItemId('session_message', input.eventId),
    kind: isUser ? 'user_intent' : isSystem ? 'constraint' : 'task_state',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: input.content,
    summary: input.summary,
    tags: [input.role],
    visibility: isSystem ? 'private' : 'model',
    mutability: 'append_only',
    confidence: isUser || isSystem ? 'high' : 'unknown',
    source: {
      kind: 'session_message',
      id: input.eventId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    },
    evidence: [{
      kind: 'session_message',
      sourceId: input.eventId,
      locator: input.role,
      verified: isUser || isSystem,
    }],
  })
}

/** 将 Agent 产生的独立交付物登记为 artifact；其来源消息仍作为追溯证据保留。 */
export function recordArtifact(store: ContextLedgerStore, input: ArtifactInput): ContextItem {
  const timestamp = input.createdAt ?? new Date().toISOString()
  return store.append({
    id: input.artifactId,
    kind: 'artifact',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: input.content,
    summary: input.summary,
    tags: ['artifact'],
    visibility: 'parent',
    mutability: 'append_only',
    confidence: 'medium',
    source: {
      kind: 'agent_artifact',
      id: input.artifactId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    },
    evidence: [{
      kind: 'session_message',
      sourceId: input.sourceEventId,
      verified: false,
    }],
  })
}

function readJsonLines(path: string): unknown[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function matchesFilter(item: ContextItem, filter: ContextLedgerFilter): boolean {
  if (filter.sessionId && item.source.sessionId !== filter.sessionId) return false
  if (filter.kind && item.kind !== filter.kind) return false
  if (filter.visibility && item.visibility !== filter.visibility) return false
  return true
}

function isContextLedgerRecord(value: unknown): value is ContextLedgerRecord {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.item)) return false
  return isContextItem(value.item)
}

function isContextSummaryRecord(value: unknown): value is ContextSummaryRecord {
  return isRecord(value)
    && value.version === 1
    && typeof value.itemId === 'string'
    && Number.isInteger(value.itemVersion)
    && typeof value.summary === 'string'
}

function isContextItem(value: Record<string, unknown>): value is Omit<ContextItem, 'summary'> {
  return typeof value.id === 'string'
    && typeof value.kind === 'string'
    && Number.isInteger(value.version)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && typeof value.content === 'string'
    && Array.isArray(value.tags)
    && typeof value.visibility === 'string'
    && typeof value.mutability === 'string'
    && typeof value.confidence === 'string'
    && isRecord(value.source)
    && typeof value.source.id === 'string'
    && typeof value.source.sessionId === 'string'
    && Array.isArray(value.evidence)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contextItemId(kind: string, sourceId: string): string {
  return `${kind}:${sourceId}`
}

function summaryKey(itemId: string, version: number): string {
  return `${itemId}:${version}`
}

function cloneItem(item: ContextItem): ContextItem {
  return JSON.parse(JSON.stringify(item)) as ContextItem
}
