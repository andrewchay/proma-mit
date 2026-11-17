/**
 * 事件路由器测试：去重 / 规则匹配 / 分组并发 / tell 通知 / 规则文件读写
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EventRouter,
  readEventRules,
  writeEventRules,
  validateEventRule,
  defaultEventRulesFile,
  type AgentAutomationEvent,
  type WorkflowEventExecutor,
  type OwnerGoalWakeExecutor,
} from './event-router-service'

function makeEvent(overrides: Partial<AgentAutomationEvent> = {}): AgentAutomationEvent {
  return {
    source: '飞书',
    type: 'im.message',
    target: 'chat-1',
    summary: '同事提了一条新意见',
    payload: { text: '修一下分页' },
    ...overrides,
  }
}

describe('事件路由器', () => {
  let dir: string
  let rulesPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-router-'))
    rulesPath = join(dir, 'event-rules.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRouter(executor?: WorkflowEventExecutor): EventRouter {
    const router = new EventRouter(executor)
    router.setRulesPath(rulesPath)
    return router
  }

  test('无规则文件时 dispatch 返回 no_rule 且零副作用', async () => {
    const router = makeRouter(async () => [])
    const outcomes = await router.dispatch(makeEvent())
    expect(outcomes).toEqual([{ ruleName: '', status: 'no_rule' }])
    expect(existsSync(rulesPath)).toBe(false)
  })

  test('规则命中 workflow-event：转发事件名与携带 __event 的载荷', async () => {
    const calls: Array<{ eventName: string; payload: Record<string, unknown> }> = []
    const router = makeRouter(async (eventName, payload) => {
      calls.push({ eventName, payload })
      return [{ id: 'run-1' } as never]
    })
    writeEventRules(
      [{ name: '意见', when: { source: '飞书', types: ['im.message'] }, to: { kind: 'workflow-event', eventName: 'feedback.new' } }],
      rulesPath,
    )
    const outcomes = await router.dispatch(makeEvent())
    expect(outcomes).toEqual([{ ruleName: '意见', status: 'matched', detail: expect.stringContaining('1 个 Workflow Run') }])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.eventName).toBe('feedback.new')
    expect((calls[0]!.payload.__event as Record<string, unknown>).source).toBe('飞书')
    expect(calls[0]!.payload.text).toBe('修一下分页')
  })

  test('同一 dedupeKey 窗口内只放行一次（跨规则共享去重）', async () => {
    let calls = 0
    const router = makeRouter(async () => {
      calls++
      return []
    })
    writeEventRules(
      [
        { name: '规则A', when: { types: ['im.message'] }, to: { kind: 'workflow-event', eventName: 'e' } },
        { name: '规则B', when: { types: ['im.message'] }, to: { kind: 'workflow-event', eventName: 'e' } },
      ],
      rulesPath,
    )
    await router.dispatch(makeEvent())
    // 单次 dispatch 命中两条规则各执行一次；去重挡的是下一次 dispatch
    expect(calls).toBe(2)
    const second = await router.dispatch(makeEvent({ occurredAt: Date.now() + 1 }))
    expect(calls).toBe(2)
    expect(second).toHaveLength(2)
    expect(second.every((o) => o.status === 'duplicate')).toBe(true)
  })

  test('窗口过期后同一指纹可再次放行', async () => {
    let calls = 0
    const router = makeRouter(async () => {
      calls++
      return []
    })
    router.setDedupeWindowMs(50)
    writeEventRules([{ name: 'R', when: { types: ['im.message'] }, to: { kind: 'workflow-event', eventName: 'e' } }], rulesPath)
    await router.dispatch(makeEvent(), 1_000)
    await router.dispatch(makeEvent(), 1_020)
    await router.dispatch(makeEvent(), 1_100)
    expect(calls).toBe(2)
  })

  test('dedupeKey 缺省为 source:type:target，target 不同不去重', async () => {
    let calls = 0
    const router = makeRouter(async () => {
      calls++
      return []
    })
    writeEventRules([{ name: 'R', when: { types: ['im.message'] }, to: { kind: 'workflow-event', eventName: 'e' } }], rulesPath)
    await router.dispatch(makeEvent({ target: 'chat-1' }))
    await router.dispatch(makeEvent({ target: 'chat-2' }))
    expect(calls).toBe(2)
  })

  test('同 group 超过 parallel 上限被限流', async () => {
    let inflight = 0
    let peak = 0
    const router = makeRouter(async () => {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise((resolve) => setTimeout(resolve, 30))
      inflight--
      return []
    })
    writeEventRules(
      [{ name: '意见处理', when: { types: ['feedback.new'] }, to: { kind: 'log' }, group: 'feedback', parallel: 2 }],
      rulesPath,
    )
    // dedupeKey 显式指定，只受并发门约束
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) => router.dispatch(makeEvent({ type: 'feedback.new', dedupeKey: `fb-${i}` }))),
    )
    const limited = results.flat().filter((o) => o.status === 'concurrency_limited')
    expect(limited.length).toBeGreaterThanOrEqual(1)
    expect(peak).toBeLessThanOrEqual(2)
  })

  test('tell=needed：成功不打扰、失败必通知；always 总是通知', async () => {
    const notified: Array<{ ruleName: string; ok: boolean }> = []
    const failing = makeRouter(async () => {
      throw new Error('boom')
    })
    failing.setNotifyHandler((m) => notified.push({ ruleName: m.ruleName, ok: m.ok }))
    writeEventRules([{ name: '会炸', when: { types: ['x'] }, to: { kind: 'workflow-event', eventName: 'e' } }], rulesPath)
    const outcomes = await failing.dispatch(makeEvent({ type: 'x' }))
    expect(outcomes[0]!.status).toBe('failed')
    expect(notified).toEqual([{ ruleName: '会炸', ok: false }])

    const succeeding = makeRouter(async () => [])
    const silentNotified: unknown[] = []
    succeeding.setNotifyHandler((m) => silentNotified.push(m))
    writeEventRules([{ name: '顺利', when: { types: ['x'] }, to: { kind: 'log' }, tell: 'needed' }], rulesPath)
    await succeeding.dispatch(makeEvent({ type: 'x' }))
    expect(silentNotified).toEqual([])

    const chatty = makeRouter(async () => [])
    const alwaysNotified: unknown[] = []
    chatty.setNotifyHandler((m) => alwaysNotified.push(m))
    writeEventRules([{ name: '话痨', when: { types: ['x'] }, to: { kind: 'log' }, tell: 'always' }], rulesPath)
    await chatty.dispatch(makeEvent({ type: 'x' }))
    expect(alwaysNotified).toHaveLength(1)
  })

  test('tell=silent：失败也不通知', async () => {
    const notified: unknown[] = []
    const router = makeRouter(async () => {
      throw new Error('boom')
    })
    router.setNotifyHandler((m) => notified.push(m))
    writeEventRules([{ name: '静默', when: { types: ['x'] }, to: { kind: 'workflow-event', eventName: 'e' }, tell: 'silent' }], rulesPath)
    const outcomes = await router.dispatch(makeEvent({ type: 'x' }))
    expect(outcomes[0]!.status).toBe('failed')
    expect(notified).toEqual([])
  })

  test('enabled=false 的规则不参与匹配', async () => {
    const router = makeRouter(async () => [])
    writeEventRules([{ name: '停用', when: { types: ['x'] }, to: { kind: 'log' }, enabled: false }], rulesPath)
    const outcomes = await router.dispatch(makeEvent({ type: 'x' }))
    expect(outcomes).toEqual([{ ruleName: '', status: 'no_rule' }])
  })

  test('默认模板包含可发现的 owner-goal 样例（默认停用）', () => {
    const ownerGoalRules = defaultEventRulesFile().rules.filter((rule) => rule.to.kind === 'owner-goal')
    expect(ownerGoalRules).toHaveLength(1)
    expect(ownerGoalRules[0]?.enabled).toBe(false)
    expect(ownerGoalRules[0]?.when).toEqual({ source: 'webhook', types: ['owner-goal'] })
  })

  test('规则文件读写往返 + 损坏文件按空规则处理', () => {
    const rules = defaultEventRulesFile().rules
    writeEventRules(rules, rulesPath)
    // 往返语义：读回的内容与写入一致（不断言模板规则条数，避免模板演进误伤）
    expect(readEventRules(rulesPath)).toEqual(rules)
    expect(existsSync(rulesPath)).toBe(true)

    writeFileSync(rulesPath, '{oops', 'utf-8')
    expect(readEventRules(rulesPath)).toEqual([])
  })

  test('validateEventRule 拦截非法结构', () => {
    expect(validateEventRule({ name: 'x', when: {}, to: { kind: 'log' } })).toEqual([])
    expect(validateEventRule({ name: '', when: {}, to: { kind: 'log' } })).toContain('规则缺少 name')
    expect(validateEventRule({ name: 'x', when: {}, to: { kind: 'session' } as never })).toContain('不支持的 to.kind: session')
    expect(validateEventRule({ name: 'x', when: {}, to: { kind: 'workflow-event', eventName: '' } })).toContain('to.eventName 不能为空')
    expect(validateEventRule({ name: 'x', when: {}, to: { kind: 'log' }, parallel: 0 })).toContain('parallel 必须是不小于 1 的整数')
    expect(validateEventRule({ name: 'x', when: {}, to: { kind: 'log' }, tell: 'sometimes' as never })).toContain('tell 只支持 needed / always / silent')
  })

  test('多规则同事件各执行一次（不同分组）', async () => {
    const router = makeRouter(async () => [])
    writeEventRules(
      [
        { name: '甲', when: { types: ['x'] }, to: { kind: 'log' }, group: 'g1' },
        { name: '乙', when: { types: ['x'] }, to: { kind: 'log' }, group: 'g2' },
      ],
      rulesPath,
    )
    const outcomes = await router.dispatch(makeEvent({ type: 'x' }))
    expect(outcomes).toHaveLength(2)
    expect(outcomes.every((o) => o.status === 'matched')).toBe(true)
  })
})

describe('owner-goal 目标', () => {
  let dir: string
  let rulesPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-router-owner-'))
    rulesPath = join(dir, 'event-rules.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRouter(wake?: OwnerGoalWakeExecutor): EventRouter {
    const router = new EventRouter(undefined, wake)
    router.setRulesPath(rulesPath)
    return router
  }

  test('validateEventRule 接受合法 owner-goal，拒绝空 projectId', () => {
    expect(validateEventRule({ name: 'x', when: {}, to: { kind: 'owner-goal', projectId: 'p-1' } })).toEqual([])
    expect(validateEventRule({ name: 'x', when: {}, to: { kind: 'owner-goal', projectId: 'p-1', taskId: 't-1' } })).toEqual([])
    expect(validateEventRule({ name: 'x', when: {}, to: { kind: 'owner-goal', projectId: '' } })).toContain('to.projectId 不能为空')
    expect(validateEventRule({ name: 'x', when: {}, to: { kind: 'owner-goal', projectId: 'p', taskId: '' } })).toContain('to.taskId 不能为空字符串')
  })

  test('规则命中 owner-goal：把 projectId/taskId 交给唤醒执行器', async () => {
    const calls: Array<{ projectId: string; taskId?: string }> = []
    const router = makeRouter(async (input) => { calls.push(input); return true })
    writeEventRules(
      [{ name: '唤醒', when: { types: ['issue.updated'] }, to: { kind: 'owner-goal', projectId: 'p-1', taskId: 't-1' } }],
      rulesPath,
    )

    const outcomes = await router.dispatch(makeEvent({ type: 'issue.updated' }))

    expect(calls).toEqual([{ projectId: 'p-1', taskId: 't-1' }])
    expect(outcomes).toEqual([{ ruleName: '唤醒', status: 'matched', detail: expect.stringContaining('Owner') as unknown as string }])
  })

  test('唤醒执行器返回 false 时 outcome 为 failed', async () => {
    const router = makeRouter(async () => false)
    writeEventRules([{ name: '唤醒', when: { types: ['x'] }, to: { kind: 'owner-goal', projectId: 'p-1' } }], rulesPath)

    const outcomes = await router.dispatch(makeEvent({ type: 'x' }))

    expect(outcomes[0]?.status).toBe('failed')
  })

  test('唤醒执行器抛错时 outcome 为 failed 且不冒泡', async () => {
    const router = makeRouter(async () => { throw new Error('数据库被锁') })
    writeEventRules([{ name: '唤醒', when: { types: ['x'] }, to: { kind: 'owner-goal', projectId: 'p-1' } }], rulesPath)

    const outcomes = await router.dispatch(makeEvent({ type: 'x' }))

    expect(outcomes[0]?.status).toBe('failed')
    expect(outcomes[0]?.detail).toContain('数据库被锁')
  })
})
