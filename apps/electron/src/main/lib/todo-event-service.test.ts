import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { recordTodoEvent, listTodoEvents } from './todo-event-service'

/**
 * PH2-A Todo 事件流测试：
 * - recordTodoEvent 落盘 + listTodoEvents 读回
 * - 按 memberId / action 过滤
 * 使用 PROMA_TEST_CONFIG_DIR 隔离。
 */

const testDir = join(tmpdir(), `gravitas-todoevent-test-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
  delete process.env.PROMA_TEST_CONFIG_DIR
})

describe('Todo 事件流（PH2-A）', () => {
  test('recordTodoEvent 落盘 + 读回', () => {
    recordTodoEvent({ source: 'project', action: 'created', todoId: 't-1', title: '实现登录页', memberId: 'agent-abc', assigneeName: '张三', projectId: 'p1' })
    const events = listTodoEvents()
    expect(events.some((e) => e.todoId === 't-1' && e.action === 'created' && e.memberId === 'agent-abc')).toBe(true)
  })

  test('按 memberId 过滤', () => {
    recordTodoEvent({ source: 'project', action: 'completed', todoId: 't-2', title: '修 bug', memberId: 'agent-xyz' })
    const mine = listTodoEvents({ memberId: 'agent-xyz' })
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((e) => e.memberId === 'agent-xyz')).toBe(true)
  })

  test('按 action 过滤', () => {
    recordTodoEvent({ source: 'project', action: 'assigned', todoId: 't-3', title: '评审', memberId: 'agent-abc' })
    const assigns = listTodoEvents({ action: 'assigned' })
    expect(assigns.every((e) => e.action === 'assigned')).toBe(true)
  })
})
