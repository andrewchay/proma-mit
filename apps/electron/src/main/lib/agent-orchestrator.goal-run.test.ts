import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentGoalCheckpoint, AgentProviderAdapter, AgentRuntime, SDKMessage } from '@gravitas/shared'
import type { ProviderAgnosticAgentQueryOptions } from './adapters/provider-agnostic-agent-adapter'
import type { PiAgentQueryOptions } from './adapters/pi-agent-adapter'
import { buildElectronMock } from './testing/electron-mock'

const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
const directory = mkdtempSync(join(tmpdir(), 'gravitas-goal-run-'))
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const { AgentOrchestrator } = await import('./agent-orchestrator')
const { AgentEventBus } = await import('./agent-event-bus')
const { createElectronRuntimeServices } = await import('./agent-runtime/runtime-services')
const { createChannel } = await import('./channel-manager')
const { createAgentSession } = await import('./agent-session-manager')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { GoalCoordinator } = await import('./goal-runtime/goal-coordinator')
const { permissionService } = await import('./agent-permission-service')

afterAll(async () => {
  // 本地异步审计写入结束后才还原配置环境。
  await Bun.sleep(20)
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(directory, { recursive: true, force: true })
})

const complete: AgentGoalCheckpoint = { outcome: 'complete', summary: 'fixture完成', completed: [], evidence: [] }
const callbacks = { onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {} }

function fixture(runtime: Extract<AgentRuntime, 'ai-sdk' | 'pi'> = 'ai-sdk') {
  const channel = createChannel({ name: '离线fixture', provider: 'openai', baseUrl: 'https://fixture.invalid', apiKey: 'not-a-real-key', models: [], enabled: true })
  const workspace = createAgentWorkspace(`Goal fixture ${channel.id}`)
  const session = createAgentSession('Goal调用测试', channel.id, workspace.id, 'fixture-model', runtime)
  const c = new GoalCoordinator()
  const goal = c.create({ sessionId: session.id, runtime, workspaceId: workspace.id, objective: 'fixture' })
  const entries: Array<{ checkpoint?: (input: AgentGoalCheckpoint) => Promise<void>; release: () => void }> = []
  const adapter: AgentProviderAdapter = {
    query(input) {
      const gate = Promise.withResolvers<void>()
      const checkpoint = runtime === 'pi'
        ? (input as PiAgentQueryOptions).toolContextOverrides?.onGoalCheckpoint
        : (input as ProviderAgnosticAgentQueryOptions).onGoalCheckpoint
      entries.push({ checkpoint, release: () => gate.resolve() })
      return {
        async *[Symbol.asyncIterator]() {
          await gate.promise
          yield { type: 'result', subtype: 'success' } as SDKMessage
        },
      }
    },
    abort() {}, dispose() {},
  }
  let captures = 0
  const bus = new AgentEventBus()
  const o = new AgentOrchestrator(adapter, bus, createElectronRuntimeServices(bus), (sid) => {
    captures++
    return c.captureRun(sid)
  })
  const input = { sessionId: session.id, workspaceId: workspace.id, channelId: channel.id, modelId: 'fixture-model', agentRuntime: runtime, userMessage: '', startedAt: 123 }
  return { c, o, goal, entries, input, captures: () => captures }
}

async function entry(w: ReturnType<typeof fixture>, index: number) {
  for (let i = 0; i < 100 && !w.entries[index]; i++) await Bun.sleep(5)
  const result = w.entries[index]
  if (!result) throw new Error('fixture未进入实际query边界')
  return result
}

