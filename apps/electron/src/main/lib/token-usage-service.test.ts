/**
 * Token 消耗统计服务单元测试
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import type { SDKAssistantMessage, SDKMessage, AgentStreamPayload } from '@gravitas/shared'

const originalHomedir = homedir()
const tempHomeDir = mkdtempSync(join(tmpdir(), 'proma-token-usage-test-'))

class MockBrowserWindow {}

mock.module('os', () => ({
  homedir: () => tempHomeDir,
  tmpdir,
}))

mock.module('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  app: { isPackaged: false },
  dialog: {},
}))

mock.module('./agent-session-manager', () => ({
  getAgentSessionMeta: () => ({
    id: 'session-1',
    title: '测试会话',
    workspaceId: 'workspace-1',
    channelId: 'channel-1',
    modelId: 'deepseek-v4-flash',
    agentRuntime: 'pi',
  }),
  appendSDKMessages: () => {},
}))

mock.module('./agent-workspace-manager', () => ({
  getAgentWorkspace: (id: string) =>
    id === 'workspace-1'
      ? { id: 'workspace-1', slug: 'test-ws', name: 'Test Workspace', rootPath: '/tmp' }
      : undefined,
  getWorkspaceSkills: (slug: string) =>
    slug === 'test-ws'
      ? [
          { slug: 'ma-marketing', name: 'Marketing', enabled: true },
          { slug: 'growth-scout', name: 'Growth Scout', enabled: true },
        ]
      : [],
}))

const { createTokenUsageService } = await import('./token-usage-service')

function buildAssistantMessage(
  usage: Record<string, unknown>,
  toolNames: string[],
  overrides: Partial<SDKAssistantMessage> = {},
): SDKAssistantMessage {
  const base = {
    type: 'assistant',
    message: {
      content: toolNames.map((name) => ({ type: 'tool_use', id: `tool-${name}`, name, input: {} })),
      usage,
      model: 'deepseek-v4-flash',
      stop_reason: 'tool_use',
    },
    parent_tool_use_id: null,
    session_id: 'session-1',
    uuid: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    _createdAt: Date.now(),
    ...overrides,
  } as unknown as SDKAssistantMessage
  return base
}

function buildPayload(message: SDKMessage): AgentStreamPayload {
  return { kind: 'sdk_message', message }
}

describe('TokenUsageService', () => {
  let service: ReturnType<typeof createTokenUsageService>

  beforeEach(() => {
    process.env.PROMA_TEST_CONFIG_DIR = join(tempHomeDir, `config-${Date.now()}`)
    mkdirSync(process.env.PROMA_TEST_CONFIG_DIR, { recursive: true })
    service = createTokenUsageService()
  })

  afterEach(() => {
    const configDir = process.env.PROMA_TEST_CONFIG_DIR
    if (configDir && existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true })
    }
    delete process.env.PROMA_TEST_CONFIG_DIR
  })

  afterAll(() => {
    if (existsSync(tempHomeDir)) rmSync(tempHomeDir, { recursive: true, force: true })
    mock.module('os', () => ({
      homedir: () => originalHomedir,
      tmpdir,
    }))
  })

  test('记录 assistant message 的 usage 并持久化', () => {
    const message = buildAssistantMessage(
      {
        input: 1000,
        output: 200,
        cacheRead: 100,
        cacheWrite: 50,
        totalTokens: 1250,
        cost: { input: 0.0001, output: 0.0002, cacheRead: 0.00001, cacheWrite: 0.000005, total: 0.000315 },
      },
      ['Read'],
    )

    service.middleware('session-1', buildPayload(message), () => {})

    const records = service.query({ sessionId: 'session-1' })
    expect(records.length).toBe(1)
    expect(records[0]?.inputTokens).toBe(1000)
    expect(records[0]?.outputTokens).toBe(200)
    expect(records[0]?.cacheReadTokens).toBe(100)
    expect(records[0]?.cacheCreationTokens).toBe(50)
    expect(records[0]?.totalTokens).toBe(1250)
    expect(records[0]?.costTotal).toBe(0.000315)
    expect(records[0]?.toolNames).toEqual(['Read'])
  })

  test('识别 Skill 工具与 MCP 服务器', () => {
    const message = buildAssistantMessage(
      { input: 500, output: 100, totalTokens: 600 },
      ['ma-marketing', 'mcp__mem__recall_memory', 'mcp__planning__list_todos'],
    )

    service.middleware('session-1', buildPayload(message), () => {})

    const records = service.query({ sessionId: 'session-1' })
    expect(records.length).toBe(1)
    expect(records[0]?.skillIds).toContain('ma-marketing')
    expect(records[0]?.mcpServers).toContain('mem')
    expect(records[0]?.mcpServers).toContain('planning')
  })

  test('忽略 _partial 和缺失 usage 的消息', () => {
    const partialMessage = buildAssistantMessage(
      { input: 100, output: 20, totalTokens: 120 },
      ['Read'],
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(partialMessage as unknown as Record<string, unknown>)._partial = true
    const noUsageMessage = buildAssistantMessage({}, ['Read'])

    service.middleware('session-1', buildPayload(partialMessage), () => {})
    service.middleware('session-1', buildPayload(noUsageMessage), () => {})

    const records = service.query({ sessionId: 'session-1' })
    expect(records.length).toBe(0)
  })

  test('多轮消息递增 turnIndex', () => {
    service.middleware('session-1', buildPayload(buildAssistantMessage({ input: 100, output: 10, totalTokens: 110 }, ['Read'])), () => {})
    service.middleware('session-1', buildPayload(buildAssistantMessage({ input: 200, output: 20, totalTokens: 220 }, ['Bash'])), () => {})

    const records = service.query({ sessionId: 'session-1' }).sort((a, b) => a.turnIndex - b.turnIndex)
    expect(records.length).toBe(2)
    expect(records.map((r) => r.turnIndex)).toEqual([1, 2])
  })

  test('聚合统计按工具、Skill、MCP、模型和日期分组', () => {
    service.middleware(
      'session-1',
      buildPayload(
        buildAssistantMessage(
          { input: 1000, output: 200, totalTokens: 1200 },
          ['ma-marketing', 'mcp__mem__recall_memory'],
        ),
      ),
      () => {},
    )

    const aggregate = service.aggregate({})
    expect(aggregate.totalTokens).toBe(1200)
    expect(aggregate.byModel.some((item) => item.name === 'deepseek-v4-flash')).toBe(true)
    expect(aggregate.bySkill.some((item) => item.name === 'ma-marketing')).toBe(true)
    expect(aggregate.byMcpServer.some((item) => item.name === 'mem')).toBe(true)
    expect(aggregate.byDay.length).toBeGreaterThan(0)
  })

  test('清空所有记录', () => {
    service.middleware('session-1', buildPayload(buildAssistantMessage({ input: 100, output: 10, totalTokens: 110 }, ['Read'])), () => {})
    expect(service.query({}).length).toBe(1)

    service.clear()
    expect(service.query({}).length).toBe(0)
    expect(service.listSessions().length).toBe(0)
  })

  test('会话汇总列表', () => {
    service.middleware('session-1', buildPayload(buildAssistantMessage({ input: 1000, output: 200, totalTokens: 1200 }, ['Read'])), () => {})

    const sessions = service.listSessions()
    expect(sessions.length).toBe(1)
    expect(sessions[0]?.sessionId).toBe('session-1')
    expect(sessions[0]?.title).toBe('测试会话')
    expect(sessions[0]?.totalTokens).toBe(1200)
  })

  test('统一成本记账小账本 getCostMiniLedger（PH2-D）', () => {
    service.middleware('session-1', buildPayload(buildAssistantMessage({ input: 1000, output: 200, totalTokens: 1200, cost: { input: 0.001, output: 0.002, total: 0.003 } }, ['Read'])), () => {})
    service.middleware('session-2', buildPayload(buildAssistantMessage({ input: 500, output: 100, totalTokens: 600, cost: { input: 0.001, output: 0.001, total: 0.002 } }, ['Write'])), () => {})

    const ledger = service.getCostMiniLedger({ from: 0 })
    expect(ledger.totalTokens).toBe(1800)
    expect(ledger.totalCostUsd).toBeCloseTo(0.005, 5)
    expect(ledger.recordCount).toBe(2)
    expect(ledger.bySession.length).toBe(2)
    expect(ledger.byDay.length).toBeGreaterThan(0)
    // bySession 按费用降序：session-1(0.003) > session-2(0.002)
    expect(ledger.bySession[0]?.sessionId).toBe('session-1')
  })
})
