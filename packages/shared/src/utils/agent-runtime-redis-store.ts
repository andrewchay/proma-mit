import type {
  AgentRuntimeDurableEventStore,
  AgentRuntimeEventRecord,
  AgentRuntimeEventReplayInput,
  AgentRuntimeScope,
  AgentRuntimeTaskMeta,
} from './agent-runtime-server'

export interface AgentRuntimeRedisStreamEntry {
  id: string
  fields: readonly string[] | Record<string, string>
}

export interface AgentRuntimeRedisSetOptions {
  ttlMs?: number
}

export interface AgentRuntimeRedisClient {
  xadd(key: string, id: string, fields: Record<string, string>): Promise<string>
  xrange(key: string, start: string, end: string, options?: { count?: number }): Promise<AgentRuntimeRedisStreamEntry[]>
  xtrim?(key: string, maxLen: number): Promise<void>
  set(key: string, value: string, options?: AgentRuntimeRedisSetOptions): Promise<void>
  get(key: string): Promise<string | undefined>
  del(key: string): Promise<void>
}

export interface RedisAgentRuntimeEventStoreOptions {
  client: AgentRuntimeRedisClient
  keyPrefix?: string
  maxEventsPerSession?: number
  replayCount?: number
}

export interface RedisAgentRuntimeTaskCacheOptions {
  client: AgentRuntimeRedisClient
  keyPrefix?: string
  ttlMs?: number
}

export class RedisAgentRuntimeEventStore implements AgentRuntimeDurableEventStore {
  private readonly keyPrefix: string
  private readonly maxEventsPerSession: number
  private readonly replayCount: number

  constructor(private readonly options: RedisAgentRuntimeEventStoreOptions) {
    this.keyPrefix = options.keyPrefix ?? 'proma:runtime'
    this.maxEventsPerSession = options.maxEventsPerSession ?? 1000
    this.replayCount = options.replayCount ?? this.maxEventsPerSession
  }

  async append(event: AgentRuntimeEventRecord): Promise<void> {
    const key = this.eventKey(event)
    await this.options.client.xadd(key, normalizeRedisStreamId(event.id), {
      event: JSON.stringify(event),
    })
    await this.options.client.xtrim?.(key, this.maxEventsPerSession)
  }

  async replay(input: AgentRuntimeEventReplayInput): Promise<AgentRuntimeEventRecord[]> {
    const entries = await this.options.client.xrange(this.eventKey(input), '-', '+', {
      count: this.replayCount,
    })
    const events = entries
      .map((entry) => parseEventRecord(entry))
      .filter((event): event is AgentRuntimeEventRecord => event != null)
      .filter((event) =>
        event.tenantId === input.tenantId &&
        event.userId === input.userId &&
        event.sessionId === input.sessionId)
    if (!input.afterId) return events
    const idx = events.findIndex((event) => event.id === input.afterId)
    return idx >= 0 ? events.slice(idx + 1) : events
  }

  private eventKey(input: Pick<AgentRuntimeEventRecord, 'tenantId' | 'userId' | 'sessionId'>): string {
    return [
      this.keyPrefix,
      'events',
      encodeRedisKeyPart(input.tenantId),
      encodeRedisKeyPart(input.userId),
      encodeRedisKeyPart(input.sessionId),
    ].join(':')
  }
}

export class RedisAgentRuntimeTaskCache {
  private readonly keyPrefix: string
  private readonly ttlMs?: number

  constructor(private readonly options: RedisAgentRuntimeTaskCacheOptions) {
    this.keyPrefix = options.keyPrefix ?? 'proma:runtime'
    this.ttlMs = options.ttlMs
  }

  async setTask(task: AgentRuntimeTaskMeta): Promise<void> {
    await this.options.client.set(this.taskKey(task, task.taskId), JSON.stringify(task), {
      ttlMs: this.ttlMs,
    })
  }

  async getTask(scope: AgentRuntimeScope, taskId: string): Promise<AgentRuntimeTaskMeta | undefined> {
    const raw = await this.options.client.get(this.taskKey(scope, taskId))
    if (!raw) return undefined
    const parsed = parseTaskMeta(raw)
    if (
      !parsed ||
      parsed.tenantId !== scope.tenantId ||
      parsed.userId !== scope.userId ||
      parsed.taskId !== taskId
    ) {
      return undefined
    }
    return parsed
  }

  async deleteTask(scope: AgentRuntimeScope, taskId: string): Promise<void> {
    await this.options.client.del(this.taskKey(scope, taskId))
  }

  private taskKey(input: AgentRuntimeScope, taskId: string): string {
    return [
      this.keyPrefix,
      'tasks',
      encodeRedisKeyPart(input.tenantId),
      encodeRedisKeyPart(input.userId),
      encodeRedisKeyPart(taskId),
    ].join(':')
  }
}

function parseEventRecord(entry: AgentRuntimeRedisStreamEntry): AgentRuntimeEventRecord | undefined {
  const raw = getRedisField(entry.fields, 'event')
  if (!raw) return undefined
  const parsed = JSON.parse(raw) as Partial<AgentRuntimeEventRecord>
  if (
    typeof parsed.id !== 'string' ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.tenantId !== 'string' ||
    typeof parsed.userId !== 'string' ||
    typeof parsed.createdAt !== 'number' ||
    parsed.payload == null
  ) {
    return undefined
  }
  return parsed as AgentRuntimeEventRecord
}

function parseTaskMeta(raw: string): AgentRuntimeTaskMeta | undefined {
  const parsed = JSON.parse(raw) as Partial<AgentRuntimeTaskMeta>
  if (
    typeof parsed.tenantId !== 'string' ||
    typeof parsed.userId !== 'string' ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.taskId !== 'string' ||
    !['running', 'completed', 'failed', 'cancelled'].includes(parsed.status ?? '') ||
    typeof parsed.startedAt !== 'number'
  ) {
    return undefined
  }
  return parsed as AgentRuntimeTaskMeta
}

function getRedisField(fields: readonly string[] | Record<string, string>, name: string): string | undefined {
  if (isRedisFieldArray(fields)) {
    const idx = fields.findIndex((field) => field === name)
    return idx >= 0 ? fields[idx + 1] : undefined
  }
  return fields[name]
}

function isRedisFieldArray(fields: readonly string[] | Record<string, string>): fields is readonly string[] {
  return Array.isArray(fields)
}

function normalizeRedisStreamId(id: string): string {
  return /^\d+-\d+$/.test(id) ? id : '*'
}

function encodeRedisKeyPart(value: string): string {
  return encodeURIComponent(value)
}
