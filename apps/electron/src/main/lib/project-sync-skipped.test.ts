import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 「负责人不在名单 → 跳过外部同步、不入 outbox」行为测试（BDD）：
 *
 * 背景：syncTaskToExternal 查不到用户映射且成员目录反查不到时，
 * 旧实现返回普通失败 → syncCreatedTask 入队 outbox → 界面堆积
 * 「已尝试 0 次 · 未找到 feishu 用户映射」的永不可能成功的重试噪音。
 *
 * 期望：
 * - assignee 不在飞书/钉钉名单 → syncTaskToExternal 返回 skipped=true，
 *   syncCreatedTask 不写 outbox（静默跳过）
 * - assignee 在成员名单（成员目录可反查）→ 正常创建外部 Todo 并回写 externalSync
 *
 * 隔离：PROMA_TEST_CONFIG_DIR 指向临时目录，不污染真实 ~/.proma-mit/projects/。
 */

const testDir = join(tmpdir(), `proma-sync-skipped-test-${Date.now()}`)

// agent-employee-service 顶层 import BrowserWindow from 'electron'，bun 环境加载失败；
// 用替身替掉（本测试只走真人 assignee 分支，isAgentAssignee 恒 false）
await mock.module('./agent-employee-service.ts', () => ({
  isAgentAssignee: () => false,
  dispatchTaskToAgent: async () => undefined,
  dispatchTaskToAgentIfIdle: async () => undefined,
}))

const { initProjectDb, closeProjectDb, listDingTalkTodoRetries } =
  await import('./project-sqlite-store')
const { saveUserMapping, getUserMapping } = await import('./project-service')
const { upsertMemberDraft } = await import('./member-sync-service')
const { syncTaskToExternal, registerTodoProvider, unregisterTodoProvider } = await import('./project-sync-service')
const { registerProjectAutoSync, stopProjectAutoSync } = await import('./project-auto-sync')

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  mkdirSync(join(testDir, 'projects'), { recursive: true })
  await initProjectDb()
})

afterAll(() => {
  stopProjectAutoSync()
  closeProjectDb()
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略清理失败
  }
  delete process.env.PROMA_TEST_CONFIG_DIR
})

/** 最小 TodoProvider 桩：记录 createTodo 调用，返回自增 taskId */
function makeStubProvider(name: 'feishu' | 'dingtalk') {
  const calls: Array<{ taskId: string; userId: string }> = []
  const provider = {
    name,
    async createTodo(task: { id: string }, userId: string) {
      calls.push({ taskId: task.id, userId })
      return { taskId: `ext-${name}-${calls.length}`, status: 'open' }
    },
    async updateTodoStatus() {
      return true
    },
    async queryTodoStatus() {
      return null
    },
    async getUserIdByPaaUserId() {
      return null
    },
  }
  return { provider, calls }
}

describe('负责人不在名单：跳过外部同步，不入 outbox', () => {
  test('assignee 无映射且不在成员目录 → syncTaskToExternal 返回 skipped，outbox 不新增事件', async () => {
    const { createProject: cp } = await import('./project-service')
    const project = await cp({ title: '跳过测试', description: '' })

    // 单元层：直接断言 skipped 标记
    const { provider, calls } = makeStubProvider('feishu')
    registerTodoProvider(provider)
    const { createTask: ct } = await import('./project-service')
    const task = await ct(project.id, {
      title: '任务-陌生人',
            description: '',
            assignee: { userId: 'paa-路人甲', displayName: '路人甲' },
    })
    const result = await syncTaskToExternal(task, 'feishu', provider)
    expect(result.skipped).toBe(true)
    expect(result.success).toBe(false)
    expect(calls.length).toBe(0) // 未触达 provider

    // 集成层：auto-sync 监听 'created' 事件，outbox 不应新增任何 create_todo 事件
    const before = listDingTalkTodoRetries(project.id)
    registerProjectAutoSync()
    const task2 = await ct(project.id, {
      title: '任务-陌生人2',
      description: '',
      assignee: { userId: 'paa-路人乙', displayName: '路人乙' },
    })
    expect(task2).not.toBeNull()
    // 等异步 syncCreatedTask 落定
    await new Promise((r) => setTimeout(r, 100))
    const after = listDingTalkTodoRetries(project.id)
    expect(after.length).toBe(before.length)
    expect(calls.length).toBe(0) // 两次同步均未触达 provider
    unregisterTodoProvider('feishu')
    // 测试隔离：停掉本用例注册的监听器/定时器，避免影响后续用例的调用计数
    stopProjectAutoSync()
  })

  test('assignee 在成员目录（可反查）→ 正常同步并回写 externalSync', async () => {
    upsertMemberDraft({ platform: 'feishu', externalId: 'ou_member_1', name: '张三' })

    const { provider, calls } = makeStubProvider('feishu')
    registerTodoProvider(provider)
    const { createProject: cp, createTask: ct } = await import('./project-service')
    const project = await cp({ title: '正常同步测试', description: '' })
    const task = await ct(project.id, {
      title: '任务-张三',
            description: '',
            assignee: { userId: 'paa-张三', displayName: '张三' },
    })

    const result = await syncTaskToExternal(task, 'feishu', provider)
    expect(result.success).toBe(true)
    expect(result.skipped).toBeUndefined()
    expect(calls.length).toBe(1)
    expect(calls[0]?.userId).toBe('ou_member_1') // 成员目录反查兜底生效

    const updated = await import('./project-service').then((m) => m.getTask(task.id))
    expect(updated?.externalSync?.feishu?.taskId).toBe('ext-feishu-1')
    unregisterTodoProvider('feishu')
  })

  test('有用户映射 → 优先用映射的 feishuUserId', async () => {
    await saveUserMapping({
      paaUserId: 'paa-李四',
      displayName: '李四',
      feishuUserId: 'ou_mapping_4',
    })
    expect((await getUserMapping('paa-李四'))?.feishuUserId).toBe('ou_mapping_4')

    const { provider, calls } = makeStubProvider('feishu')
    registerTodoProvider(provider)
    const { createProject: cp, createTask: ct } = await import('./project-service')
    const project = await cp({ title: '映射测试', description: '' })
    const task = await ct(project.id, {
      title: '任务-李四',
            description: '',
            assignee: { userId: 'paa-李四', displayName: '李四' },
    })

    const result = await syncTaskToExternal(task, 'feishu', provider)
    expect(result.success).toBe(true)
    expect(calls[0]?.userId).toBe('ou_mapping_4')
    unregisterTodoProvider('feishu')
  })
})
