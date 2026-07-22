import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeDurableEventStore, AgentRuntimeEventRecord, AgentRuntimeEventReplayInput } from './agent-runtime-server'
import { AgentRuntimeEventReplayHub, AgentRuntimeTaskRunner } from './agent-runtime-server'

const scope = { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a' }

describe('AgentRuntimeEventReplayHub', () => {
  test('given disconnected client when replaying after last event then only missed events are returned', () => {
    const hub = new AgentRuntimeEventReplayHub()
    const first = hub.emit({
      ...scope,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'a' } },
    })
    hub.emit({
      ...scope,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'b' } },
    })

    const replayed = hub.replay({ ...scope, afterId: first.id })

    expect(replayed.map((event) => event.payload)).toEqual([
      { kind: 'agent_event', event: { type: 'text_delta', text: 'b' } },
    ])
    expect(hub.serializeReplayForSSE({ ...scope, afterId: first.id })).toContain('event: agent-stream')
  })

  test('given subscribers in different tenants then events stay isolated', () => {
    const hub = new AgentRuntimeEventReplayHub()
    const seen: string[] = []
    hub.subscribe({
      ...scope,
      onEvent: (event) => {
        if (event.payload.kind === 'agent_event' && event.payload.event.type === 'text_delta') {
          seen.push(event.payload.event.text)
        }
      },
    })

    hub.emit({
      ...scope,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'visible' } },
    })
    hub.emit({
      tenantId: 'tenant-b',
      userId: 'user-a',
      sessionId: 'session-a',
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'hidden' } },
    })

    expect(seen).toEqual(['visible'])
  })

  test('given scope ids contain separators then scoped sessions do not collide', () => {
    const hub = new AgentRuntimeEventReplayHub()
    const firstScope = { tenantId: 'tenant:a', userId: 'user', sessionId: 'session' }
    const secondScope = { tenantId: 'tenant', userId: 'a:user', sessionId: 'session' }
    hub.emit({
      ...firstScope,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'first' } },
    })
    hub.emit({
      ...secondScope,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'second' } },
    })

    const replayed = hub.replay(firstScope)

    expect(replayed).toHaveLength(1)
    expect(replayed[0]?.tenantId).toBe('tenant:a')
    expect(replayed[0]?.userId).toBe('user')
    expect(JSON.stringify(replayed[0]?.payload)).toContain('first')
  })

  test('given durable store when replaying after reconnect then durable events are used', async () => {
    const store = new MemoryDurableEventStore()
    const hub = new AgentRuntimeEventReplayHub({ durableStore: store })
    const first = hub.emit({
      ...scope,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'persisted-a' } },
    })
    hub.emit({
      ...scope,
      payload: { kind: 'agent_event', event: { type: 'text_delta', text: 'persisted-b' } },
    })

    const replayed = await hub.replayDurable({ ...scope, afterId: first.id })

    expect(replayed.map((event) => event.payload)).toEqual([
      { kind: 'agent_event', event: { type: 'text_delta', text: 'persisted-b' } },
    ])
    expect(await hub.serializeDurableReplayForSSE({ ...scope, afterId: first.id })).toContain('persisted-b')
  })
})

describe('AgentRuntimeTaskRunner', () => {
  test('given a running task when starting another task for same scoped session then it is rejected', async () => {
    const runner = new AgentRuntimeTaskRunner()
    const task = runner.startTask({
      ...scope,
      taskId: 'task-1',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      },
    })

    expect(task.status).toBe('running')
    expect(() => runner.startTask({
      ...scope,
      taskId: 'task-2',
      run: async () => {},
    })).toThrow('会话已有运行中的任务')

    await runner.waitForTask('task-1')
  })

  test('given running task when cancelled then status becomes cancelled and session can run again', async () => {
    const runner = new AgentRuntimeTaskRunner()
    runner.startTask({
      ...scope,
      taskId: 'task-cancel',
      run: async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
    })

    expect(runner.cancelTask('task-cancel')).toBe(true)
    const cancelled = await runner.waitForTask('task-cancel')
    expect(cancelled.status).toBe('cancelled')

    const next = runner.startTask({
      ...scope,
      taskId: 'task-next',
      run: async () => {},
    })
    expect(next.status).toBe('running')
    expect((await runner.waitForTask('task-next')).status).toBe('completed')
  })

  test('given task emits events then replay survives client reconnect', async () => {
    const runner = new AgentRuntimeTaskRunner()
    runner.startTask({
      ...scope,
      taskId: 'task-events',
      run: async ({ emit }) => {
        emit({ kind: 'agent_event', event: { type: 'text_delta', text: 'hello' } })
      },
    })

    expect((await runner.waitForTask('task-events')).status).toBe('completed')
    const replayed = runner.replayEvents(scope)
    expect(replayed).toHaveLength(1)
    expect(JSON.stringify(replayed[0]?.payload)).toContain('hello')
  })
})

class MemoryDurableEventStore implements AgentRuntimeDurableEventStore {
  private readonly events: AgentRuntimeEventRecord[] = []

  append(event: AgentRuntimeEventRecord): void {
    this.events.push(event)
  }

  replay(input: AgentRuntimeEventReplayInput): AgentRuntimeEventRecord[] {
    const scoped = this.events.filter((event) =>
      event.tenantId === input.tenantId &&
      event.userId === input.userId &&
      event.sessionId === input.sessionId)
    if (!input.afterId) return scoped
    const idx = scoped.findIndex((event) => event.id === input.afterId)
    return idx >= 0 ? scoped.slice(idx + 1) : scoped
  }
}
