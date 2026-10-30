import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetUnknownActionCacheForTest,
  listPendingUnknownActions,
  recordUnknownAction,
} from '../unknown-action-store'
import { executeListUnknownActionsTool, executeResolveUnknownActionTool } from './unknown-action-tools'

const SESSION = 'unknown-tools-session'
const ACTION_KEY = 'computer-use:click:10,20@primary'

function ctxWith(answer: string | undefined, behavior: 'allow' | 'deny' = 'allow') {
  const askCalls: Record<string, unknown>[] = []
  const ctx = {
    cwd: '/tmp',
    sessionId: SESSION,
    abortSignal: new AbortController().signal,
    onAskUser: async (input: Record<string, unknown>) => {
      askCalls.push(input)
      if (behavior === 'deny') return { behavior: 'deny' as const, message: '用户取消' }
      const questions = (input.questions ?? []) as { question: string }[]
      return { behavior: 'allow' as const, answers: { [questions[0]?.question ?? '']: answer ?? '' } }
    },
  }
  return { ctx, askCalls }
}

async function seed() {
  await recordUnknownAction({
    sessionId: SESSION,
    tool: 'ComputerUseClick',
    actionKey: ACTION_KEY,
    detail: { x: 10, y: 20 },
    reason: 'operation timed out',
  })
}

const directory = mkdtempSync(join(tmpdir(), 'unknown-action-tools-'))
const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = directory
  await (await import('../../project-sqlite-store')).initProjectDb()
})

afterAll(async () => {
  (await import('../../project-sqlite-store')).closeProjectDb()
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  rmSync(directory, { recursive: true, force: true })
})

beforeEach(() => {
  __resetUnknownActionCacheForTest()
})

describe('查看未知动作', () => {
  test('Given 本会话有未知动作 When 列出 Then 只读返回指纹与理由', async () => {
    await seed()
    const result = await executeListUnknownActionsTool({}, { cwd: '/tmp', sessionId: SESSION })
    const payload = JSON.parse(result.content)
    expect(payload.count).toBe(1)
    expect(payload.actions[0].actionKey).toBe(ACTION_KEY)
    expect(payload.actions[0].reason).toContain('timed out')
    expect(result.isError).toBeFalsy()
  })

  test('Given 其他会话有未知动作 When 列出 Then 不返回', async () => {
    await seed()
    const result = await executeListUnknownActionsTool({}, { cwd: '/tmp', sessionId: 'other-session' })
    expect(JSON.parse(result.content).count).toBe(0)
  })
})

describe('解除未知动作', () => {
  test('Given 缺少 action_key When 解除 Then 拒绝且不询问用户', async () => {
    const { ctx, askCalls } = ctxWith('已核对：动作没有生效，允许重试')
    const result = await executeResolveUnknownActionTool({}, ctx)
    expect(result.isError).toBe(true)
    expect(askCalls).toHaveLength(0)
  })

  test('Given 没有用户确认通道 When 解除 Then 拒绝而不是放行', async () => {
    await seed()
    const result = await executeResolveUnknownActionTool({ action_key: ACTION_KEY }, { cwd: '/tmp', sessionId: SESSION })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('必须经过用户确认')
    expect((await listPendingUnknownActions(SESSION)).length).toBe(1)
  })

  test('Given 指纹不存在 When 解除 Then 提示没有待处理项', async () => {
    const { ctx } = ctxWith('已核对：动作没有生效，允许重试')
    const result = await executeResolveUnknownActionTool({ action_key: 'computer-use:click:1,1@primary' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('没有找到待处理的未知动作')
  })

  test('Given 用户确认动作没生效 When 解除 Then 放行并标记可重试', async () => {
    await seed()
    const { ctx, askCalls } = ctxWith('已核对：动作没有生效，允许重试')
    const result = await executeResolveUnknownActionTool({ action_key: ACTION_KEY }, ctx)
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content)).toMatchObject({ resolved: true, mayRetry: true })
    expect(askCalls).toHaveLength(1)
    expect((await listPendingUnknownActions(SESSION)).length).toBe(0)
  })

  test('Given 用户确认动作已生效 When 处理 Then 持久化结论且仍拦截重复动作', async () => {
    await seed()
    const { ctx } = ctxWith('已核对：动作已生效，不要重试')
    const result = await executeResolveUnknownActionTool({ action_key: ACTION_KEY }, ctx)
    const payload = JSON.parse(result.content)
    expect(payload).toMatchObject({ acknowledged: true, mayRetry: false })
    __resetUnknownActionCacheForTest()
    const records = await listPendingUnknownActions(SESSION)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ resolution: '已核对：动作已生效，不要重试｜用户确认' })
    expect(records[0]?.acknowledgedAt).toBeString()
    const listed = await executeListUnknownActionsTool({}, { cwd: '/tmp', sessionId: SESSION })
    expect(JSON.parse(listed.content).actions[0]).toMatchObject({
      resolution: '已核对：动作已生效，不要重试｜用户确认',
      acknowledgedAt: records[0]?.acknowledgedAt,
    })
  })

  test('Given 用户确认期间出现新未知动作 When 确认旧动作 Then 不解除新记录', async () => {
    await seed()
    const ctx = {
      cwd: '/tmp', sessionId: SESSION, abortSignal: new AbortController().signal,
      onAskUser: async (input: Record<string, unknown>) => {
        const questions = (input.questions ?? []) as { question: string }[]
        await recordUnknownAction({ sessionId: SESSION, tool: 'ComputerUseClick', actionKey: ACTION_KEY, reason: 'new failure' })
        return { behavior: 'allow' as const, answers: { [questions[0]?.question ?? '']: '已核对：动作没有生效，允许重试' } }
      },
    }
    const result = await executeResolveUnknownActionTool({ action_key: ACTION_KEY }, ctx)
    expect(result.isError).toBe(true)
    expect((await listPendingUnknownActions(SESSION))[0]?.reason).toBe('new failure')
  })

  test('Given 用户选择暂不处理 When 解除 Then 保持拦截', async () => {
    await seed()
    const { ctx } = ctxWith('暂不处理')
    const result = await executeResolveUnknownActionTool({ action_key: ACTION_KEY }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('未解除')
    expect((await listPendingUnknownActions(SESSION)).length).toBe(1)
  })

  test('Given 用户直接拒绝确认 When 解除 Then 保持拦截', async () => {
    await seed()
    const { ctx } = ctxWith(undefined, 'deny')
    const result = await executeResolveUnknownActionTool({ action_key: ACTION_KEY }, ctx)
    expect(result.isError).toBe(true)
    expect((await listPendingUnknownActions(SESSION)).length).toBe(1)
  })

  test('Given 用户确认请求抛错 When 解除 Then 保持拦截并说明失败', async () => {
    await seed()
    const ctx = {
      cwd: '/tmp',
      sessionId: SESSION,
      abortSignal: new AbortController().signal,
      onAskUser: async () => { throw new Error('界面已关闭') },
    }
    const result = await executeResolveUnknownActionTool({ action_key: ACTION_KEY }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('界面已关闭')
    expect((await listPendingUnknownActions(SESSION)).length).toBe(1)
  })
})
