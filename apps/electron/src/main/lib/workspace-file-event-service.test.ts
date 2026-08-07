import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { initProjectDb, closeProjectDb, createAgentEmployee, createAgentExecution } from './project-sqlite-store'
import { recordFileEvent, listFileEvents } from './workspace-file-event-service'

/**
 * PH2-A 工作区文件共享事件流测试：
 * - recordFileEvent 落盘 JSONL
 * - memberId 归因（AI 员工会话）
 * - listFileEvents 按 memberId/action 过滤
 * 使用 PROMA_TEST_CONFIG_DIR 隔离。
 */

const testDir = join(tmpdir(), `gravitas-fileevent-test-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  await initProjectDb()
})

afterAll(() => {
  closeProjectDb()
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
  delete process.env.PROMA_TEST_CONFIG_DIR
})

describe('工作区文件共享事件流（PH2-A）', () => {
  test('recordFileEvent 落盘 + listFileEvents 读回', () => {
    recordFileEvent('sess-x', 'write', 'notes/a.md', 'ws-1')
    const events = listFileEvents()
    expect(events.length).toBeGreaterThan(0)
    expect(events.some((e) => e.filePath === 'notes/a.md' && e.action === 'write')).toBe(true)
  })

  test('AI 员工会话写入文件 → memberId=agent-<id> 归因', () => {
    const agent = createAgentEmployee({ name: '文件AI', role: '测试', description: 'x', channelId: 'ch1' })
    const sessionId = `file-session-${Date.now()}`
    createAgentExecution({ id: `file-exec-${Date.now()}`, projectId: 'p1', entityType: 'task', entityId: 't1', agentId: agent.id, sessionId, prompt: '测试' })
    recordFileEvent(sessionId, 'edit', 'src/App.tsx', 'ws-1')
    const events = listFileEvents({ memberId: `agent-${agent.id}` })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.memberId === `agent-${agent.id}`)).toBe(true)
  })

  test('按 action 过滤', () => {
    const before = listFileEvents({ action: 'write' })
    const allWrite = before.length === 0 || before.every((e) => e.action === 'write')
    expect(allWrite).toBe(true)
  })
})
