import type {
  McpServerEntry,
  AgentRuntime,
  SDKMessage,
} from '../types/agent'
import type { ProviderType } from '../types/channel'
import type { AgentRuntimeScope, AgentRuntimeTaskMeta } from './agent-runtime-server'

export type MaybePromise<T> = T | Promise<T>

export type TenantRuntimeSecretEncoding = 'plain' | 'encoded'

export interface TenantRuntimeCredential extends AgentRuntimeScope {
  channelId: string
  provider: ProviderType
  apiKey: string
  apiKeyEncoding?: TenantRuntimeSecretEncoding
  baseUrl: string
  defaultModel?: string
}

export interface TenantRuntimeWorkspace extends AgentRuntimeScope {
  workspaceSlug: string
  cwd: string
  mcpServers: Record<string, McpServerEntry>
}

export interface TenantMcpOAuthTokens {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  raw?: unknown
}

export interface TenantMcpClientSecret extends AgentRuntimeScope {
  workspaceSlug: string
  serverName: string
  clientSecret: string
}

export interface TenantRuntimeSession extends AgentRuntimeScope {
  sessionId: string
  workspaceSlug: string
  channelId: string
  modelId: string
  runtime: AgentRuntime
  title?: string
  createdAt: number
  updatedAt: number
}

export interface TenantRuntimeStore {
  setCredential(credential: TenantRuntimeCredential): MaybePromise<void>
  getCredential(scope: AgentRuntimeScope, channelId: string): MaybePromise<TenantRuntimeCredential | undefined>
  setWorkspace(workspace: TenantRuntimeWorkspace): MaybePromise<void>
  getWorkspace(scope: AgentRuntimeScope, workspaceSlug: string): MaybePromise<TenantRuntimeWorkspace | undefined>
  createSession(session: TenantRuntimeSession): MaybePromise<TenantRuntimeSession>
  getSession(scope: AgentRuntimeScope, sessionId: string): MaybePromise<TenantRuntimeSession | undefined>
  updateSession(session: TenantRuntimeSession): MaybePromise<TenantRuntimeSession>
  deleteSession(scope: AgentRuntimeScope, sessionId: string): MaybePromise<boolean>
  appendSessionMessages(scope: AgentRuntimeScope, sessionId: string, messages: SDKMessage[]): MaybePromise<void>
  getSessionMessages(scope: AgentRuntimeScope, sessionId: string): MaybePromise<SDKMessage[]>
  truncateSessionMessages(scope: AgentRuntimeScope, sessionId: string, upToUuidInclusive: string): MaybePromise<SDKMessage[]>
  setTask(task: AgentRuntimeTaskMeta): MaybePromise<void>
  getTask(scope: AgentRuntimeScope, taskId: string): MaybePromise<AgentRuntimeTaskMeta | undefined>
  setMcpOAuthTokens(scope: AgentRuntimeScope, workspaceSlug: string, serverName: string, tokens: TenantMcpOAuthTokens): MaybePromise<void>
  getMcpOAuthTokens(scope: AgentRuntimeScope, workspaceSlug: string, serverName: string): MaybePromise<TenantMcpOAuthTokens | undefined>
  setMcpClientSecret(secret: TenantMcpClientSecret): MaybePromise<void>
  getMcpClientSecret(scope: AgentRuntimeScope, workspaceSlug: string, serverName: string): MaybePromise<string | undefined>
}

export class InMemoryTenantRuntimeStore implements TenantRuntimeStore {
  private readonly credentials = new Map<string, TenantRuntimeCredential>()
  private readonly workspaces = new Map<string, TenantRuntimeWorkspace>()
  private readonly sessions = new Map<string, TenantRuntimeSession>()
  private readonly messages = new Map<string, SDKMessage[]>()
  private readonly tasks = new Map<string, AgentRuntimeTaskMeta>()
  private readonly mcpTokens = new Map<string, TenantMcpOAuthTokens>()
  private readonly mcpClientSecrets = new Map<string, string>()

  setCredential(credential: TenantRuntimeCredential): void {
    this.credentials.set(scopedKey(credential, credential.channelId), { ...credential })
  }

