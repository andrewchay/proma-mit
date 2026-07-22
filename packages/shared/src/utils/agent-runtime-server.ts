import type {
  AgentStreamEnvelope,
  AgentStreamPayload,
} from '../types/agent'
import {
  createAgentStreamEnvelope,
  serializeAgentStreamEnvelopeForSSE,
} from '../types/agent'

export interface AgentRuntimeScope {
  tenantId: string
  userId: string
  roles?: AgentRuntimeRole[]
}

export type AgentRuntimeRole = 'viewer' | 'operator' | 'admin' | 'security-auditor'

export interface ScopedAgentSession extends AgentRuntimeScope {
  sessionId: string
}

export interface AgentRuntimeEventRecord extends AgentStreamEnvelope {
  tenantId: string
  userId: string
}

export type AgentRuntimeMaybePromise<T> = T | Promise<T>

export interface AgentRuntimeDurableEventStore {
  append(event: AgentRuntimeEventRecord): AgentRuntimeMaybePromise<void>
  replay(input: AgentRuntimeEventReplayInput): AgentRuntimeMaybePromise<AgentRuntimeEventRecord[]>
}

export interface AgentRuntimeEventHubOptions {
  maxEventsPerSession?: number
  durableStore?: AgentRuntimeDurableEventStore
  onDurableWriteError?: (error: unknown, event: AgentRuntimeEventRecord) => void
}

export interface AgentRuntimeEventEmitInput extends ScopedAgentSession {
  payload: AgentStreamPayload
  createdAt?: number
}

export interface AgentRuntimeEventReplayInput extends ScopedAgentSession {
  afterId?: string
}

export interface AgentRuntimeEventSubscribeInput extends AgentRuntimeEventReplayInput {
  onEvent: (event: AgentRuntimeEventRecord) => void
}

interface SessionEventState {
  nextSeq: number
  events: AgentRuntimeEventRecord[]
  subscribers: Set<(event: AgentRuntimeEventRecord) => void>
}

export class AgentRuntimeEventReplayHub {
  private readonly maxEventsPerSession: number
  private readonly durableStore?: AgentRuntimeDurableEventStore
  private readonly onDurableWriteError?: (error: unknown, event: AgentRuntimeEventRecord) => void
  private readonly sessions = new Map<string, SessionEventState>()
  private readonly durableWrites = new Set<Promise<void>>()

  constructor(options: AgentRuntimeEventHubOptions = {}) {
    this.maxEventsPerSession = options.maxEventsPerSession ?? 500
    this.durableStore = options.durableStore
    this.onDurableWriteError = options.onDurableWriteError
  }

  emit(input: AgentRuntimeEventEmitInput): AgentRuntimeEventRecord {
    const state = this.getSessionState(input)
    const id = `${Date.now()}-${state.nextSeq++}`
    const envelope = createAgentStreamEnvelope(input.sessionId, input.payload, {
      id,
      createdAt: input.createdAt,
    })
    const record: AgentRuntimeEventRecord = {
      ...envelope,
      tenantId: input.tenantId,
      userId: input.userId,
    }
    state.events.push(record)
    if (state.events.length > this.maxEventsPerSession) {
      state.events.splice(0, state.events.length - this.maxEventsPerSession)
    }
    this.persistDurable(record)
    for (const subscriber of state.subscribers) {
      subscriber(record)
    }
    return record
  }

  replay(input: AgentRuntimeEventReplayInput): AgentRuntimeEventRecord[] {
    const state = this.getSessionState(input)
    if (!input.afterId) {
      return [...state.events]
    }
    const idx = state.events.findIndex((event) => event.id === input.afterId)
    if (idx < 0) {
      return [...state.events]
    }
    return state.events.slice(idx + 1)
  }

  subscribe(input: AgentRuntimeEventSubscribeInput): () => void {
    const state = this.getSessionState(input)
    for (const event of this.replay(input)) {
      input.onEvent(event)
    }
    state.subscribers.add(input.onEvent)
    return () => {
      state.subscribers.delete(input.onEvent)
    }
  }

