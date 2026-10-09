/**
 * E02 进程内工具调度器。
 *
 * 锁为逻辑读写锁（真实路径键 + 全局 unknown 排他键）。
 * 只在“全部锁空闲”时派发调用，加锁同步完成、逆序释放：
 * 因此从结构上不存在持有锁等待另一把锁的情况，无需等待队列，死锁不可能发生。
 * 不防跨进程竞争，不消除 TOCTOU；不接入生产执行（E05）。
 */

import type { ToolContext, RuntimeToolDefinition } from './types'
import { resolveRegisteredToolResources } from './tool-resources'

export interface ResourceLockSpec {
  /** 已排序的锁键。 */
  readonly keys: readonly string[]
  readonly mode: 'shared' | 'exclusive'
}

const GLOBAL_UNKNOWN_KEY = 'global:unknown'

/** 由实际注册实例推导锁规约；未知或解析失败一律全局排他（保守）。 */
export async function planLockSpec(tool: RuntimeToolDefinition, input: unknown, ctx: ToolContext): Promise<ResourceLockSpec> {
  try {
    const observation = resolveRegisteredToolResources(tool, input, ctx)
    if (observation.status !== 'resolved' || observation.resources.length === 0) {
      return { keys: [GLOBAL_UNKNOWN_KEY], mode: 'exclusive' }
    }
    const hasWrite = observation.resources.some((r) => r.mode === 'write')
    const keys = [...new Set(observation.resources.flatMap((r) => r.coveredPaths))].sort()
    return { keys, mode: hasWrite ? 'exclusive' : 'shared' }
  } catch {
    return { keys: [GLOBAL_UNKNOWN_KEY], mode: 'exclusive' }
  }
}

class RwLock {
  private readers = 0
  private writer = false

  canAcquire(mode: 'shared' | 'exclusive'): boolean {
    if (mode === 'exclusive') return !this.writer && this.readers === 0
    return !this.writer
  }

  /** 仅可在 canAcquire 为真时调用（调度器保证），同步授予。 */
  acquireNow(mode: 'shared' | 'exclusive'): void {
    if (mode === 'exclusive') this.writer = true
    else this.readers += 1
  }

  release(mode: 'shared' | 'exclusive'): void {
    if (mode === 'exclusive') this.writer = false
    else this.readers -= 1
  }
}

export interface ScheduledCall<T = unknown> {
  readonly id: string
  readonly tool: RuntimeToolDefinition
  readonly input: unknown
  readonly ctx: ToolContext
  readonly execute: () => Promise<T>
}

export interface ScheduledResult<T = unknown> {
  readonly id: string
  readonly status: 'completed' | 'error' | 'cancelled'
  readonly result?: T
  readonly error?: string
}

export interface SchedulerMetrics {
  readonly dispatched: number
  readonly completed: number
  readonly errored: number
  readonly cancelled: number
  readonly totalWaitMs: number
}

export interface ToolSchedulerOptions {
  readonly maxConcurrent?: number
  readonly plan?: (call: ScheduledCall) => Promise<ResourceLockSpec>
}

interface SchedulerItem<T = unknown> {
  readonly call: ScheduledCall<T>
  readonly spec: ResourceLockSpec
  state: 'pending' | 'running' | 'completed' | 'error' | 'cancelled'
  readonly queuedAt: number
}

export class ToolScheduler {
  private readonly maxConcurrent: number
  private readonly plan: (call: ScheduledCall) => Promise<ResourceLockSpec>
  private readonly locks = new Map<string, RwLock>()
  private readonly metrics: { dispatched: number; completed: number; errored: number; cancelled: number; totalWaitMs: number } = { dispatched: 0, completed: 0, errored: 0, cancelled: 0, totalWaitMs: 0 }
  /** 跨批次等待者：锁状态变化时全部唤醒（单次 schedule 只通知自己的设计会让并发批次死等）。 */
  private readonly waiters = new Set<() => void>()