  getCredential(scope: AgentRuntimeScope, channelId: string): TenantRuntimeCredential | undefined {
    const credential = this.credentials.get(scopedKey(scope, channelId))
    return credential ? { ...credential } : undefined
  }

  setWorkspace(workspace: TenantRuntimeWorkspace): void {
    this.workspaces.set(scopedKey(workspace, workspace.workspaceSlug), {
      ...workspace,
      mcpServers: cloneRuntimeValue(workspace.mcpServers),
    })
  }

  getWorkspace(scope: AgentRuntimeScope, workspaceSlug: string): TenantRuntimeWorkspace | undefined {
    const workspace = this.workspaces.get(scopedKey(scope, workspaceSlug))
    return workspace
      ? { ...workspace, mcpServers: cloneRuntimeValue(workspace.mcpServers) }
      : undefined
  }

  createSession(session: TenantRuntimeSession): TenantRuntimeSession {
    const stored = cloneRuntimeValue(session)
    this.sessions.set(scopedKey(session, session.sessionId), stored)
    return cloneRuntimeValue(stored)
  }

  getSession(scope: AgentRuntimeScope, sessionId: string): TenantRuntimeSession | undefined {
    const session = this.sessions.get(scopedKey(scope, sessionId))
    return session ? cloneRuntimeValue(session) : undefined
  }

  updateSession(session: TenantRuntimeSession): TenantRuntimeSession {
    const stored = cloneRuntimeValue(session)
    this.sessions.set(scopedKey(session, session.sessionId), stored)
    return cloneRuntimeValue(stored)
  }

  deleteSession(scope: AgentRuntimeScope, sessionId: string): boolean {
    const key = scopedKey(scope, sessionId)
    const existed = this.sessions.delete(key)
    this.messages.delete(key)
    return existed
  }

  appendSessionMessages(scope: AgentRuntimeScope, sessionId: string, messages: SDKMessage[]): void {
    const key = scopedKey(scope, sessionId)
    const existing = this.messages.get(key) ?? []
    this.messages.set(key, [...existing, ...cloneRuntimeValue(messages)])
  }

  getSessionMessages(scope: AgentRuntimeScope, sessionId: string): SDKMessage[] {
    return cloneRuntimeValue(this.messages.get(scopedKey(scope, sessionId)) ?? [])
  }

  truncateSessionMessages(scope: AgentRuntimeScope, sessionId: string, upToUuidInclusive: string): SDKMessage[] {
    const key = scopedKey(scope, sessionId)
    const existing = this.messages.get(key) ?? []
    const idx = existing.findIndex((message) => getSDKMessageUuid(message) === upToUuidInclusive)
    const kept = idx >= 0 ? existing.slice(0, idx + 1) : existing
    this.messages.set(key, kept)
    return cloneRuntimeValue(kept)
  }

  setTask(task: AgentRuntimeTaskMeta): void {
    this.tasks.set(scopedKey(task, task.taskId), cloneRuntimeValue(task))
  }

  getTask(scope: AgentRuntimeScope, taskId: string): AgentRuntimeTaskMeta | undefined {
    const task = this.tasks.get(scopedKey(scope, taskId))
    return task ? cloneRuntimeValue(task) : undefined
  }

  setMcpOAuthTokens(scope: AgentRuntimeScope, workspaceSlug: string, serverName: string, tokens: TenantMcpOAuthTokens): void {
    this.mcpTokens.set(scopedKey(scope, scopedStoreId(workspaceSlug, serverName)), cloneRuntimeValue(tokens))
  }

  getMcpOAuthTokens(scope: AgentRuntimeScope, workspaceSlug: string, serverName: string): TenantMcpOAuthTokens | undefined {
    const tokens = this.mcpTokens.get(scopedKey(scope, scopedStoreId(workspaceSlug, serverName)))
    return tokens ? cloneRuntimeValue(tokens) : undefined
  }

  setMcpClientSecret(secret: TenantMcpClientSecret): void {
    this.mcpClientSecrets.set(scopedKey(secret, scopedStoreId(secret.workspaceSlug, secret.serverName)), secret.clientSecret)
  }