  /** 在已完成 durable replay 后仅接收后续事件，避免重放与内存事件重复。 */
  subscribeLive(input: Omit<AgentRuntimeEventSubscribeInput, 'afterId'>): () => void {
    const state = this.getSessionState(input)
    state.subscribers.add(input.onEvent)
    return () => {
      state.subscribers.delete(input.onEvent)
    }
  }

  serializeReplayForSSE(input: AgentRuntimeEventReplayInput): string {
    return this.replay(input)
      .map((event) => serializeAgentStreamEnvelopeForSSE(event))
      .join('')
  }

  async replayDurable(input: AgentRuntimeEventReplayInput): Promise<AgentRuntimeEventRecord[]> {
    if (!this.durableStore) {
      return this.replay(input)
    }
    await this.flushDurableWrites()
    return this.durableStore.replay(input)
  }

  async serializeDurableReplayForSSE(input: AgentRuntimeEventReplayInput): Promise<string> {
    const events = await this.replayDurable(input)
    return events.map((event) => serializeAgentStreamEnvelopeForSSE(event)).join('')
  }

  serializeReplayForWebSocket(input: AgentRuntimeEventReplayInput): string[] {
    return this.replay(input).map((event) => JSON.stringify(event))
  }

  async serializeDurableReplayForWebSocket(input: AgentRuntimeEventReplayInput): Promise<string[]> {
    return (await this.replayDurable(input)).map((event) => JSON.stringify(event))
  }

  async flushDurableWrites(): Promise<void> {
    await Promise.all([...this.durableWrites])
  }

  private getSessionState(input: Pick<ScopedAgentSession, 'tenantId' | 'userId' | 'sessionId'>): SessionEventState {
    const key = makeScopedSessionKey(input)
    const existing = this.sessions.get(key)
    if (existing) return existing
    const created: SessionEventState = {
      nextSeq: 1,
      events: [],
      subscribers: new Set(),
    }
    this.sessions.set(key, created)
    return created
  }

  private persistDurable(record: AgentRuntimeEventRecord): void {
    if (!this.durableStore) return
    const write = Promise.resolve(this.durableStore.append(record))
      .catch((error) => {
        this.onDurableWriteError?.(error, record)
      })
      .finally(() => {
        this.durableWrites.delete(write)
      })
    this.durableWrites.add(write)
  }
}

export type AgentRuntimeTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface AgentRuntimeTaskMeta extends ScopedAgentSession {
  taskId: string
  parentTaskId?: string
  /** 根任务为 0；子任务在创建时从父任务推导。 */
  depth: number
  status: AgentRuntimeTaskStatus
  startedAt: number
  completedAt?: number
  error?: string
}

export interface AgentRuntimeTaskContext extends ScopedAgentSession {
  taskId: string
  signal: AbortSignal
  emit: (payload: AgentStreamPayload) => AgentRuntimeEventRecord
}

export interface StartAgentRuntimeTaskInput extends ScopedAgentSession {
  taskId?: string
  parentTaskId?: string
  depth?: number
  run: (context: AgentRuntimeTaskContext) => Promise<void>
}

export class AgentRuntimeTaskRunner {
  private readonly tasks = new Map<string, AgentRuntimeTaskMeta>()
  private readonly activeBySession = new Map<string, string>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly completions = new Map<string, Promise<AgentRuntimeTaskMeta>>()
  private readonly childrenByParent = new Map<string, Set<string>>()

  constructor(private readonly eventHub: AgentRuntimeEventReplayHub = new AgentRuntimeEventReplayHub()) {}

