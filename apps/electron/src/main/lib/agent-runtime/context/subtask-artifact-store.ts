import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextProjection, SubtaskResult } from '@gravitas/shared'

const ARTIFACT_VERSION = 1

export interface StoredSubtaskArtifact {
  version: typeof ARTIFACT_VERSION
  childSessionId: string
  parentSessionId: string
  task: string
  createdAt: string
  rawResponse: string
  result: SubtaskResult
  projection: {
    id: string
    sourceRevision: string
    sourceItemIds: string[]
  }
}

/**
 * 工作区私有的 child 产物存储。原始 response 与派生 typed result 同时保存，
 * 因此后续 parser/策略升级可以复放且不必把 transcript 注入父 Agent。
 */
export class SubtaskArtifactStore {
  constructor(private readonly directory: string) {}

  save(input: Omit<StoredSubtaskArtifact, 'version'>): StoredSubtaskArtifact {
    const existing = this.get(input.childSessionId)
    if (existing) return existing
    this.ensureDirectory()
    const record: StoredSubtaskArtifact = { version: ARTIFACT_VERSION, ...clone(input) }
    writeFileSync(this.filePath(input.childSessionId), JSON.stringify(record, null, 2), 'utf8')
    return clone(record)
  }

  get(childSessionId: string): StoredSubtaskArtifact | undefined {
    if (!isSafeId(childSessionId)) return undefined
    const path = this.filePath(childSessionId)
    if (!existsSync(path)) return undefined
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return isStoredSubtaskArtifact(value) ? clone(value) : undefined
    } catch {
      return undefined
    }
  }

  private ensureDirectory(): void {
    if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true })
  }

  private filePath(childSessionId: string): string {
    if (!isSafeId(childSessionId)) throw new Error('子任务会话 ID 非法')
    return join(this.directory, `${childSessionId}.json`)
  }
}

export function toStoredSubtaskArtifact(input: {
  childSessionId: string
  parentSessionId: string
  task: string
  rawResponse: string
  result: SubtaskResult
  projection: ContextProjection
  createdAt?: string
}): Omit<StoredSubtaskArtifact, 'version'> {
  return {
    childSessionId: input.childSessionId,
    parentSessionId: input.parentSessionId,
    task: input.task,
    createdAt: input.createdAt ?? new Date().toISOString(),
    rawResponse: input.rawResponse,
    result: input.result,
    projection: {
      id: input.projection.id,
      sourceRevision: input.projection.sourceRevision,
      sourceItemIds: input.projection.items.map(({ itemId }) => itemId),
    },
  }
}

function isStoredSubtaskArtifact(value: unknown): value is StoredSubtaskArtifact {
  if (!isRecord(value) || value.version !== ARTIFACT_VERSION) return false
  return isString(value.childSessionId)
    && isString(value.parentSessionId)
    && isString(value.task)
    && isString(value.createdAt)
    && isString(value.rawResponse)
    && isRecord(value.result)
    && isRecord(value.projection)
    && isString(value.projection.id)
    && isString(value.projection.sourceRevision)
    && Array.isArray(value.projection.sourceItemIds)
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
