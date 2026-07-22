import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeRedisClient, AgentRuntimeRedisStreamEntry } from './agent-runtime-redis-store'
import { RedisAgentRuntimeEventStore, RedisAgentRuntimeTaskCache } from './agent-runtime-redis-store'

const scope = { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a' }

describe('RedisAgentRuntimeEventStore', () => {
  test('given stream events then replay returns only scoped events after cursor', async () => {
    const client = new FakeRedisClient()
    const store = new RedisAgentRuntimeEventStore({ client })
    await store.append({
      ...scope,
      id: '1000-1',
      createdAt: 1000,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'first' } },
    })
    await store.append({
      ...scope,
      id: '1000-2',
      createdAt: 1001,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'second' } },
    })
    await store.append({
      tenantId: 'tenant-b',
      userId: 'user-a',
      sessionId: 'session-a',
      id: '1000-3',
      createdAt: 1002,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'hidden' } },
    })

    const replayed = await store.replay({ ...scope, afterId: '1000-1' })

    expect(replayed.map((event) => event.id)).toEqual(['1000-2'])
    expect(JSON.stringify(replayed[0]?.payload)).toContain('second')
  })

  test('given max length then old stream entries are trimmed', async () => {
    const client = new FakeRedisClient()
    const store = new RedisAgentRuntimeEventStore({ client, maxEventsPerSession: 1 })

    await store.append({
      ...scope,
      id: '1000-1',
      createdAt: 1000,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'first' } },
    })
    await store.append({
      ...scope,
      id: '1000-2',
      createdAt: 1001,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'second' } },
    })

    expect((await store.replay(scope)).map((event) => event.id)).toEqual(['1000-2'])
  })
})

describe('RedisAgentRuntimeTaskCache', () => {
  test('given cached task then reads are scoped by tenant and user', async () => {
    const client = new FakeRedisClient()
    const cache = new RedisAgentRuntimeTaskCache({ client, ttlMs: 60_000 })
    await cache.setTask({
      ...scope,
      taskId: 'task-a',
      status: 'running',
      startedAt: 1000,
    })

    expect((await cache.getTask(scope, 'task-a'))?.status).toBe('running')
    expect(await cache.getTask({ tenantId: 'tenant-b', userId: 'user-a' }, 'task-a')).toBeUndefined()
    expect(client.lastSetOptions?.ttlMs).toBe(60_000)
  })
})

class FakeRedisClient implements AgentRuntimeRedisClient {
  readonly streams = new Map<string, AgentRuntimeRedisStreamEntry[]>()
  readonly values = new Map<string, string>()
  lastSetOptions?: { ttlMs?: number }

  async xadd(key: string, id: string, fields: Record<string, string>): Promise<string> {
    const entries = this.streams.get(key) ?? []
    entries.push({ id, fields })
    this.streams.set(key, entries)
    return id
  }

  async xrange(key: string, _start: string, _end: string): Promise<AgentRuntimeRedisStreamEntry[]> {
    return [...(this.streams.get(key) ?? [])]
  }

  async xtrim(key: string, maxLen: number): Promise<void> {
    const entries = this.streams.get(key) ?? []
    this.streams.set(key, entries.slice(Math.max(0, entries.length - maxLen)))
  }

  async set(key: string, value: string, options?: { ttlMs?: number }): Promise<void> {
    this.lastSetOptions = options
    this.values.set(key, value)
  }

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key)
  }

  async del(key: string): Promise<void> {
    this.values.delete(key)
  }
}
