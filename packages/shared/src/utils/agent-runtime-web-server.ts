import type {
  PromaPermissionMode,
  SDKMessage,
  SDKUserMessage,
} from '../types/agent'
import { PROMA_DEFAULT_PERMISSION_MODE, serializeAgentStreamEnvelopeForSSE } from '../types/agent'
import type { AgentProviderProtocol, ProviderType } from '../types/channel'
import type {
  AgentRuntimeInteractionKind,
  AgentRuntimeInteractionResponse,
  AgentRuntimeInteractionStatus,
  AgentRuntimeInteractionStore,
} from './agent-runtime-interaction-store'
import { InMemoryAgentRuntimeInteractionStore } from './agent-runtime-interaction-store'
import type {
  AgentRuntimeScope,
  AgentRuntimeTaskContext,
  AgentRuntimeTaskMeta,
} from './agent-runtime-server'
import {
  AgentRuntimeEventReplayHub,
  AgentRuntimeTaskRunner,
} from './agent-runtime-server'
import type {
  TenantRuntimeCredential,
  TenantRuntimeSession,
  TenantRuntimeStore,
  TenantRuntimeWorkspace,
} from './agent-runtime-tenant-store'
import {
  InMemoryTenantRuntimeStore,
  ServerMcpOAuthCallbackHandler,
} from './agent-runtime-tenant-store'

export interface AgentRuntimeWebAuthResolverInput {
  request: Request
  url: URL
}

export type AgentRuntimeWebAuthResolver = (
  input: AgentRuntimeWebAuthResolverInput,
) => AgentRuntimeScope | undefined | Promise<AgentRuntimeScope | undefined>

export interface AgentRuntimeWebSecretContext extends AgentRuntimeScope {
  purpose: 'provider_api_key' | 'mcp_oauth_token' | 'mcp_client_secret'
  resourceId: string
}

export interface AgentRuntimeWebSecretCodec {
  encode(plain: string, context: AgentRuntimeWebSecretContext): string | Promise<string>
  decode(encoded: string, context: AgentRuntimeWebSecretContext): string | Promise<string>
}

export interface AgentRuntimeWebAgentTurnInput {
  scope: AgentRuntimeScope
  session: TenantRuntimeSession
  taskId: string
  credential: TenantRuntimeCredential
  workspace: TenantRuntimeWorkspace
  prompt: string
  modelId: string
  provider: ProviderType
  protocol?: AgentProviderProtocol
  permissionMode: PromaPermissionMode
  historyMessages: SDKMessage[]
  signal: AbortSignal
  emit: AgentRuntimeTaskContext['emit']
  interactionStore?: AgentRuntimeInteractionStore
}

export type AgentRuntimeWebAgentTurnRunner = (
  input: AgentRuntimeWebAgentTurnInput,
) => Promise<SDKMessage[]>

export interface AgentRuntimeWebTaskPreflightInput {
  scope: AgentRuntimeScope
  session: TenantRuntimeSession
  credential: TenantRuntimeCredential
  modelId: string
}

export type AgentRuntimeWebTaskPreflight = (input: AgentRuntimeWebTaskPreflightInput) => Promise<void>

export interface CreateAgentRuntimeWebServerOptions {
  store?: TenantRuntimeStore
  eventHub?: AgentRuntimeEventReplayHub
  taskRunner?: AgentRuntimeTaskRunner
  auth?: AgentRuntimeWebAuthResolver
  secretCodec?: AgentRuntimeWebSecretCodec
  interactionStore?: AgentRuntimeInteractionStore
  runAgentTurn: AgentRuntimeWebAgentTurnRunner
  beforeStartTask?: AgentRuntimeWebTaskPreflight
  oauthHandler?: ServerMcpOAuthCallbackHandler
  defaultRuntime?: TenantRuntimeSession['runtime']
  defaultPermissionMode?: PromaPermissionMode
}

export interface AgentRuntimeWebServer {
  store: TenantRuntimeStore
  eventHub: AgentRuntimeEventReplayHub
  taskRunner: AgentRuntimeTaskRunner
  oauthHandler: ServerMcpOAuthCallbackHandler
  interactionStore: AgentRuntimeInteractionStore
  handleRequest(request: Request): Promise<Response>
}

