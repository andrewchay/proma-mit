import { describe, expect, test } from 'bun:test'
import type { AskUserRequest, PermissionRequest } from '../types/agent'
import { InMemoryAgentRuntimeInteractionStore } from './agent-runtime-interaction-store'

const scope = { tenantId: 'tenant-a', userId: 'user-a' }
const otherScope = { tenantId: 'tenant-b', userId: 'user-a' }

describe('InMemoryAgentRuntimeInteractionStore', () => {
  test('given pending permission then list is scoped by tenant and session', async () => {
    const store = new InMemoryAgentRuntimeInteractionStore()
    await store.createInteraction({
      ...scope,
      kind: 'permission',
      request: permissionRequest('perm-1', 'session-a'),
      createdAt: 1000,
    })
    await store.createInteraction({
      ...otherScope,
      kind: 'permission',
      request: permissionRequest('perm-2', 'session-a'),
      createdAt: 1001,
    })

    const pending = await store.listInteractions({ ...scope, sessionId: 'session-a', status: 'pending' })

    expect(pending.map((record) => record.requestId)).toEqual(['perm-1'])
  })

  test('given ask user response then interaction is resolved once', async () => {
    const store = new InMemoryAgentRuntimeInteractionStore()
    await store.createInteraction({
      ...scope,
      taskId: 'task-a',
      kind: 'ask_user',
      request: askUserRequest('ask-1', 'session-a'),
      createdAt: 1000,
    })

    const resolved = await store.resolveInteraction(scope, 'ask-1', {
      requestId: 'ask-1',
      answers: { Continue: 'yes' },
    })
    const secondResolve = await store.resolveInteraction(scope, 'ask-1', {
      requestId: 'ask-1',
      answers: { Continue: 'no' },
    })

    expect(resolved?.status).toBe('resolved')
    expect(resolved?.taskId).toBe('task-a')
    expect(secondResolve).toBeUndefined()
  })

  test('given expired pending requests then only matching scope is marked expired', async () => {
    const store = new InMemoryAgentRuntimeInteractionStore()
    await store.createInteraction({
      ...scope,
      kind: 'permission',
      request: permissionRequest('perm-expired', 'session-a'),
      createdAt: 1000,
      expiresAt: 1500,
    })
    await store.createInteraction({
      ...otherScope,
      kind: 'permission',
      request: permissionRequest('perm-other', 'session-a'),
      createdAt: 1000,
      expiresAt: 1500,
    })

    const expired = await store.expireInteractions(scope, 2000)

    expect(expired.map((record) => record.requestId)).toEqual(['perm-expired'])
    expect((await store.getInteraction(scope, 'perm-expired'))?.status).toBe('expired')
    expect((await store.getInteraction(otherScope, 'perm-other'))?.status).toBe('pending')
  })
})

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

function askUserRequest(requestId: string, sessionId: string): AskUserRequest {
  return {
    requestId,
    sessionId,
    questions: [
      {
        question: 'Continue?',
        options: [{ label: 'yes' }, { label: 'no' }],
      },
    ],
    toolInput: {},
  }
}
