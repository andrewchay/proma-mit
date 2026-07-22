import { describe, expect, test } from 'bun:test'
import {
  createAgentRuntimeSessionArtifactObjectKey,
  createAgentRuntimeWorkspaceObjectKey,
  createAgentRuntimeWorkspaceObjectPrefix,
  InMemoryAgentRuntimeObjectStore,
  normalizeRelativeObjectPath,
} from './agent-runtime-object-storage'

const scope = { tenantId: 'tenant/a', userId: 'user:a' }

describe('Agent runtime object storage', () => {
  test('given workspace file then key is scoped by tenant, user and workspace', () => {
    const key = createAgentRuntimeWorkspaceObjectKey({
      ...scope,
      workspaceSlug: 'main workspace',
      relativePath: 'src/index.ts',
    })

    expect(key).toBe('tenants/tenant%2Fa/users/user%3Aa/workspaces/main%20workspace/files/src/index.ts')
  })

  test('given session artifact then key is scoped by tenant, user and session', () => {
    const key = createAgentRuntimeSessionArtifactObjectKey({
      ...scope,
      sessionId: 'session-1',
      relativePath: 'reports/result.json',
    })

    expect(key).toBe('tenants/tenant%2Fa/users/user%3Aa/sessions/session-1/artifacts/reports/result.json')
  })

  test('given unsafe relative path then normalization rejects traversal', () => {
    expect(() => normalizeRelativeObjectPath('../secret.txt')).toThrow('对象路径不能包含')
    expect(() => normalizeRelativeObjectPath('/absolute.txt')).toThrow('对象路径必须是相对路径')
    expect(() => normalizeRelativeObjectPath('a//b.txt')).toThrow('对象路径不能包含')
  })

  test('given stored bytes then callers cannot mutate persisted object', async () => {
    const store = new InMemoryAgentRuntimeObjectStore()
    const key = createAgentRuntimeWorkspaceObjectKey({
      ...scope,
      workspaceSlug: 'main',
      relativePath: 'note.txt',
    })
    const body = new Uint8Array([1, 2, 3])
    await store.putObject({ key, body, contentType: 'text/plain' })
    body[0] = 9
    const fetched = await store.getObject(key)
    if (!fetched) throw new Error('expected object')
    fetched.body[1] = 8

    expect([...(await store.getObject(key))!.body]).toEqual([1, 2, 3])
  })

  test('given prefix listing then only matching tenant workspace objects are returned', async () => {
    const store = new InMemoryAgentRuntimeObjectStore()
    const prefix = createAgentRuntimeWorkspaceObjectPrefix(scope, 'main')
    const visibleKey = createAgentRuntimeWorkspaceObjectKey({
      ...scope,
      workspaceSlug: 'main',
      relativePath: 'visible.txt',
    })
    const hiddenKey = createAgentRuntimeWorkspaceObjectKey({
      tenantId: 'tenant-b',
      userId: 'user:a',
      workspaceSlug: 'main',
      relativePath: 'hidden.txt',
    })
    await store.putObject({ key: hiddenKey, body: new Uint8Array([0]) })
    await store.putObject({ key: visibleKey, body: new Uint8Array([1]) })

    expect((await store.listObjects({ prefix })).map((object) => object.key)).toEqual([visibleKey])
  })
})