interface CreateSessionBody {
  sessionId?: string
  workspaceSlug?: string
  channelId?: string
  modelId?: string
  title?: string
}

interface RunSessionBody {
  prompt?: string
  channelId?: string
  modelId?: string
  protocol?: AgentProviderProtocol
  permissionMode?: PromaPermissionMode
}

interface UpdateSessionBody {
  title?: string
  modelId?: string
  channelId?: string
}

interface RespondInteractionBody {
  response?: AgentRuntimeInteractionResponse
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
}

export function createAgentRuntimeWebServer(options: CreateAgentRuntimeWebServerOptions): AgentRuntimeWebServer {
  const store = options.store ?? new InMemoryTenantRuntimeStore()
  const eventHub = options.eventHub ?? new AgentRuntimeEventReplayHub()
  const taskRunner = options.taskRunner ?? new AgentRuntimeTaskRunner(eventHub)
  const oauthHandler = options.oauthHandler ?? new ServerMcpOAuthCallbackHandler(store)
  const interactionStore = options.interactionStore ?? new InMemoryAgentRuntimeInteractionStore()
  const auth = options.auth ?? headerAuthResolver
  const secretCodec = options.secretCodec ?? createPlainAgentRuntimeWebSecretCodec()

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/mcp/oauth/callback') {
      return handleOAuthCallback(oauthHandler, url)
    }

    const scope = await auth({ request, url })
    if (!scope) {
      return jsonResponse({ error: '未认证或缺少租户上下文' }, 401)
    }

    const route = matchAgentRoute(request.method, url.pathname)
    if (!route) {
      return jsonResponse({ error: '接口不存在' }, 404)
    }

    try {
      if (route.name === 'createSession') {
        return await handleCreateSession(request, scope, store, options)
      }
      if (route.name === 'runSession') {
        return await handleRunSession(request, scope, route.sessionId, {
          store,
          taskRunner,
          interactionStore,
          secretCodec,
          runAgentTurn: options.runAgentTurn,
          beforeStartTask: options.beforeStartTask,
          defaultPermissionMode: options.defaultPermissionMode ?? PROMA_DEFAULT_PERMISSION_MODE,
        })
      }
      if (route.name === 'updateSession') {
        return handleUpdateSession(request, scope, route.sessionId, store)
      }
      if (route.name === 'deleteSession') {
        return handleDeleteSession(scope, route.sessionId, store)
      }
      if (route.name === 'sessionEvents') {
        return handleSessionEvents(request, url, scope, route.sessionId, store, taskRunner)
      }
      if (route.name === 'sessionMessages') {
        return handleSessionMessages(scope, route.sessionId, store)
      }
      if (route.name === 'cancelTask') {
        return handleCancelTask(scope, route.taskId, store, taskRunner, interactionStore)
      }
      if (route.name === 'listInteractions') {
        return handleListInteractions(url, scope, interactionStore)
      }
      if (route.name === 'respondInteraction') {
        return handleRespondInteraction(request, scope, route.requestId, interactionStore)
      }
      if (route.name === 'cancelInteraction') {
        return handleCancelInteraction(scope, route.requestId, interactionStore)
      }
      return jsonResponse({ error: '未处理的接口' }, 500)
    } catch (error) {
      return jsonResponse({ error: getRuntimeWebErrorMessage(error) }, 400)
    }
  }

  return {
    store,
    eventHub,
    taskRunner,
    oauthHandler,
    interactionStore,
    handleRequest,
  }
}

async function handleDeleteSession(scope: AgentRuntimeScope, sessionId: string, store: TenantRuntimeStore): Promise<Response> {
  const deleted = await store.deleteSession(scope, sessionId)
  return deleted ? new Response(null, { status: 204 }) : jsonResponse({ error: '会话不存在或不可访问' }, 404)
}

