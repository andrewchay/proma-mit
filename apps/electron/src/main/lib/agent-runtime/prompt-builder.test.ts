import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'

// 内存版审计收集器：隔离真实 ~/.gravitas 落盘。
// 背景：审计服务在模块加载时解析配置目录，用临时目录也会受 import 顺序影响。
const auditEvents: Array<Record<string, unknown>> = []
mock.module('../context-compaction-audit-service', () => ({
  appendContextCompactionAudit: (input: Record<string, unknown>): void => {
    auditEvents.push(input)
  },
  getContextCompactionMetrics: async () => ({ total: auditEvents.length, byRuntime: [], byTrigger: [] }),
}))

const { buildElectronMock } = await import('../testing/electron-mock')
mock.module('electron', () => buildElectronMock())

const { sdkMessagesToChatMessages, __resetViewTruncationThrottle } = await import('./prompt-builder')

function makeHistory(count: number, sessionId: string) {
  return Array.from({ length: count }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    message: { content: [{ type: 'text', text: `消息 ${i}` }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: `m-${i}`,
  })) as never[]
}

describe('视图层历史截断', () => {
  beforeEach(() => {
    auditEvents.length = 0
    __resetViewTruncationThrottle()
  })

  afterEach(() => {
    auditEvents.length = 0
  })

  test('无 boundary 且超限时记录丢弃条数', () => {
    sdkMessagesToChatMessages(makeHistory(100, 'view-1'))
    expect(auditEvents.length).toBe(1)
    const truncation = auditEvents[0]?.viewTruncation as { droppedMessages: number; reason: string } | undefined
    // 100 条历史只保留最近 MAX_HISTORY_MESSAGES(20) 条
    expect(truncation?.droppedMessages).toBe(80)
    expect(truncation?.reason).toBe('max_history_messages')
  })

  test('同一 session 60 秒内只记录一次', () => {
    sdkMessagesToChatMessages(makeHistory(100, 'view-2'))
    sdkMessagesToChatMessages(makeHistory(100, 'view-2'))
    sdkMessagesToChatMessages(makeHistory(100, 'view-2'))
    expect(auditEvents.length).toBe(1)
  })

  test('历史未超限时不记录', () => {
    sdkMessagesToChatMessages(makeHistory(5, 'view-3'))
    expect(auditEvents.length).toBe(0)
  })

  test('存在 compact_boundary 时归因于压缩边界，不记录视图截断', () => {
    const history = makeHistory(100, 'view-4')
    history[0] = {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'view-4',
      summary: '交接摘要',
    } as never
    sdkMessagesToChatMessages(history)
    expect(auditEvents.length).toBe(0)
  })
})
