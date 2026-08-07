import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { initProjectDb, closeProjectDb, createProject, createTask } from '../../project-sqlite-store'
import { executeTodoContextTool } from './todo-context-tool'
import type { ToolContext } from '../types'

/**
 * PH2-A Agent 解压缩工具测试：
 * - executeTodoContextTool 返回 Todo 的完整上下文（含同项目相关待办）
 * - 不存在返回错误
 * 使用 PROMA_TEST_CONFIG_DIR 隔离。
 */

const testDir = join(tmpdir(), `gravitas-todocontext-test-${Date.now()}`)
const mockCtx = { cwd: '/tmp', sessionId: 's-1' } as ToolContext

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

describe('Todo 解压缩工具（PH2-A）', () => {
  test('返回目标 Todo 完整上下文 + 同项目相关待办', async () => {
    const project = createProject({ title: '项目A', description: '' })
    const task = createTask(project.id, {
      title: '实现登录页',
      description: '支持邮箱登录，含验证码',
      assignee: { userId: 'agent-abc', displayName: 'AI前端' },
      dueDate: Date.now() + 86400000,
    })
    createTask(project.id, { title: '实现权限中间件', description: '鉴权' })

    const res = await executeTodoContextTool({ todoId: task.id }, mockCtx)
    expect(res.isError).not.toBe(true)
    expect(String(res.content)).toContain('实现登录页')
    expect(String(res.content)).toContain('支持邮箱登录')
    expect(String(res.content)).toContain('AI前端')
    // 同项目相关进行中待办
    expect(String(res.content)).toContain('实现权限中间件')
  })

  test('不存在返回错误', async () => {
    const res = await executeTodoContextTool({ todoId: 'not-exist' }, mockCtx)
    expect(res.isError).toBe(true)
    expect(String(res.content)).toContain('未找到待办')
  })

  test('缺 todoId 返回参数错误', async () => {
    const res = await executeTodoContextTool({}, mockCtx)
    expect(res.isError).toBe(true)
  })
})