async function handleUpdateSession(
  request: Request,
  scope: AgentRuntimeScope,
  sessionId: string,
  store: TenantRuntimeStore,
): Promise<Response> {
  const existing = await store.getSession(scope, sessionId)
  if (!existing) return jsonResponse({ error: '会话不存在或不可访问' }, 404)
  const body = await readJsonBody<UpdateSessionBody>(request)
  if (body.title != null && (typeof body.title !== 'string' || body.title.trim().length === 0)) {
    return jsonResponse({ error: 'title 必须是非空字符串' }, 400)
  }
  if (body.modelId != null && (typeof body.modelId !== 'string' || body.modelId.trim().length === 0)) {
    return jsonResponse({ error: 'modelId 必须是非空字符串' }, 400)
  }
  if (body.channelId != null && (typeof body.channelId !== 'string' || body.channelId.trim().length === 0)) {
    return jsonResponse({ error: 'channelId 必须是非空字符串' }, 400)
  }
  return jsonResponse({ session: await store.updateSession({
    ...existing,
    title: body.title ?? existing.title,
    modelId: body.modelId ?? existing.modelId,
    channelId: body.channelId ?? existing.channelId,
    updatedAt: Date.now(),
  }) })
}

async function handleCreateSession(
  request: Request,
  scope: AgentRuntimeScope,
  store: TenantRuntimeStore,
  options: CreateAgentRuntimeWebServerOptions,
): Promise<Response> {
  const body = await readJsonBody<CreateSessionBody>(request)
  const workspaceSlug = requireString(body.workspaceSlug, 'workspaceSlug')
  const channelId = requireString(body.channelId, 'channelId')
  const credential = await store.getCredential(scope, channelId)
  if (!credential) {
    return jsonResponse({ error: '渠道不存在或不可访问' }, 404)
  }
  const workspace = await store.getWorkspace(scope, workspaceSlug)
  if (!workspace) {
    return jsonResponse({ error: '工作区不存在或不可访问' }, 404)
  }

  const now = Date.now()
  const session: TenantRuntimeSession = {
    tenantId: scope.tenantId,
    userId: scope.userId,
    sessionId: body.sessionId ?? createRuntimeWebId('session'),
    workspaceSlug,
    channelId,
    modelId: body.modelId ?? credential.defaultModel ?? requireString(body.modelId, 'modelId'),
    runtime: options.defaultRuntime ?? 'ai-sdk',
    title: body.title,
    createdAt: now,
    updatedAt: now,
  }

  return jsonResponse({ session: await store.createSession(session) }, 201)
}

interface RunSessionDependencies {
  store: TenantRuntimeStore
  taskRunner: AgentRuntimeTaskRunner
  interactionStore: AgentRuntimeInteractionStore
  secretCodec: AgentRuntimeWebSecretCodec
  runAgentTurn: AgentRuntimeWebAgentTurnRunner
  defaultPermissionMode: PromaPermissionMode
  beforeStartTask?: AgentRuntimeWebTaskPreflight
}

async function handleRunSession(
  request: Request,
  scope: AgentRuntimeScope,
  sessionId: string,
  deps: RunSessionDependencies,
): Promise<Response> {
  const session = await deps.store.getSession(scope, sessionId)
  if (!session) {
    return jsonResponse({ error: '会话不存在或不可访问' }, 404)
  }
  const body = await readJsonBody<RunSessionBody>(request)
  const prompt = requireString(body.prompt, 'prompt')
  const channelId = body.channelId ?? session.channelId
  const modelId = body.modelId ?? session.modelId
  const credential = await deps.store.getCredential(scope, channelId)
  if (!credential) {
    return jsonResponse({ error: '渠道不存在或不可访问' }, 404)
  }
  const workspace = await deps.store.getWorkspace(scope, session.workspaceSlug)
  if (!workspace) {
    return jsonResponse({ error: '工作区不存在或不可访问' }, 404)
  }

  const task = deps.taskRunner.startTask({
    ...scope,
    sessionId,
    run: async (context) => {
      await deps.beforeStartTask?.({ scope, session, credential, modelId })
      await runAgentTurnTask({
        context,
        prompt,
        modelId,
        protocol: body.protocol,
        permissionMode: body.permissionMode ?? deps.defaultPermissionMode,
        session: {
          ...session,
          channelId,
          modelId,
          updatedAt: Date.now(),
        },
        credential,
        workspace,
        deps,
      })
    },
  })
  await deps.store.setTask(task)
  void deps.taskRunner.waitForTask(task.taskId).then(async (completed) => {
    await deps.store.setTask(completed)
    if (completed.status !== 'running') {
      await cancelPendingInteractionsForTask(deps.interactionStore, scope, completed.taskId)
    }
  })

  return jsonResponse({ task }, 202)
}

