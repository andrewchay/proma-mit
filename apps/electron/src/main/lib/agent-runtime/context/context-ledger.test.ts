import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ContextLedgerStore,
  recordArtifact,
  recordSessionMessage,
  recordToolObservation,
} from './context-ledger'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createTestDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gravitas-context-ledger-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('ContextLedgerStore', () => {
  test('追加工具观察时将原文和摘要写入独立 JSONL，并能读取完整 item', () => {
    const directory = createTestDirectory()
    const store = new ContextLedgerStore(directory)

    const summary = '读取了上下文压缩工具常量。'
    const item = recordToolObservation(store, {
      eventId: 'tool-call-1',
      sessionId: 'session-1',
      toolName: 'Read',
      result: 'export const COMPACT_CONTEXT_TOOL_NAME = \'CompactContext\'',
      summary,
      createdAt: '2026-09-22T07:40:00.000Z',
    })

    expect(store.list({ sessionId: 'session-1' })).toEqual([item])
    const ledgerRecord = JSON.parse(readFileSync(join(directory, 'ledger.jsonl'), 'utf8')) as { item: { content: string, summary?: string } }
    const summaryRecord = JSON.parse(readFileSync(join(directory, 'summaries.jsonl'), 'utf8')) as { summary: string }
    expect(ledgerRecord.item.content).toBe(item.content)
    expect(ledgerRecord.item.summary).toBeUndefined()
    expect(summaryRecord.summary).toBe(summary)
    expect(store.sourceRevision()).toMatch(/^sha256:/)
  })

  test('将用户消息记录为可验证的 user_intent，助手消息记录为未验证 task_state', () => {
    const store = new ContextLedgerStore(createTestDirectory())

    const userItem = recordSessionMessage(store, {
      eventId: 'message-user-1',
      sessionId: 'session-1',
      role: 'user',
      content: '请检查上下文压缩实现。',
      createdAt: '2026-09-22T07:40:00.000Z',
    })
    const assistantItem = recordSessionMessage(store, {
      eventId: 'message-assistant-1',
      sessionId: 'session-1',
      role: 'assistant',
      content: '我会先读取实现。',
      createdAt: '2026-09-22T07:41:00.000Z',
    })

    expect(userItem.kind).toBe('user_intent')
    expect(userItem.evidence[0]?.verified).toBe(true)
    expect(assistantItem.kind).toBe('task_state')
    expect(assistantItem.confidence).toBe('unknown')
    expect(assistantItem.evidence[0]?.verified).toBe(false)
  })

  test('将 Agent artifact 记录为独立的可追溯产物', () => {
    const store = new ContextLedgerStore(createTestDirectory())
    const artifact = recordArtifact(store, {
      artifactId: 'artifact-1',
      sourceEventId: 'message-assistant-1',
      sessionId: 'session-1',
      title: '上下文压缩实施建议',
      content: '先建立可逆 context ledger。',
      createdAt: '2026-09-22T07:42:00.000Z',
    })

    expect(artifact.kind).toBe('artifact')
    expect(artifact.source.kind).toBe('agent_artifact')
    expect(artifact.evidence[0]?.sourceId).toBe('message-assistant-1')
  })

  test('同一来源和版本重复记录不会追加第二份事实', () => {
    const store = new ContextLedgerStore(createTestDirectory())
    const input = {
      eventId: 'tool-call-1',
      sessionId: 'session-1',
      toolName: 'Read',
      result: '内容',
      createdAt: '2026-09-22T07:40:00.000Z',
    }

    const first = recordToolObservation(store, input)
    const second = recordToolObservation(store, input)

    expect(second).toEqual(first)
    expect(store.list()).toHaveLength(1)
  })

  test('损坏的 JSONL 行不阻止读取其他已记录事实', () => {
    const directory = createTestDirectory()
    const store = new ContextLedgerStore(directory)
    recordToolObservation(store, {
      eventId: 'tool-call-1',
      sessionId: 'session-1',
      toolName: 'Read',
      result: '内容',
      createdAt: '2026-09-22T07:40:00.000Z',
    })
    appendFileSync(join(directory, 'ledger.jsonl'), '{not-json}\n', 'utf8')

    expect(store.list()).toHaveLength(1)
  })
})
