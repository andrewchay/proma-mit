import { describe, expect, test } from 'bun:test'
import type { PermissionRequest, SDKMessage } from '../types/agent'
import type { AgentRuntimeScope } from './agent-runtime-server'
import { createAgentRuntimeWebServer, createBase64AgentRuntimeWebSecretCodec } from './agent-runtime-web-server'

const scope = { tenantId: 'tenant-a', userId: 'user-a' }
const otherScope = { tenantId: 'tenant-b', userId: 'user-a' }
const baseUrl = 'https://proma.example.com'

describe('Agent runtime Web P0 server', () => {
  test('given valid scope when creating a session then metadata is stored under tenant scope', async () => {
    const server = createTestServer()
    seedRuntimeConfig(server.store, scope)

    const response = await server.handleRequest(jsonRequest('/agent/sessions', {
      workspaceSlug: 'main',
      channelId: 'deepseek',
      modelId: 'deepseek-chat',
      title: 'Web session',
    }, scope))
    const body = await response.json() as { session: { sessionId: string; title?: string } }

    expect(response.status).toBe(201)
    expect(body.session.sessionId).toStartWith('session-')
    expect(body.session.title).toBe('Web session')
    expect(server.store.getSession(scope, body.session.sessionId)).toBeDefined()
    expect(server.store.getSession(otherScope, body.session.sessionId)).toBeUndefined()
  })

  test('given an owned session when patching its title then it is persisted without changing its scope', async () => {
    const server = createTestServer()
    seedRuntimeConfig(server.store, scope)
    const sessionId = await createSession(server, scope)

    const response = await server.handleRequest(new Request(`${baseUrl}/agent/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { ...scopeHeaders(scope), 'content-type': 'application/json' },
      body: JSON.stringify({ title: '重命名后的会话' }),
    }))
    const body = await response.json() as { session: { title?: string } }

    expect(response.status).toBe(200)
    expect(body.session.title).toBe('重命名后的会话')
    expect((await server.store.getSession(otherScope, sessionId))).toBeUndefined()
  })

  test('given an owned session when deleting it then its scoped session record is removed', async () => {
    const server = createTestServer()
    seedRuntimeConfig(server.store, scope)
    const sessionId = await createSession(server, scope)

    const response = await server.handleRequest(new Request(`${baseUrl}/agent/sessions/${sessionId}`, {
      method: 'DELETE', headers: scopeHeaders(scope),
    }))

    expect(response.status).toBe(204)
    expect(await server.store.getSession(scope, sessionId)).toBeUndefined()
  })

  test('given a session when running agent turn then task, messages and SSE replay are produced', async () => {
    const seen: string[] = []
    const server = createTestServer({
      runAgentTurn: async (input) => {
        seen.push(input.credential.apiKey)
        input.emit({ kind: 'agent_event', event: { type: 'text_delta', text: `hello ${input.prompt}` } })
        return [
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'done' }] },
            parent_tool_use_id: null,
            session_id: input.session.sessionId,
            uuid: 'assistant-1',
          } as SDKMessage,
        ]
      },
    })
    seedRuntimeConfig(server.store, scope, { encodedKey: true })
    const sessionId = await createSession(server, scope)

    const runResponse = await server.handleRequest(jsonRequest(`/agent/sessions/${sessionId}/run`, {
      prompt: 'world',
    }, scope))
    const runBody = await runResponse.json() as { task: { taskId: string; status: string } }
    const completed = await server.taskRunner.waitForTask(runBody.task.taskId)
    const eventsResponse = await server.handleRequest(new Request(`${baseUrl}/agent/sessions/${sessionId}/events`, {
      headers: scopeHeaders(scope),
    }))
    const messagesResponse = await server.handleRequest(new Request(`${baseUrl}/agent/sessions/${sessionId}/messages`, {
      headers: scopeHeaders(scope),
    }))
    const messagesBody = await messagesResponse.json() as { messages: SDKMessage[] }

    expect(runResponse.status).toBe(202)
    expect(runBody.task.status).toBe('running')
    expect(completed.status).toBe('completed')
    expect(seen).toEqual(['plain-key'])
    expect(await readSSEReplay(eventsResponse)).toContain('hello world')
    expect(messagesBody.messages.map((message) => message.type)).toEqual(['user', 'assistant'])
  })

  test('given another tenant when reading session events then access is denied by lookup scope', async () => {
    const server = createTestServer()
    seedRuntimeConfig(server.store, scope)
    const sessionId = await createSession(server, scope)

    const response = await server.handleRequest(new Request(`${baseUrl}/agent/sessions/${sessionId}/events`, {
      headers: scopeHeaders(otherScope),
    }))

    expect(response.status).toBe(404)
  })

  test('given running task when cancelling through Web API then task is cancelled', async () => {
    let releaseTask = () => {}
    const server = createTestServer({
      runAgentTurn: async (input) => {
        await new Promise<void>((resolve, reject) => {
          releaseTask = resolve
          input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        return []
      },
    })
    seedRuntimeConfig(server.store, scope)
    const sessionId = await createSession(server, scope)
    const runResponse = await server.handleRequest(jsonRequest(`/agent/sessions/${sessionId}/run`, {
      prompt: 'wait',
    }, scope))
    const runBody = await runResponse.json() as { task: { taskId: string } }

    const cancelResponse = await server.handleRequest(jsonRequest(`/agent/tasks/${runBody.task.taskId}/cancel`, {}, scope))
    const completed = await server.taskRunner.waitForTask(runBody.task.taskId)
    releaseTask()

    expect(cancelResponse.status).toBe(200)
    expect(completed.status).toBe('cancelled')
  })

  test('given a pending interaction for a cancelled task then it is cancelled with the task', async () => {
    const server = createTestServer({
      runAgentTurn: async (input) => {
        await new Promise<void>((_, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
        return []
      },
    })
    seedRuntimeConfig(server.store, scope)
    const sessionId = await createSession(server, scope)
    const run = await server.handleRequest(jsonRequest(`/agent/sessions/${sessionId}/run`, { prompt: 'wait' }, scope))
    const { task } = await run.json() as { task: { taskId: string } }
    await server.interactionStore.createInteraction({ ...scope, taskId: task.taskId, kind: 'permission', request: permissionRequest('cancel-with-task', sessionId) })

    const cancelled = await server.handleRequest(jsonRequest(`/agent/tasks/${task.taskId}/cancel`, {}, scope))

    expect(cancelled.status).toBe(200)
    expect((await server.interactionStore.getInteraction(scope, 'cancel-with-task'))?.status).toBe('cancelled')
  })

  test('given OAuth callback route then pending MCP auth stores tokens without app auth headers', async () => {
    const server = createTestServer()
    server.oauthHandler.registerPending({
      ...scope,
      workspaceSlug: 'main',
      serverName: 'github',
      callbackBaseUrl: `${baseUrl}/mcp/oauth/callback`,
      state: 'state-a',
      finishAuth: async (code) => ({ accessToken: `token-${code}` }),
    })

    const response = await server.handleRequest(new Request(`${baseUrl}/mcp/oauth/callback?tenant=tenant-a&user=user-a&workspace=main&server=github&state=state-a&code=code-a`))
    const body = await response.json() as { ok: boolean }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect((await server.store.getMcpOAuthTokens(scope, 'main', 'github'))?.accessToken).toBe('token-code-a')
  })

  test('given pending interaction then Web API can list and resolve it within tenant scope', async () => {
    const server = createTestServer()
    await server.interactionStore.createInteraction({
      ...scope,
      kind: 'permission',
      request: permissionRequest('permission-1', 'session-a'),
      createdAt: 1000,
    })
    await server.interactionStore.createInteraction({
      ...otherScope,
      kind: 'permission',
      request: permissionRequest('permission-hidden', 'session-a'),
      createdAt: 1001,
    })

    const listResponse = await server.handleRequest(new Request(`${baseUrl}/agent/interactions?sessionId=session-a&status=pending`, {
      headers: scopeHeaders(scope),
    }))
    const listBody = await listResponse.json() as { interactions: Array<{ requestId: string; status: string }> }
    const resolveResponse = await server.handleRequest(jsonRequest('/agent/interactions/permission-1/respond', {
      response: {
        requestId: 'permission-1',
        behavior: 'allow',
        alwaysAllow: false,
      },
    }, scope))
    const resolveBody = await resolveResponse.json() as { interaction: { requestId: string; status: string } }

    expect(listResponse.status).toBe(200)
    expect(listBody.interactions.map((interaction) => interaction.requestId)).toEqual(['permission-1'])
    expect(resolveResponse.status).toBe(200)
    expect(resolveBody.interaction.status).toBe('resolved')
    expect((await server.interactionStore.getInteraction(scope, 'permission-1'))?.status).toBe('resolved')
  })

  test('given an AskUser interaction when submitting a permission response then it is rejected without resolving', async () => {
    const server = createTestServer()
    await server.interactionStore.createInteraction({
      ...scope,
      kind: 'ask_user',
      request: { requestId: 'ask-1', sessionId: 'session-a', questions: [{ question: '继续吗？', options: [] }], toolInput: {} },
    })

    const response = await server.handleRequest(jsonRequest('/agent/interactions/ask-1/respond', {
      response: { requestId: 'ask-1', behavior: 'allow', alwaysAllow: false },
    }, scope))

    expect(response.status).toBe(400)
    expect((await server.interactionStore.getInteraction(scope, 'ask-1'))?.status).toBe('pending')
  })
})

interface CreateTestServerOptions {
  runAgentTurn?: Parameters<typeof createAgentRuntimeWebServer>[0]['runAgentTurn']
}

function createTestServer(options: CreateTestServerOptions = {}) {
  return createAgentRuntimeWebServer({
    secretCodec: createBase64AgentRuntimeWebSecretCodec(),
    runAgentTurn: options.runAgentTurn ?? (async (input) => [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: input.prompt }] },
        parent_tool_use_id: null,
        session_id: input.session.sessionId,
        uuid: 'assistant-default',
      } as SDKMessage,
    ]),
  })
}

function seedRuntimeConfig(
  store: ReturnType<typeof createAgentRuntimeWebServer>['store'],
  runtimeScope: AgentRuntimeScope,
  options: { encodedKey?: boolean } = {},
): void {
  store.setCredential({
    ...runtimeScope,
    channelId: 'deepseek',
    provider: 'deepseek',
    apiKey: options.encodedKey ? globalThis.btoa('plain-key') : 'plain-key',
    apiKeyEncoding: options.encodedKey ? 'encoded' : 'plain',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
  })
  store.setWorkspace({
    ...runtimeScope,
    workspaceSlug: 'main',
    cwd: '/tmp/proma-web-main',
    mcpServers: {},
  })
}

async function createSession(
  server: ReturnType<typeof createAgentRuntimeWebServer>,
  runtimeScope: AgentRuntimeScope,
): Promise<string> {
  const response = await server.handleRequest(jsonRequest('/agent/sessions', {
    workspaceSlug: 'main',
    channelId: 'deepseek',
    modelId: 'deepseek-chat',
  }, runtimeScope))
  const body = await response.json() as { session: { sessionId: string } }
  return body.session.sessionId
}

function jsonRequest(pathname: string, body: unknown, runtimeScope: AgentRuntimeScope): Request {
  return new Request(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      ...scopeHeaders(runtimeScope),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function scopeHeaders(runtimeScope: AgentRuntimeScope): Record<string, string> {
  return {
    'x-proma-tenant-id': runtimeScope.tenantId,
    'x-proma-user-id': runtimeScope.userId,
  }
}

function permissionRequest(requestId: string, sessionId: string): PermissionRequest {
  return {
    requestId,
    sessionId,
    toolName: 'Write',
    toolInput: { file_path: 'a.txt' },
    description: '写入文件',
    dangerLevel: 'normal',
  }
}

async function readSSEReplay(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('SSE 响应缺少可读流')
  const first = await reader.read()
  await reader.cancel()
  return new TextDecoder().decode(first.value)
}
