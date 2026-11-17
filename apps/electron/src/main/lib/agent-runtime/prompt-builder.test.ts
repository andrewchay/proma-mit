import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 不用 mock.module 替换审计服务——mock.module 是进程级的，会泄漏到同进程的
// 其他测试文件（context-compaction.test.ts 的审计断言会串味）。
// 改为每个测试用独立临时配置目录，靠环境变量隔离落盘。
const originalTestConfigDir = process.env.PROMA_TEST_CONFIG_DIR

const { buildElectronMock } = await import('../testing/electron-mock')
mock.module('electron', () => buildElectronMock())

const { sdkMessagesToChatMessages, __resetViewTruncationThrottle } = await import('./prompt-builder')

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'proma-prompt-builder-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
  __resetViewTruncationThrottle()
})

afterEach(async () => {
  if (originalTestConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalTestConfigDir
  await rm(tempDir, { recursive: true, force: true })
})

function makeHistory(count: number, sessionId: string) {
  return Array.from({ length: count }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    message: { content: [{ type: 'text', text: `消息 ${i}` }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: `m-${i}`,
  })) as never[]
}

async function readAuditEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(join(tempDir, 'context-compaction-audit', 'events.jsonl'), 'utf8')
    return raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

describe('视图层历史截断', () => {
  test('无 boundary 且超限时记录丢弃条数', async () => {
    sdkMessagesToChatMessages(makeHistory(100, 'view-1'))
    const events = await readAuditEvents()
    expect(events.length).toBe(1)
    const truncation = events[0]?.viewTruncation as { droppedMessages: number; reason: string } | undefined
    // 100 条历史只保留最近 MAX_HISTORY_MESSAGES(20) 条
    expect(truncation?.droppedMessages).toBe(80)
    expect(truncation?.reason).toBe('max_history_messages')
  })

  test('同一 session 60 秒内只记录一次', async () => {
    sdkMessagesToChatMessages(makeHistory(100, 'view-2'))
    sdkMessagesToChatMessages(makeHistory(100, 'view-2'))
    sdkMessagesToChatMessages(makeHistory(100, 'view-2'))
    expect((await readAuditEvents()).length).toBe(1)
  })

  test('历史未超限时不记录', async () => {
    sdkMessagesToChatMessages(makeHistory(5, 'view-3'))
    expect((await readAuditEvents()).length).toBe(0)
  })

  test('存在 compact_boundary 时归因于压缩边界，不记录视图截断', async () => {
    const history = makeHistory(100, 'view-4')
    history[0] = {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'view-4',
      summary: '交接摘要',
    } as never
    sdkMessagesToChatMessages(history)
    expect((await readAuditEvents()).length).toBe(0)
  })
})
