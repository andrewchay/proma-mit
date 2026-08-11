import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test'
import type { SDKMessage, AgentStreamPayload, AgentProviderAdapter } from '@gravitas/shared'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// mock electron：orchestrator 顶层及相关服务依赖真实 Electron，测试环境无
mock.module('electron', () => ({
  app: { getPath: () => '/tmp', whenReady: async () => {}, on: () => {}, getAppPath: () => '/tmp' },
  BrowserWindow: class {},
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true, filePath: '' }) },
  shell: { openExternal: () => {} },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString('utf-8') },
}))

const { AgentOrchestrator } = await import('./agent-orchestrator')
const { AgentEventBus } = await import('./agent-event-bus')
import type { SessionCallbacks } from './agent-orchestrator'

type Orchestrator = InstanceType<typeof AgentOrchestrator>

/** 记录 query 收到的 options（捕获 cwd/agentCwd），用于断言项目目录覆盖生效。 */
function makeCapturingAdapter(records: Array<unknown>): AgentProviderAdapter {
  return {
    query(options: unknown): AsyncIterable<SDKMessage> {
      records.push(options)
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'success' } as unknown as SDKMessage
        },
      }
    },
    abort() {},
    dispose() {},
  }
}

function makeFakeRuntimeServices(emit: (sid: string, p: AgentStreamPayload) => void) {
  return {
    credentials: { resolveChannel: async () => undefined },
    workspaces: { resolveWorkspaceContext: () => ({ cwd: '/fake-ws-cwd' }) },
    sessions: { getHistoryMessages: () => [], appendMessages: () => {}, truncateMessages: () => [] },
    events: { emit },
    mcp: {},
  } as unknown as ConstructorParameters<typeof AgentOrchestrator>[2]
}

const EMPTY_CALLBACKS: SessionCallbacks = { onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {} }

const TEST_PROJECT_DIR = join(tmpdir(), 'proma-test-projdir')
const MISSING_PROJECT_DIR = join(tmpdir(), 'definitely-not-exist-xyz-123')

function ensureTestProjectDir() {
  if (!existsSync(TEST_PROJECT_DIR)) mkdirSync(TEST_PROJECT_DIR, { recursive: true })
}

describe('Agent 编排 独立项目目录（projectDir）覆盖', () => {
  let orchestrator: Orchestrator
  const records: Array<unknown> = []
  const errors: string[] = []

  beforeAll(() => {
    const eventBus = new AgentEventBus()
    orchestrator = new AgentOrchestrator(
      makeCapturingAdapter(records),
      eventBus,
      makeFakeRuntimeServices((sid, p) => eventBus.emit(sid, p)),
    )
  })

  afterAll(() => {
    if (existsSync(TEST_PROJECT_DIR)) rmSync(TEST_PROJECT_DIR, { recursive: true, force: true })
  })

  test('provider-agnostic runtime：传 projectDir 时 query cwd 使用项目目录', async () => {
    ensureTestProjectDir()
    await (orchestrator as unknown as { runProviderAgnosticAgent(o: unknown): Promise<void> }).runProviderAgnosticAgent({
      sessionId: 's-pa-cwd',
      agentRuntime: 'proma',
      channelId: 'c',
      workspaceId: undefined,
      projectDir: TEST_PROJECT_DIR,
      userMessage: 'hello',
      modelId: 'm',
      provider: 'anthropic',
      apiKey: 'k',
      baseUrl: 'https://x',
      callbacks: EMPTY_CALLBACKS,
    }).catch(() => {})

    const opts = records[records.length - 1] as { cwd?: string }
    expect(opts?.cwd).toBe(TEST_PROJECT_DIR)
  })

  test('pi runtime：projectDir 指向不存在目录时在调用模型前即报错', async () => {
    const before = records.length
    const errsBefore = errors.length
    await (orchestrator as unknown as { runPiAgent(o: unknown): Promise<void> }).runPiAgent({
      sessionId: 's-pi-bad',
      channelId: 'c',
      workspaceId: undefined,
      projectDir: MISSING_PROJECT_DIR,
      userMessage: 'hello',
      modelId: 'm',
      provider: 'anthropic',
      apiKey: 'k',
      baseUrl: 'https://x',
      callbacks: { onError: (e: string) => errors.push(e), onComplete: () => {}, onTitleUpdated: () => {} },
    }).catch(() => {})

    // 未触发模型 query，且产生项目目录报错
    expect(records.length).toBe(before)
    expect(errors.length).toBeGreaterThan(errsBefore)
    expect(errors[errors.length - 1]).toContain('项目目录不可用')
  })
})