describe('真实Orchestrator Goal闭包边界（离线adapter）', () => {
  for (const runtime of ['ai-sdk', 'pi'] as const) {
    test(`${runtime}普通运行在query前签发身份，并传入同一固定检查点闭包`, async () => {
      const w = fixture(runtime)
      const running = w.o.sendMessage(w.input, callbacks)
      const e = await entry(w, 0)
      try {
        expect(w.captures()).toBe(1)
        const runId = w.c.get(w.goal.id)?.activeRunId
        expect(runId).toBeDefined()
        expect(e.checkpoint).toBeFunction()
        await e.checkpoint!(complete)
        expect(w.c.get(w.goal.id)?.checkpointRunId).toBe(runId)
      } finally { e.release(); await running }
      expect(w.c.get(w.goal.id)?.status).toBe('completed')
    })
  }

  test('停止并开始同startedAt新run后，旧callback/finally不伤新槽位', async () => {
    const w = fixture()
    const first = w.o.sendMessage(w.input, callbacks)
    const old = await entry(w, 0)
    const clearRequests = spyOn(permissionService, 'clearSessionPending')
    let second: Promise<void> | undefined
    let next: Awaited<ReturnType<typeof entry>> | undefined
    try {
      expect(w.o.stop(w.input.sessionId, 123).requestAccepted).toBe(true)
      await expect(old.checkpoint!(complete)).rejects.toThrow('已失效')
      second = w.o.sendMessage(w.input, callbacks)
      next = await entry(w, 1)
      const runId = w.c.get(w.goal.id)?.activeRunId
      await expect(old.checkpoint!(complete)).rejects.toThrow('已失效')
      old.release()
      await first
      expect(clearRequests).not.toHaveBeenCalled()
      expect(w.c.get(w.goal.id)?.activeRunId).toBe(runId)
      await next.checkpoint!(complete)
    } finally {
      old.release(); next?.release()
      await first; await second
      clearRequests.mockRestore()
    }
    expect(w.c.get(w.goal.id)?.status).toBe('completed')
  })

  test('停止后没有新run，结束仍清理旧权限请求并等待用户', async () => {
    const w = fixture()
    const running = w.o.sendMessage(w.input, callbacks)
    const e = await entry(w, 0)
    const clearRequests = spyOn(permissionService, 'clearSessionPending')
    try {
      w.o.stop(w.input.sessionId, 123)
      e.release(); await running
      expect(clearRequests).toHaveBeenCalledWith(w.input.sessionId)
      expect(w.c.get(w.goal.id)?.status).toBe('waiting')
      expect(w.c.get(w.goal.id)?.activeRunId).toBeUndefined()
    } finally { e.release(); await running; clearRequests.mockRestore() }
  })

  test('排队不预造Goal run；前一run退出后按真实query签发', async () => {
    const w = fixture()
    const first = w.o.sendMessage(w.input, callbacks)
    const old = await entry(w, 0)
    let next: Awaited<ReturnType<typeof entry>> | undefined
    try {
      expect(w.captures()).toBe(1)
      const runId = w.c.get(w.goal.id)?.activeRunId
      await w.o.sendMessage({ ...w.input, userMessage: 'queued', startedAt: 124 }, callbacks)
      expect(w.captures()).toBe(1)
      expect(w.c.get(w.goal.id)?.activeRunId).toBe(runId)
      old.release(); await first
      next = await entry(w, 1)
      expect(w.captures()).toBe(2)
      expect(w.c.get(w.goal.id)?.activeRunId).not.toBe(runId)
      await next.checkpoint!(complete)
    } finally { old.release(); next?.release(); await first }
    await Bun.sleep(20)
  })

  test('continue检查点之后已有用户排队，不插入自动续跑', async () => {
    const w = fixture()
    const requests: string[] = []
    w.c.setContinuationRunner(async ({ prompt }) => { requests.push(prompt); return true })
    const first = w.o.sendMessage(w.input, callbacks)
    const old = await entry(w, 0)
    let next: Awaited<ReturnType<typeof entry>> | undefined
    try {
      await old.checkpoint!({ outcome: 'continue', summary: '继续', completed: [], evidence: [], nextAction: '自动继续', wakeTrigger: { type: 'immediate' } })
      await w.o.sendMessage({ ...w.input, userMessage: '先处理用户输入', startedAt: 124 }, callbacks)
      old.release(); await first
      next = await entry(w, 1)
      expect(requests).toEqual([])
      await next.checkpoint!(complete)
    } finally { old.release(); next?.release(); await first }
    await Bun.sleep(20)
  })

  test('compact-only和渠道预检失败都不签发run或Goal工具', async () => {
    const w = fixture()
    await w.o.sendMessage({ ...w.input, channelId: 'absent' }, callbacks)
    expect(w.captures()).toBe(0)
    const running = w.o.sendMessage({ ...w.input, userMessage: '/compact' }, callbacks)
    const e = await entry(w, 0)
    try { expect(w.captures()).toBe(0); expect(e.checkpoint).toBeUndefined() }
    finally { e.release(); await running }
    expect(w.c.get(w.goal.id)?.status).toBe('active')
    expect(w.c.get(w.goal.id)?.activeRunId).toBeUndefined()
  })
})