interface RunAgentTurnTaskInput {
  context: AgentRuntimeTaskContext
  prompt: string
  modelId: string
  protocol?: AgentProviderProtocol
  permissionMode: PromaPermissionMode
  session: TenantRuntimeSession
  credential: TenantRuntimeCredential
  workspace: TenantRuntimeWorkspace
  deps: RunSessionDependencies
}

async function runAgentTurnTask(input: RunAgentTurnTaskInput): Promise<void> {
  const scope = { tenantId: input.context.tenantId, userId: input.context.userId }
  const historyMessages = await input.deps.store.getSessionMessages(scope, input.context.sessionId)
  const userMessage = createUserPromptSDKMessage(input.context.sessionId, input.prompt)
  await input.deps.store.appendSessionMessages(scope, input.context.sessionId, [userMessage])
  input.context.emit({ kind: 'sdk_message', message: userMessage })
  const apiKey = await resolveCredentialApiKey(input.credential, input.deps.secretCodec)
  const outputMessages = await input.deps.runAgentTurn({
    scope,
    session: input.session,
    taskId: input.context.taskId,
    credential: {
      ...input.credential,
      apiKey,
      apiKeyEncoding: 'plain',
    },
    workspace: input.workspace,
    prompt: input.prompt,
    modelId: input.modelId,
    provider: input.credential.provider,
    protocol: input.protocol,
    permissionMode: input.permissionMode,
    historyMessages,
    signal: input.context.signal,
    emit: input.context.emit,
    interactionStore: input.deps.interactionStore,
  })
  await input.deps.store.appendSessionMessages(scope, input.context.sessionId, outputMessages)
  await input.deps.store.updateSession(input.session)
  for (const message of outputMessages) {
    input.context.emit({ kind: 'sdk_message', message })
  }
}

async function handleSessionEvents(
  request: Request,
  url: URL,
  scope: AgentRuntimeScope,
  sessionId: string,
  store: TenantRuntimeStore,
  taskRunner: AgentRuntimeTaskRunner,
): Promise<Response> {
  const session = await store.getSession(scope, sessionId)
  if (!session) {
    return jsonResponse({ error: '会话不存在或不可访问' }, 404)
  }
  const afterId = request.headers.get('last-event-id') ?? url.searchParams.get('afterId') ?? undefined
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const replay = await taskRunner.serializeDurableReplayForSSE({ ...scope, sessionId, afterId })
      controller.enqueue(encoder.encode(replay || ': ready\n\n'))
      unsubscribe = taskRunner.subscribeLiveEvents({ ...scope, sessionId, onEvent: (event) => controller.enqueue(encoder.encode(serializeAgentStreamEnvelopeForSSE(event))) })
    },
    cancel() { unsubscribe?.() },
  })
  return new Response(body, {
    status: 200,
    headers: SSE_HEADERS,
  })
}

async function handleSessionMessages(
  scope: AgentRuntimeScope,
  sessionId: string,
  store: TenantRuntimeStore,
): Promise<Response> {
  const session = await store.getSession(scope, sessionId)
  if (!session) {
    return jsonResponse({ error: '会话不存在或不可访问' }, 404)
  }
  return jsonResponse({ messages: await store.getSessionMessages(scope, sessionId) })
}

async function handleCancelTask(
  scope: AgentRuntimeScope,
  taskId: string,
  store: TenantRuntimeStore,
  taskRunner: AgentRuntimeTaskRunner,
  interactionStore: AgentRuntimeInteractionStore,
): Promise<Response> {
  const storedTask = await store.getTask(scope, taskId)
  const liveTask = taskRunner.getTask(taskId)
  if (!storedTask && (!liveTask || liveTask.tenantId !== scope.tenantId || liveTask.userId !== scope.userId)) {
    return jsonResponse({ error: '任务不存在或不可访问' }, 404)
  }
  const cancelled = taskRunner.cancelTask(taskId)
  if (cancelled && liveTask) {
    const nextTask: AgentRuntimeTaskMeta = { ...liveTask, status: 'cancelled', completedAt: Date.now() }
    await store.setTask(nextTask)
    await cancelPendingInteractionsForTask(interactionStore, scope, taskId)
  }
  return jsonResponse({ cancelled })
}

