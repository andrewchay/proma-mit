import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentStreamPayload } from '@gravitas/shared'
import { startCompanionServer, stopCompanionServer, __getSseBufferForTest, type CompanionEventSource } from './companion-server'
import type { CompanionApiDeps } from './companion-api'
import { verifyToken } from './companion-auth'

/**
 * Companion Server 集成测试（PROMA_TEST_CONFIG_DIR 隔离，监听 127.0.0.1 随机端口）。
 * 注入 fake deps + fake 事件总线，不导入 agent-service（避免牵出整个主进程）。
 * 覆盖：启动/停止幂等、静态页面、401、SSE 事件流与 Last-Event-ID 补发。
 */

const testDir = join(tmpdir(), `gravitas-companion-server-test-${Date.now()}`)

process.env.PROMA_TEST_CONFIG_DIR = testDir

/** 极简事件总线 fake，模拟 agentEventBus 的 on/emit 语义 */
function makeFakeBus(): CompanionEventSource & { emit(sessionId: string, payload: AgentStreamPayload): void } {
  const handlers = new Set<(sessionId: string, payload: AgentStreamPayload) => void>()
  return {
    on(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    emit(sessionId, payload) {
      for (const handler of handlers) handler(sessionId, payload)
    },
  }
}

function makeFakeDeps(overrides: Partial<CompanionApiDeps> = {}): CompanionApiDeps {
  return {
    verifyPairingCode: () => false,
    issueToken: async () => ({ token: 'fake'.repeat(16) }),
    verifyToken: (t: string | undefined | null) => t === 'good-token',
    listSessions: () => [],
    listWorkspaces: () => [],
    getMessages: () => null,
    getPendingPermissions: () => [],
    getPendingAskUsers: () => [],
    respondPermission: async () => null,
    respondAskUser: async () => null,
    notifyPermissionResolved: () => undefined,
    notifyAskUserResolved: () => undefined,
    isSessionActive: () => false,
    sendUserMessage: async () => undefined,
    stopSession: () => false,
    appendAudit: async () => undefined,
    ...overrides,
  }
}

/** 极简 SSE 读取器：建立连接后逐条读取 data: 行 */
async function readSse(url: string): Promise<{ nextData(): Promise<string | null>; close(): Promise<void> }> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`SSE 连接失败: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async nextData(): Promise<string | null> {
      for (;;) {
        const idx = buffer.indexOf('data: ')
        if (idx >= 0) {
          const end = buffer.indexOf('\n', idx)
          if (end >= 0) {
            const line = buffer.slice(idx + 6, end)
            buffer = buffer.slice(end + 1)
            return line
          }
        }
        const { done, value } = await reader.read()
        if (done) return buffer.includes('data: ') ? buffer : null
        buffer += decoder.decode(value, { stream: true })
      }
    },
    async close(): Promise<void> {
      await reader.cancel().catch(() => undefined)
    },
  }
}

describe('companion-server', () => {
  test('启动/停止幂等，静态页面可访问，业务接口 401/200', async () => {
    const port = await startCompanionServer({
      deps: makeFakeDeps(),
      eventSource: makeFakeBus(),
      bindAddress: '127.0.0.1',
      port: 0,
    })
    expect(port).toBeGreaterThan(0)
    // 幂等：重复启动返回同一端口
    expect(await startCompanionServer({ deps: makeFakeDeps(), eventSource: makeFakeBus(), bindAddress: '127.0.0.1', port: 0 })).toBe(port)

    // 静态页面（无需 token，本身不含数据）
    const page = await fetch(`http://127.0.0.1:${port}/companion`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Gravitas Companion')

    // 未带 token 的 API → 401
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`)
    expect(res.status).toBe(401)

    await stopCompanionServer()
    await stopCompanionServer() // 幂等
  })

  test('SSE：订阅后收到事件总线推送，Last-Event-ID 可补发，sdk_message 被过滤', async () => {
    const bus = makeFakeBus()
    const port = await startCompanionServer({
      deps: makeFakeDeps(),
      eventSource: bus,
      bindAddress: '127.0.0.1',
      port: 0,
    })

    const reader = await readSse(`http://127.0.0.1:${port}/api/events?token=good-token`)
    try {
      // 模拟一次权限请求事件推送（灵动岛同源事件）
      bus.emit('sse-test-session', {
        kind: 'proma_event',
        event: { type: 'permission_request', request: { requestId: 'p1', sessionId: 'sse-test-session', toolName: 'Bash', toolInput: {}, description: '测试请求', dangerLevel: 'medium' } },
      } as never)

      const first = await reader.nextData()
      expect(first).toBeTruthy()
      const envelope = JSON.parse(first!) as { id: string; sessionId: string; payload: { kind: string } }
      expect(envelope.sessionId).toBe('sse-test-session')
      expect(envelope.payload.kind).toBe('proma_event')

      // sdk_message 不转发（过滤大 payload）
      bus.emit('sse-test-session', { kind: 'sdk_message', message: { type: 'assistant' } } as never)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(__getSseBufferForTest().some((e) => e.payload.kind === 'sdk_message')).toBe(false)

      // 用首条事件 id 作为 lastEventId 重新连接，应补发缓冲内后续事件
      bus.emit('sse-test-session', {
        kind: 'proma_event',
        event: { type: 'permission_resolved', requestId: 'p1', behavior: 'allow' },
      } as never)
      const reader2 = await readSse(`http://127.0.0.1:${port}/api/events?token=good-token&lastEventId=${envelope.id}`)
      try {
        const replayed = await reader2.nextData()
        expect(replayed).toBeTruthy()
        const replayEnvelope = JSON.parse(replayed!) as { payload: { event: { type: string } } }
        expect(replayEnvelope.payload.event.type).toBe('permission_resolved')
      } finally {
        await reader2.close()
      }
    } finally {
      await reader.close()
    }
    await stopCompanionServer()
  })

  test('SSE 错误 token 返回 401', async () => {
    const port = await startCompanionServer({
      deps: makeFakeDeps(),
      eventSource: makeFakeBus(),
      bindAddress: '127.0.0.1',
      port: 0,
    })
    const bad = await fetch(`http://127.0.0.1:${port}/api/events?token=wrong`)
    expect(bad.status).toBe(401)
    const none = await fetch(`http://127.0.0.1:${port}/api/events`)
    expect(none.status).toBe(401)
    await stopCompanionServer()
  })

  test('verifyToken（companion-auth）在未签发时拒绝一切', () => {
    expect(verifyToken('good-token')).toBe(false)
    expect(verifyToken(undefined)).toBe(false)
  })
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
})