  getMcpClientSecret(scope: AgentRuntimeScope, workspaceSlug: string, serverName: string): string | undefined {
    return this.mcpClientSecrets.get(scopedKey(scope, scopedStoreId(workspaceSlug, serverName)))
  }
}

export interface ServerMcpOAuthPending extends AgentRuntimeScope {
  workspaceSlug: string
  serverName: string
  state: string
  finishAuth: (code: string) => Promise<TenantMcpOAuthTokens | void>
  createdAt?: number
}

export interface RegisterServerMcpOAuthInput extends Omit<ServerMcpOAuthPending, 'state' | 'createdAt'> {
  callbackBaseUrl: string
  state?: string
}

export interface RegisteredServerMcpOAuth {
  authorizationState: string
  callbackUrl: string
}

export interface HandleServerMcpOAuthCallbackResult {
  ok: boolean
  tenantId?: string
  userId?: string
  workspaceSlug?: string
  serverName?: string
  error?: string
}

export class ServerMcpOAuthCallbackHandler {
  private readonly pendingByState = new Map<string, ServerMcpOAuthPending>()

  constructor(private readonly store: TenantRuntimeStore) {}

  registerPending(input: RegisterServerMcpOAuthInput): RegisteredServerMcpOAuth {
    const state = input.state ?? createOAuthState()
    const pending: ServerMcpOAuthPending = {
      tenantId: input.tenantId,
      userId: input.userId,
      workspaceSlug: input.workspaceSlug,
      serverName: input.serverName,
      finishAuth: input.finishAuth,
      state,
      createdAt: Date.now(),
    }
    this.pendingByState.set(state, pending)
    const callbackUrl = new URL(input.callbackBaseUrl)
    callbackUrl.searchParams.set('tenant', input.tenantId)
    callbackUrl.searchParams.set('user', input.userId)
    callbackUrl.searchParams.set('workspace', input.workspaceSlug)
    callbackUrl.searchParams.set('server', input.serverName)
    callbackUrl.searchParams.set('state', state)
    return {
      authorizationState: state,
      callbackUrl: callbackUrl.toString(),
    }
  }

  async handleCallbackUrl(rawUrl: string): Promise<HandleServerMcpOAuthCallbackResult> {
    const url = new URL(rawUrl)
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code') ?? ''
    if (!state || !code) {
      return { ok: false, error: 'OAuth callback 缺少 state 或 code' }
    }
    const pending = this.pendingByState.get(state)
    if (!pending) {
      return { ok: false, error: 'OAuth state 不存在或已处理' }
    }
    const tenantId = url.searchParams.get('tenant') ?? ''
    const userId = url.searchParams.get('user') ?? ''
    const workspaceSlug = url.searchParams.get('workspace') ?? ''
    const serverName = url.searchParams.get('server') ?? ''
    if (
      pending.tenantId !== tenantId ||
      pending.userId !== userId ||
      pending.workspaceSlug !== workspaceSlug ||
      pending.serverName !== serverName
    ) {
      return { ok: false, error: 'OAuth callback scope 与 pending 会话不匹配' }
    }

    this.pendingByState.delete(state)
    const tokens = await pending.finishAuth(code)
    if (tokens) {
      await this.store.setMcpOAuthTokens(pending, pending.workspaceSlug, pending.serverName, tokens)
    }
    return {
      ok: true,
      tenantId,
      userId,
      workspaceSlug,
      serverName,
    }
  }
}

function scopedKey(scope: AgentRuntimeScope, id: string): string {
  return JSON.stringify([scope.tenantId, scope.userId, id])
}

function scopedStoreId(first: string, second: string): string {
  return JSON.stringify([first, second])
}

function getSDKMessageUuid(message: SDKMessage): string | undefined {
  const value = (message as { uuid?: unknown }).uuid
  return typeof value === 'string' ? value : undefined
}

function cloneRuntimeValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value)
  }
  return JSON.parse(JSON.stringify(value)) as T
}

function createOAuthState(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (randomUUID) return randomUUID.call(globalThis.crypto)
  return `oauth-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
