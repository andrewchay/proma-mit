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
    return new EventRouter(executor)
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
        { name: '规则A', when: { types: ['im.message'] }, to: { kind: 'log' } },
        { name: '规则B', when: { types: ['im.message'] }, to: { kind: 'log' } },
      ],
      rulesPath,
    )
    await router.dispatch(makeEvent())
    const second = await router.dispatch(makeEvent({ occurredAt: Date.now() + 1 }))
    expect(calls).toBe(1)
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
    writeEventRules([{ name: 'R', when: { types: ['im.message'] }, to: { kind: 'log' } }], rulesPath)
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
    writeEventRules([{ name: 'R', when: { types: ['im.message'] }, to: { kind: 'log' } }], rulesPath)
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
    const failing = new EventRouter(async () => {
      throw new Error('boom')
    })
    failing.setNotifyHandler((m) => notified.push({ ruleName: m.ruleName, ok: m.ok }))
    writeEventRules([{ name: '会炸', when: { types: ['x'] }, to: { kind: 'workflow-event', eventName: 'e' } }], rulesPath)
    const outcomes = await failing.dispatch(makeEvent({ type: 'x' }))
    expect(outcomes[0]!.status).toBe('failed')
    expect(notified).toEqual([{ ruleName: '会炸', ok: false }])

    const succeeding = new EventRouter(async () => [])
    const silentNotified: unknown[] = []
    succeeding.setNotifyHandler((m) => silentNotified.push(m))
    writeEventRules([{ name: '顺利', when: { types: ['x'] }, to: { kind: 'log' }, tell: 'needed' }], rulesPath)
    await succeeding.dispatch(makeEvent({ type: 'x' }))
    expect(silentNotified).toEqual([])

    const chatty = new EventRouter(async () => [])
    const alwaysNotified: unknown[] = []
    chatty.setNotifyHandler((m) => alwaysNotified.push(m))
    writeEventRules([{ name: '话痨', when: { types: ['x'] }, to: { kind: 'log' }, tell: 'always' }], rulesPath)
    await chatty.dispatch(makeEvent({ type: 'x' }))
    expect(alwaysNotified).toHaveLength(1)
  })

  test('tell=silent：失败也不通知', async () => {
    const notified: unknown[] = []
    const router = new EventRouter(async () => {
      throw new Error('boom')
    })
    router.setNotifyHandler((m) => notified.push(m))
    writeEventRules([{ name: '静默', when: { types: ['x'] }, to: { kind: 'log' }, tell: 'silent' }], rulesPath)
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

  test('规则文件读写往返 + 损坏文件按空规则处理', () => {
    const rules = defaultEventRulesFile().rules
    writeEventRules(rules, rulesPath)
    expect(readEventRules(rulesPath)).toHaveLength(1)
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
