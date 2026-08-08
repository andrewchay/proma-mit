import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { FeishuTodoProvider } from './feishu-todo-provider'

/**
 * 锁定 FeishuTodoProvider 对外请求的 URL / 请求体结构，防止回归。
 *
 * 背景：飞书 Task v2 更新接口 PATCH /open-apis/task/v2/tasks/:id
 * 请求体必须是 { task: {...}, update_fields: [...] }（task 包裹层）。
 * 若直接平铺字段，飞书会返回 "Invalid Param 'task', must not be empty."（code 1470400）。
 */

interface CapturedCall {
  url: string
  method: string
  body?: Record<string, unknown>
}

const calls: CapturedCall[] = []
const originalFetch = globalThis.fetch

function installFetchMock(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const method = init?.method ?? 'GET'
    const bodyText = init?.body ? String(init.body) : undefined
    calls.push({ url, method, body: bodyText ? JSON.parse(bodyText) : undefined })

    // 换取 tenant_access_token
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      const payload = { code: 0, tenant_access_token: 'test-token', expire: 7200 }
      return { ok: true, json: async () => payload, text: async () => JSON.stringify(payload) } as Response
    }
    // 创建任务返回 task.guid
    if (method === 'POST' && url.includes('/open-apis/task/v2/tasks')) {
      const payload = { code: 0, data: { task: { guid: 'created-guid-123' } } }
      return { ok: true, json: async () => payload, text: async () => JSON.stringify(payload) } as Response
    }
    // 其余业务接口默认成功
    const okPayload = { code: 0, data: {} }
    return { ok: true, json: async () => okPayload, text: async () => JSON.stringify(okPayload) } as Response
  }) as typeof fetch
}

beforeAll(() => installFetchMock())
afterAll(() => {
  globalThis.fetch = originalFetch
})

describe('FeishuTodoProvider.createTodo', () => {
  test('必须用 members(role=assignee) 设置负责人，而非 assignee 顶级字段（防飞书 Todo 不显示）', async () => {
    calls.length = 0
    const provider = new FeishuTodoProvider({ appId: 'test-app-create', appSecret: 'secret' })
    await provider.createTodo(
      { id: 't1', title: '任务标题', description: 'desc', assignee: { userId: 'u1', displayName: 'x' } } as never,
      'ou_9734c7c3ed1d687d47bae37eeda893a8',
    )

    const createCall = calls.find((c) => c.method === 'POST' && c.url.includes('/open-apis/task/v2/tasks'))
    expect(createCall).toBeDefined()
    // 负责人必须放在 members 里，role='assignee'；不能有顶层 assignee 字段
    expect(createCall!.body!.members).toEqual([{ id: 'ou_9734c7c3ed1d687d47bae37eeda893a8', role: 'assignee' }])
    expect(createCall!.body!.assignee).toBeUndefined()
    // 请求路径需带 user_id_type=open_id，与 open_id 格式的 feishuUserId 呼应
    expect(createCall!.url).toContain('user_id_type=open_id')
  })
})

describe('FeishuTodoProvider.updateTodoStatus', () => {
  test('非 completed 状态：PATCH 请求体必须带 task 包裹层（防 1470400 回归）', async () => {
    calls.length = 0
    const provider = new FeishuTodoProvider({ appId: 'test-app-patch', appSecret: 'secret' })
    await provider.updateTodoStatus('guid-123', 'pending')

    const patchCall = calls.find((c) => c.method === 'PATCH')
    expect(patchCall).toBeDefined()
    expect(patchCall!.url).toContain('/open-apis/task/v2/tasks/guid-123')
    expect(patchCall!.body).toHaveProperty('task')
    // update_fields 列出 completed_at，task 内不给新值 = 清空（恢复未完成）
    expect(patchCall!.body!.update_fields).toEqual(['completed_at'])
    expect(patchCall!.body!.task).toEqual({})
  })

  test('completed 状态：走 POST .../complete 接口', async () => {
    calls.length = 0
    const provider = new FeishuTodoProvider({ appId: 'test-app-complete', appSecret: 'secret' })
    await provider.updateTodoStatus('guid-456', 'completed')

    const completeCall = calls.find((c) => c.url.includes('/complete'))
    expect(completeCall).toBeDefined()
    expect(completeCall!.method).toBe('POST')
  })
})