async function cancelPendingInteractionsForTask(
  interactionStore: AgentRuntimeInteractionStore,
  scope: AgentRuntimeScope,
  taskId: string,
): Promise<void> {
  const pending = await interactionStore.listInteractions({ ...scope, taskId, status: 'pending' })
  await Promise.all(pending.map((interaction) => interactionStore.cancelInteraction(scope, interaction.requestId)))
}


async function handleListInteractions(
  url: URL,
  scope: AgentRuntimeScope,
  interactionStore: AgentRuntimeInteractionStore,
): Promise<Response> {
  const sessionId = url.searchParams.get('sessionId') ?? undefined
  const kind = parseInteractionKind(url.searchParams.get('kind'))
  const status = parseInteractionStatus(url.searchParams.get('status'))
  return jsonResponse({
    interactions: await interactionStore.listInteractions({
      ...scope,
      sessionId,
      kind,
      status,
      now: Date.now(),
    }),
  })
}

async function handleRespondInteraction(
  request: Request,
  scope: AgentRuntimeScope,
  requestId: string,
  interactionStore: AgentRuntimeInteractionStore,
): Promise<Response> {
  const body = await readJsonBody<RespondInteractionBody>(request)
  const response = body.response
  if (!isRecord(response) || response.requestId !== requestId) {
    return jsonResponse({ error: '响应体必须包含匹配 requestId 的 response' }, 400)
  }
  const interaction = await interactionStore.getInteraction(scope, requestId)
  if (!interaction) {
    return jsonResponse({ error: '交互请求不存在、不可访问或已处理' }, 404)
  }
  if (!isValidInteractionResponse(interaction.kind, response)) {
    return jsonResponse({ error: `响应类型与 ${interaction.kind} 交互不匹配` }, 400)
  }
  const resolved = await interactionStore.resolveInteraction(scope, requestId, response as AgentRuntimeInteractionResponse)
  if (!resolved) {
    return jsonResponse({ error: '交互请求不存在、不可访问或已处理' }, 404)
  }
  return jsonResponse({ interaction: resolved })
}

function isValidInteractionResponse(kind: AgentRuntimeInteractionKind, response: Record<string, unknown>): boolean {
  if (kind === 'permission') {
    return (response.behavior === 'allow' || response.behavior === 'deny') && typeof response.alwaysAllow === 'boolean'
  }
  if (!isRecord(response.answers)) return false
  return Object.values(response.answers).every((answer) => typeof answer === 'string')
}

async function handleCancelInteraction(
  scope: AgentRuntimeScope,
  requestId: string,
  interactionStore: AgentRuntimeInteractionStore,
): Promise<Response> {
  const cancelled = await interactionStore.cancelInteraction(scope, requestId)
  if (!cancelled) {
    return jsonResponse({ error: '交互请求不存在、不可访问或已处理' }, 404)
  }
  return jsonResponse({ interaction: cancelled })
}

async function handleOAuthCallback(
  oauthHandler: ServerMcpOAuthCallbackHandler,
  url: URL,
): Promise<Response> {
  const result = await oauthHandler.handleCallbackUrl(url.toString())
  return jsonResponse(result, result.ok ? 200 : 400)
}

async function resolveCredentialApiKey(
  credential: TenantRuntimeCredential,
  secretCodec: AgentRuntimeWebSecretCodec,
): Promise<string> {
  if (credential.apiKeyEncoding !== 'encoded') {
    return credential.apiKey
  }
  return secretCodec.decode(credential.apiKey, {
    tenantId: credential.tenantId,
    userId: credential.userId,
    purpose: 'provider_api_key',
    resourceId: credential.channelId,
  })
}

