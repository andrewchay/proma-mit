import type {
  AskUserRequest,
  AskUserResponse,
  PermissionRequest,
  PermissionResponse,
} from '../types/agent'
import type { AgentRuntimeScope } from './agent-runtime-server'

export type AgentRuntimeInteractionKind = 'permission' | 'ask_user'
export type AgentRuntimeInteractionStatus = 'pending' | 'resolved' | 'cancelled' | 'expired'
export type AgentRuntimeInteractionRequest = PermissionRequest | AskUserRequest
export type AgentRuntimeInteractionResponse = PermissionResponse | AskUserResponse

export interface AgentRuntimeInteractionRecord extends AgentRuntimeScope {
  requestId: string
  sessionId: string
  taskId?: string
  kind: AgentRuntimeInteractionKind
  status: AgentRuntimeInteractionStatus
  request: AgentRuntimeInteractionRequest
  response?: AgentRuntimeInteractionResponse
  createdAt: number
  expiresAt?: number
  resolvedAt?: number
}

export interface CreateAgentRuntimeInteractionInput extends AgentRuntimeScope {
  taskId?: string
  kind: AgentRuntimeInteractionKind
  request: AgentRuntimeInteractionRequest
  createdAt?: number
  expiresAt?: number
}

export interface ListAgentRuntimeInteractionsInput extends AgentRuntimeScope {
  sessionId?: string
  taskId?: string
  kind?: AgentRuntimeInteractionKind
  status?: AgentRuntimeInteractionStatus
  now?: number
}

export interface AgentRuntimeInteractionStore {
  createInteraction(input: CreateAgentRuntimeInteractionInput): Promise<AgentRuntimeInteractionRecord>
  getInteraction(scope: AgentRuntimeScope, requestId: string): Promise<AgentRuntimeInteractionRecord | undefined>
  listInteractions(input: ListAgentRuntimeInteractionsInput): Promise<AgentRuntimeInteractionRecord[]>
  resolveInteraction(
    scope: AgentRuntimeScope,
    requestId: string,
    response: AgentRuntimeInteractionResponse,
  ): Promise<AgentRuntimeInteractionRecord | undefined>
  cancelInteraction(scope: AgentRuntimeScope, requestId: string): Promise<AgentRuntimeInteractionRecord | undefined>
  expireInteractions(scope: AgentRuntimeScope, now: number): Promise<AgentRuntimeInteractionRecord[]>
}

export class InMemoryAgentRuntimeInteractionStore implements AgentRuntimeInteractionStore {
  private readonly records = new Map<string, AgentRuntimeInteractionRecord>()

  async createInteraction(input: CreateAgentRuntimeInteractionInput): Promise<AgentRuntimeInteractionRecord> {
    const record: AgentRuntimeInteractionRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      requestId: input.request.requestId,
      sessionId: input.request.sessionId,
      taskId: input.taskId,
      kind: input.kind,
      status: 'pending',
      request: cloneInteractionValue(input.request),
      createdAt: input.createdAt ?? Date.now(),
      expiresAt: input.expiresAt,
    }
    this.records.set(scopedInteractionKey(record, record.requestId), cloneInteractionValue(record))
    return cloneInteractionValue(record)
  }

  async getInteraction(scope: AgentRuntimeScope, requestId: string): Promise<AgentRuntimeInteractionRecord | undefined> {
    const record = this.records.get(scopedInteractionKey(scope, requestId))
    return record ? cloneInteractionValue(record) : undefined
  }

  async listInteractions(input: ListAgentRuntimeInteractionsInput): Promise<AgentRuntimeInteractionRecord[]> {
    const now = input.now
    return [...this.records.values()]
      .filter((record) => record.tenantId === input.tenantId && record.userId === input.userId)
      .map((record) => refreshExpiredStatus(record, now))
      .filter((record) => input.sessionId == null || record.sessionId === input.sessionId)
      .filter((record) => input.taskId == null || record.taskId === input.taskId)
      .filter((record) => input.kind == null || record.kind === input.kind)
      .filter((record) => input.status == null || record.status === input.status)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(cloneInteractionValue)
  }

  async resolveInteraction(
    scope: AgentRuntimeScope,
    requestId: string,
    response: AgentRuntimeInteractionResponse,
  ): Promise<AgentRuntimeInteractionRecord | undefined> {
    const record = this.records.get(scopedInteractionKey(scope, requestId))
    if (!record || record.status !== 'pending') return undefined
    const resolved: AgentRuntimeInteractionRecord = {
      ...record,
      status: 'resolved',
      response: cloneInteractionValue(response),
      resolvedAt: Date.now(),
    }
    this.records.set(scopedInteractionKey(scope, requestId), cloneInteractionValue(resolved))
    return cloneInteractionValue(resolved)
  }

  async cancelInteraction(scope: AgentRuntimeScope, requestId: string): Promise<AgentRuntimeInteractionRecord | undefined> {
    const record = this.records.get(scopedInteractionKey(scope, requestId))
    if (!record || record.status !== 'pending') return undefined
    const cancelled: AgentRuntimeInteractionRecord = {
      ...record,
      status: 'cancelled',
      resolvedAt: Date.now(),
    }
    this.records.set(scopedInteractionKey(scope, requestId), cloneInteractionValue(cancelled))
    return cloneInteractionValue(cancelled)
  }

  async expireInteractions(scope: AgentRuntimeScope, now: number): Promise<AgentRuntimeInteractionRecord[]> {
    const expired: AgentRuntimeInteractionRecord[] = []
    for (const record of this.records.values()) {
      if (
        record.tenantId !== scope.tenantId ||
        record.userId !== scope.userId ||
        record.status !== 'pending' ||
        record.expiresAt == null ||
        record.expiresAt > now
      ) {
        continue
      }
      const next: AgentRuntimeInteractionRecord = {
        ...record,
        status: 'expired',
        resolvedAt: now,
      }
      this.records.set(scopedInteractionKey(next, next.requestId), cloneInteractionValue(next))
      expired.push(cloneInteractionValue(next))
    }
    return expired
  }
}

function refreshExpiredStatus(record: AgentRuntimeInteractionRecord, now: number | undefined): AgentRuntimeInteractionRecord {
  if (now == null || record.status !== 'pending' || record.expiresAt == null || record.expiresAt > now) {
    return cloneInteractionValue(record)
  }
  return {
    ...cloneInteractionValue(record),
    status: 'expired',
    resolvedAt: now,
  }
}

function scopedInteractionKey(scope: AgentRuntimeScope, requestId: string): string {
  return JSON.stringify([scope.tenantId, scope.userId, requestId])
}

function cloneInteractionValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