  private wakeWaiters(): void {
    for (const wake of [...this.waiters]) wake()
  }

  constructor(options: ToolSchedulerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 4
    this.plan = options.plan ?? ((call) => planLockSpec(call.tool, call.input, call.ctx))
  }

  snapshotMetrics(): SchedulerMetrics {
    return { ...this.metrics }
  }

  async schedule<T>(calls: readonly ScheduledCall<T>[], signal?: AbortSignal): Promise<ScheduledResult<T>[]> {
    const results = new Map<string, ScheduledResult<T>>()
    const now = Date.now()
    const items: SchedulerItem<T>[] = []
    for (const call of calls) {
      if (signal?.aborted) {
        this.metrics.cancelled += 1
        results.set(call.id, { id: call.id, status: 'cancelled' })
        items.push({ call, spec: { keys: [], mode: 'shared' }, state: 'cancelled', queuedAt: now })
        continue
      }
      items.push({ call, spec: await this.plan(call), state: 'pending', queuedAt: now })
    }

    let running = 0
    await new Promise<void>((resolve) => {
      const wake = (): void => { notify() }
      this.waiters.add(wake)
      const notify = (): void => {
        // 先按提交顺序扫描：第一个全部锁空闲的调用立即派发（跳过队首阻塞）。
        let progressed = true
        while (progressed) {
          progressed = false
          for (const item of items) {
            if (item.state !== 'pending') continue
            if (signal?.aborted) {
              item.state = 'cancelled'
              this.metrics.cancelled += 1
              results.set(item.call.id, { id: item.call.id, status: 'cancelled' })
              progressed = true
              continue
            }
            if (running >= this.maxConcurrent) break
            if (this.canAcquire(item.spec)) {
              item.state = 'running'
              this.metrics.dispatched += 1
              this.metrics.totalWaitMs += Date.now() - item.queuedAt
              running += 1
              progressed = true
              void this.run(item, results, signal).finally(() => {
                running -= 1
                this.wakeWaiters()
              })
            }
          }
        }
        if (items.every((item) => item.state === 'completed' || item.state === 'error' || item.state === 'cancelled')) {
          this.waiters.delete(wake)
          signal?.removeEventListener('abort', wake)
          resolve()
        }
      }
      signal?.addEventListener('abort', wake, { once: true })
      notify()
    })
    return calls.map((call) => results.get(call.id) ?? { id: call.id, status: 'cancelled' })
  }

  private canAcquire(spec: ResourceLockSpec): boolean {
    return spec.keys.every((key) => (this.locks.get(key) ?? new RwLock()).canAcquire(spec.mode))
  }

  private async run<T>(item: SchedulerItem<T>, results: Map<string, ScheduledResult<T>>, signal?: AbortSignal): Promise<void> {
    const { call, spec } = item
    const acquired: Array<{ lock: RwLock; mode: 'shared' | 'exclusive' }> = []
    try {
      // 调度保证全部空闲；同步加锁，调用期间按序持有、逆序释放。
      for (const key of spec.keys) {
        const lock = this.locks.get(key) ?? new RwLock()
        this.locks.set(key, lock)
        lock.acquireNow(spec.mode)
        acquired.push({ lock, mode: spec.mode })
      }
      if (signal?.aborted) {
        item.state = 'cancelled'
        this.metrics.cancelled += 1
        results.set(call.id, { id: call.id, status: 'cancelled' })
        return
      }
      const result = await call.execute()
      item.state = 'completed'
      this.metrics.completed += 1
      results.set(call.id, { id: call.id, status: 'completed', result })
    } catch (error) {
      item.state = 'error'
      this.metrics.errored += 1
      results.set(call.id, { id: call.id, status: 'error', error: error instanceof Error ? error.message : String(error) })
    } finally {
      for (let i = acquired.length - 1; i >= 0; i--) {
        const { lock, mode } = acquired[i]!
        lock.release(mode)
      }
    }
  }
}