function matchAgentRoute(method: string, pathname: string):
  | { name: 'createSession' }
  | { name: 'updateSession'; sessionId: string }
  | { name: 'deleteSession'; sessionId: string }
  | { name: 'runSession'; sessionId: string }
  | { name: 'sessionEvents'; sessionId: string }
  | { name: 'sessionMessages'; sessionId: string }
  | { name: 'cancelTask'; taskId: string }
  | { name: 'listInteractions' }
  | { name: 'respondInteraction'; requestId: string }
  | { name: 'cancelInteraction'; requestId: string }
  | undefined {
  const segments = pathname.split('/').filter(Boolean)
  if (method === 'POST' && segments.length === 2 && segments[0] === 'agent' && segments[1] === 'sessions') {
    return { name: 'createSession' }
  }
  if (segments.length === 4 && segments[0] === 'agent' && segments[1] === 'sessions') {
    const sessionId = segments[2] ?? ''
    const action = segments[3]
    if (method === 'POST' && action === 'run') return { name: 'runSession', sessionId }
    if (method === 'GET' && action === 'events') return { name: 'sessionEvents', sessionId }
    if (method === 'GET' && action === 'messages') return { name: 'sessionMessages', sessionId }
  }
  if (method === 'PATCH' && segments.length === 3 && segments[0] === 'agent' && segments[1] === 'sessions') {
    return { name: 'updateSession', sessionId: segments[2] ?? '' }
  }
  if (method === 'DELETE' && segments.length === 3 && segments[0] === 'agent' && segments[1] === 'sessions') {
    return { name: 'deleteSession', sessionId: segments[2] ?? '' }
  }
  if (method === 'POST' && segments.length === 4 && segments[0] === 'agent' && segments[1] === 'tasks' && segments[3] === 'cancel') {
    return { name: 'cancelTask', taskId: segments[2] ?? '' }
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'agent' && segments[1] === 'interactions') {
    return { name: 'listInteractions' }
  }
  if (method === 'POST' && segments.length === 4 && segments[0] === 'agent' && segments[1] === 'interactions') {
    const requestId = segments[2] ?? ''
    const action = segments[3]
    if (action === 'respond') return { name: 'respondInteraction', requestId }
    if (action === 'cancel') return { name: 'cancelInteraction', requestId }
  }
  return undefined
}

function parseInteractionKind(value: string | null): AgentRuntimeInteractionKind | undefined {
  return value === 'permission' || value === 'ask_user' ? value : undefined
}

function parseInteractionStatus(value: string | null): AgentRuntimeInteractionStatus | undefined {
  return value === 'pending' || value === 'resolved' || value === 'cancelled' || value === 'expired'
    ? value
    : undefined
}

function headerAuthResolver(input: AgentRuntimeWebAuthResolverInput): AgentRuntimeScope | undefined {
  const tenantId = input.request.headers.get('x-proma-tenant-id') ?? ''
  const userId = input.request.headers.get('x-proma-user-id') ?? ''
  if (!tenantId || !userId) return undefined
  return { tenantId, userId }
}

async function readJsonBody<T extends object>(request: Request): Promise<T> {
  const value = await request.json()
  if (!isRecord(value)) {
    throw new Error('请求体必须是 JSON object')
  }
  return value as T
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`缺少必要字段: ${name}`)
  }
  return value
}

function createUserPromptSDKMessage(sessionId: string, prompt: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      content: [{ type: 'text', text: prompt }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: createRuntimeWebId('message'),
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createRuntimeWebId(prefix: string): string {
  const randomUUID = globalThis.crypto?.randomUUID
  const id = randomUUID ? randomUUID.call(globalThis.crypto) : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${id}`
}

function getRuntimeWebErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error) || '未知错误'
}

export function createPlainAgentRuntimeWebSecretCodec(): AgentRuntimeWebSecretCodec {
  return {
    encode: (plain) => plain,
    decode: (encoded) => encoded,
  }
}

export function createBase64AgentRuntimeWebSecretCodec(): AgentRuntimeWebSecretCodec {
  return {
    encode: (plain) => globalThis.btoa(plain),
    decode: (encoded) => globalThis.atob(encoded),
  }
}