  startTask(input: StartAgentRuntimeTaskInput): AgentRuntimeTaskMeta {
    const sessionKey = makeScopedSessionKey(input)
    const existingTaskId = this.activeBySession.get(sessionKey)
    if (existingTaskId) {
      throw new Error(`会话已有运行中的任务: ${input.sessionId}`)
    }

    const taskId = input.taskId ?? createRuntimeTaskId()
    const controller = new AbortController()
    const parentDepth = input.parentTaskId ? this.tasks.get(input.parentTaskId)?.depth : undefined
    const meta: AgentRuntimeTaskMeta = {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      taskId,
      parentTaskId: input.parentTaskId,
      depth: parentDepth == null ? (input.depth ?? 0) : parentDepth + 1,
      status: 'running',
      startedAt: Date.now(),
    }
    this.tasks.set(taskId, meta)
    this.controllers.set(taskId, controller)
    if (input.parentTaskId) {
      const children = this.childrenByParent.get(input.parentTaskId) ?? new Set<string>()
      children.add(taskId)
      this.childrenByParent.set(input.parentTaskId, children)
    }
    this.activeBySession.set(sessionKey, taskId)

    const completion = this.runTask(input, meta, controller, sessionKey)
    this.completions.set(taskId, completion)
    return { ...meta }
  }

  cancelTask(taskId: string): boolean {
    for (const childTaskId of this.childrenByParent.get(taskId) ?? []) this.cancelTask(childTaskId)
    const controller = this.controllers.get(taskId)
    if (!controller) return false
    controller.abort()
    return true
  }

  cancelAllTasks(): string[] {
    const taskIds = [...this.controllers.keys()]
    for (const taskId of taskIds) this.cancelTask(taskId)
    return taskIds
  }

  getTask(taskId: string): AgentRuntimeTaskMeta | undefined {
    const meta = this.tasks.get(taskId)
    return meta ? { ...meta } : undefined
  }

  async waitForTask(taskId: string): Promise<AgentRuntimeTaskMeta> {
    const completion = this.completions.get(taskId)
    if (completion) return completion
    const meta = this.getTask(taskId)
    if (!meta) throw new Error(`任务不存在: ${taskId}`)
    return meta
  }

  replayEvents(input: AgentRuntimeEventReplayInput): AgentRuntimeEventRecord[] {
    return this.eventHub.replay(input)
  }

  subscribeEvents(input: AgentRuntimeEventSubscribeInput): () => void {
    return this.eventHub.subscribe(input)
  }

  subscribeLiveEvents(input: Omit<AgentRuntimeEventSubscribeInput, 'afterId'>): () => void {
    return this.eventHub.subscribeLive(input)
  }

  serializeReplayForSSE(input: AgentRuntimeEventReplayInput): string {
    return this.eventHub.serializeReplayForSSE(input)
  }

  async serializeDurableReplayForSSE(input: AgentRuntimeEventReplayInput): Promise<string> {
    return this.eventHub.serializeDurableReplayForSSE(input)
  }

  async flushDurableEventWrites(): Promise<void> {
    return this.eventHub.flushDurableWrites()
  }

  private async runTask(
    input: StartAgentRuntimeTaskInput,
    meta: AgentRuntimeTaskMeta,
    controller: AbortController,
    sessionKey: string,
  ): Promise<AgentRuntimeTaskMeta> {
    try {
      await input.run({
        tenantId: input.tenantId,
        userId: input.userId,
        sessionId: input.sessionId,
        taskId: meta.taskId,
        signal: controller.signal,
        emit: (payload) => this.eventHub.emit({ ...input, payload }),
      })
      meta.status = controller.signal.aborted ? 'cancelled' : 'completed'
    } catch (error) {
      meta.status = controller.signal.aborted ? 'cancelled' : 'failed'
      meta.error = getServerRuntimeErrorMessage(error)
    } finally {
      meta.completedAt = Date.now()
      this.activeBySession.delete(sessionKey)
      this.controllers.delete(meta.taskId)
      if (meta.parentTaskId) {
        const siblings = this.childrenByParent.get(meta.parentTaskId)
        siblings?.delete(meta.taskId)
        if (siblings?.size === 0) this.childrenByParent.delete(meta.parentTaskId)
      }
      this.childrenByParent.delete(meta.taskId)
    }
    return { ...meta }
  }
}

function makeScopedSessionKey(input: Pick<ScopedAgentSession, 'tenantId' | 'userId' | 'sessionId'>): string {
  return JSON.stringify([input.tenantId, input.userId, input.sessionId])
}

function createRuntimeTaskId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (randomUUID) return randomUUID.call(globalThis.crypto)
  return `task-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getServerRuntimeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error) || '未知错误'
}
