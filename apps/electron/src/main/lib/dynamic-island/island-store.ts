/**
 * DynamicIslandStore — 通知队列状态机。
 *
 * 同一时刻只显示一条，其余排队；同 id 就地替换（不重播入场动画、不重置计时）。
 * 移植自 weavelynx DynamicIsland 插件（island store）。
 */

import type { DynamicIslandRequest } from '@gravitas/shared'

export type DynamicIslandRemoveReason = 'user' | 'timeout' | 'replaced'

export interface DynamicIslandRemoveEvent {
  id: string
  reason: DynamicIslandRemoveReason
}

export class DynamicIslandStore {
  current: DynamicIslandRequest | null = null
  queue: DynamicIslandRequest[] = []

  snapshot(): { current: DynamicIslandRequest | null; queued: number } {
    return { current: this.current, queued: this.queue.length }
  }

  /** 入队/就地替换 */
  show(request: DynamicIslandRequest): void {
    // ① 同 id 正在显示 → 原地替换，不重播入场动画
    if (this.current?.id === request.id) {
      this.current = request
      return
    }
    // ② 同 id 在排队 → 原地替换那条排队项
    const idx = this.queue.findIndex((r) => r.id === request.id)
    if (idx !== -1) {
      this.queue[idx] = request
      return
    }
    // ③ 有当前显示且 id 不同 → 入队尾
    if (this.current) {
      this.queue.push(request)
      return
    }
    // ④ 没有当前显示 → 成为当前
    this.current = request
  }

  dismiss(id: string): DynamicIslandRemoveEvent[] {
    return this.remove(id, 'user')
  }

  expire(id: string): DynamicIslandRemoveEvent[] {
    return this.remove(id, 'timeout')
  }

  dismissAll(): DynamicIslandRemoveEvent[] {
    const events: DynamicIslandRemoveEvent[] = []
    for (const item of this.queue.splice(0)) events.push({ id: item.id, reason: 'replaced' })
    if (this.current) {
      events.push({ id: this.current.id, reason: 'user' })
      this.current = null
    }
    return events
  }

  /** 移除指定 id；若移除的是 current，队首自动晋升 */
  remove(id: string, reason: DynamicIslandRemoveReason): DynamicIslandRemoveEvent[] {
    if (this.current?.id === id) {
      this.current = this.queue.shift() ?? null
      return [{ id, reason }]
    }
    const idx = this.queue.findIndex((o) => o.id === id)
    return idx === -1 ? [] : (this.queue.splice(idx, 1), [{ id, reason }])
  }
}
