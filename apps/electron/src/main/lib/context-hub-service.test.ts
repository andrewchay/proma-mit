import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { getEntityGraph, graphToText } from './context-hub-service'
import { getRunStore } from './run-store'
import { recordTodoEvent } from './todo-event-service'
import { recordFileEvent } from './workspace-file-event-service'
import { initProjectDb, closeProjectDb } from './project-sqlite-store'

/**
 * PH2-D Context Hub / Work Graph 测试。
 * 用 PROMA_TEST_CONFIG_DIR 隔离，seed run/todo/file 事件后验证关联发现。
 * 注：file-event 的 memberId 依赖 resolveMemberForSession（需 DB），纯事件 seed 时为空，
 *     因此 file-event 关联按 sessionId 断言。
 */

const testDir = join(tmpdir(), `gravitas-contexthub-test-${Date.now()}`)

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

describe('Context Hub / Work Graph（PH2-D）', () => {
  test('从成员发现相关运行 + Todo', () => {
    const memberId = 'agent-abc'
    const sessionId = 'sess-x'
    getRunStore().record({ id: 'r-1', type: 'completed', source: 'agent', taskId: sessionId, title: '实现登录', sessionId, memberId, timestamp: Date.now() })
    recordTodoEvent({ source: 'project', action: 'completed', todoId: 't-1', title: '修复登录 bug', memberId })

    const graph = getEntityGraph('member', memberId)
    expect(graph).not.toBeNull()
    expect(graph!.related.some((n) => n.type === 'run')).toBe(true)
    expect(graph!.related.some((n) => n.type === 'todo_event')).toBe(true)

    const text = graphToText(graph!)
    expect(text).toContain('AI 员工')
  })

  test('从会话发现相关运行 + 文件事件（按 sessionId 关联）', () => {
    const sessionId = 'sess-y'
    getRunStore().record({ id: 'r-2', type: 'completed', source: 'agent', taskId: sessionId, title: '修复接口', sessionId, timestamp: Date.now() })
    recordFileEvent(sessionId, 'write', 'src/api.ts', 'ws-1')

    const graph = getEntityGraph('session', sessionId)
    expect(graph).not.toBeNull()
    expect(graph!.related.some((n) => n.type === 'run')).toBe(true)
    expect(graph!.related.some((n) => n.type === 'file_event')).toBe(true)
  })

  test('无关联时相关为空', () => {
    const graph = getEntityGraph('member', 'agent-z')
    expect(graph).not.toBeNull()
    expect(graph!.related.length).toBe(0)
  })

  test('按成员展示名解析（“Andrew”→ paa-<名> 找到其 Todo）', () => {
    // 真人成员 Andrew 的待办（memberId=paa-Andrew）
    const { upsertMemberDraft } = require('./member-sync-service')
    upsertMemberDraft({ platform: 'feishu', externalId: 'ou-andrew', name: 'Andrew' })
    const { recordTodoEvent } = require('./todo-event-service')
    recordTodoEvent({ source: 'project', action: 'created', todoId: 't-andrew', title: '交付 Q3 报告', memberId: 'paa-Andrew' })

    const graph = getEntityGraph('member', 'Andrew')
    expect(graph).not.toBeNull()
    expect(graph!.related.some((n) => n.type === 'todo_event')).toBe(true)
  })
})
