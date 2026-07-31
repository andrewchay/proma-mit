import { describe, expect, test } from 'bun:test'
import { DynamicIslandStore } from './island-store'
import { DynamicIslandRendererController } from './renderer-controller'
import { parseStdout, serializeCmd } from './renderer-protocol'
import type { DynamicIslandRequest } from '@proma/shared'

function req(partial: Partial<DynamicIslandRequest> = {}): DynamicIslandRequest {
  return {
    id: 'island-1',
    title: '任务',
    level: 'info',
    timeoutMs: 4500,
    createdAt: 1000,
    source: 'manual',
    ...partial,
  }
}

describe('DynamicIslandStore 队列状态机', () => {
  test('同 id 正在显示 → 原地替换，不重复入队', () => {
    const store = new DynamicIslandStore()
    store.show(req({ id: 'a' }))
    store.show(req({ id: 'a', title: '更新后' }))
    expect(store.current?.title).toBe('更新后')
    expect(store.queue).toHaveLength(0)
  })

  test('同 id 在排队 → 原地替换排队项', () => {
    const store = new DynamicIslandStore()
    store.show(req({ id: 'a' }))
    store.show(req({ id: 'b' }))
    store.show(req({ id: 'c' }))
    store.show(req({ id: 'b', title: 'b 更新' }))
    expect(store.queue.map((r) => r.id)).toEqual(['b', 'c'])
    expect(store.queue[0]?.title).toBe('b 更新')
  })

  test('不同 id → 排队；队首晋升', () => {
    const store = new DynamicIslandStore()
    store.show(req({ id: 'a' }))
    store.show(req({ id: 'b' }))
    store.show(req({ id: 'c' }))
    expect(store.current?.id).toBe('a')
    expect(store.queue.map((r) => r.id)).toEqual(['b', 'c'])

    store.expire('a')
    expect(store.current?.id).toBe('b')
    expect(store.queue.map((r) => r.id)).toEqual(['c'])
  })

  test('dismissAll 清空并标记队列为 replaced', () => {
    const store = new DynamicIslandStore()
    store.show(req({ id: 'a' }))
    store.show(req({ id: 'b' }))
    const events = store.dismissAll()
    expect(events.map((e) => e.reason)).toEqual(['replaced', 'user'])
    expect(store.current).toBeNull()
    expect(store.queue).toHaveLength(0)
  })
})

describe('DynamicIslandRendererController 计时编排', () => {
  test('progress 常驻不挂计时器，其余按 timeoutMs 过期', () => {
    const commands: Record<string, unknown>[] = []
    const controller = new DynamicIslandRendererController({ send: (c) => commands.push(c) })

    controller.show(req({ id: 'p', timeoutMs: 0 }))
    expect(commands[0]).toMatchObject({ type: 'render', view: { id: 'p' } })

    // 常驻条目仍占位：新通知入队，view 带 +N 徽标
    controller.show(req({ id: 'x', timeoutMs: 4500 }))
    const last = commands.at(-1) as { view?: { id?: string; queued?: number } }
    expect(last.view?.id).toBe('p')
    expect(last.view?.queued).toBe(1)
    // 常驻：不应发 clear
    expect(commands.filter((c) => c.type === 'clear')).toHaveLength(0)

    // 移除常驻 → 队首晋升，才挂普通计时
    controller.dismiss('p')
    expect(commands.at(-1)).toMatchObject({ type: 'render', view: { id: 'x' } })
  })

  test('同 id 刷新内容不重播 clear；过期后晋升下一条', async () => {
    const commands: Record<string, unknown>[] = []
    const controller = new DynamicIslandRendererController({ send: (c) => commands.push(c) })

    controller.show(req({ id: 'a', timeoutMs: 20 }))
    controller.show(req({ id: 'a', title: 'a 进度 50%', timeoutMs: 20 }))
    // 两条 render，无 clear
    expect(commands.filter((c) => c.type === 'clear')).toHaveLength(0)

    controller.show(req({ id: 'b', timeoutMs: 0 })) // b 常驻，避免再过期
    // a 显示时 b 排队 → 第三条 render 带 +N
    expect(commands.at(-1)).toMatchObject({ type: 'render', view: { id: 'a', queued: 1 } })

    await new Promise((r) => setTimeout(r, 40))
    // a 过期 → b 晋升为 current（常驻，不 clear）
    expect(commands.at(-1)).toMatchObject({ type: 'render', view: { id: 'b', queued: 0 } })
    expect(commands.filter((c) => c.type === 'clear')).toHaveLength(0)
    controller.dispose()
  })

  test('空队列 → clear', () => {
    const commands: Record<string, unknown>[] = []
    const controller = new DynamicIslandRendererController({ send: (c) => commands.push(c) })
    controller.dismissAll()
    expect(commands).toContainEqual({ type: 'clear' })
  })
})

describe('renderer-process 工具', () => {
  test('serializeCmd 追加换行', () => {
    expect(serializeCmd({ type: 'render' })).toBe('{"type":"render"}\n')
  })

  test('parseStdout 按行解析并保留残片', () => {
    const first = parseStdout('', '{"type":"clicked","id":"a"}\n{"type":"log",')
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({ type: 'clicked', id: 'a' })
    expect(first.buffer).toBe('{"type":"log",')

    const second = parseStdout(first.buffer, '"msg":"hi"}\n')
    expect(second.events).toHaveLength(1)
    expect(second.events[0]).toMatchObject({ type: 'log', msg: 'hi' })
    expect(second.buffer).toBe('')
  })

  test('parseStdout 静默丢弃非法 JSON', () => {
    const result = parseStdout('', 'not-json\n{"type":"clear"}\n')
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({ type: 'clear' })
  })
})
