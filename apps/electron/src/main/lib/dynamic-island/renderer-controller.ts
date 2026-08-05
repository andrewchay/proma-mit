/**
 * DynamicIslandRendererController — 渲染控制器（计时器编排）。
 *
 * 持有 IslandStore；每次 sync() 把 current（含排队 +N）序列化成
 * { type: "render", view } 发给子进程，并挂 unref 计时器过期；
 * progress（timeoutMs=0）常驻不挂计时器。
 * 核心语义：内容可刷、寿命不延（timingId 保证同 id 刷新不重置计时）。
 */

import { DynamicIslandStore } from './island-store'
import type { DynamicIslandLevel, DynamicIslandRequest } from '@gravitas/shared'

export interface RendererControllerDeps {
  send: (cmd: Record<string, unknown>) => void
  onError?: (err: unknown) => void
}

/** 发给原生侧的 view 形状 */
interface IslandView {
  id: string
  title: string
  accent: string
  symbol: string
  clickable: boolean
  queued: number
  body?: string
  level?: string
}

export const SF_SYMBOLS: Record<DynamicIslandLevel, string> = {
  info: 'info.circle.fill',
  success: 'checkmark.circle.fill',
  warning: 'exclamationmark.triangle.fill',
  error: 'xmark.octagon.fill',
  progress: 'arrow.triangle.2.circlepath',
}

export const ACCENT_COLORS: Record<DynamicIslandLevel, string> = {
  info: '#0a84ff',
  success: '#30d158',
  warning: '#ff9f0a',
  error: '#ff453a',
  progress: '#64d2ff',
}

function toView(request: DynamicIslandRequest, queuedCount: number): IslandView {
  const view: IslandView = {
    id: request.id,
    title: request.title,
    accent: ACCENT_COLORS[request.level] ?? ACCENT_COLORS.info,
    symbol: SF_SYMBOLS[request.level] ?? SF_SYMBOLS.info,
    clickable: request.activateOnClick === true,
    queued: Math.max(0, queuedCount),
    level: request.level,
  }
  if (request.body) view.body = request.body
  return view
}

export class DynamicIslandRendererController {
  store = new DynamicIslandStore()
  private timer: ReturnType<typeof setTimeout> | undefined
  private timingId: string | null = null
  private deps: RendererControllerDeps

  constructor(deps: RendererControllerDeps) {
    this.deps = deps
  }

  show(request: DynamicIslandRequest): void {
    this.store.show(request)
    this.sync()
  }

  dismiss(id: string): void {
    this.store.dismiss(id)
    this.sync()
  }

  dismissAll(): void {
    this.store.dismissAll()
    this.sync()
  }

  /** 渲染进程崩溃重启后强制重发：清掉 timingId 破坏 sync 的早退条件 */
  resync(): void {
    this.timingId = null
    this.sync()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.timingId = null
  }

  sync(): void {
    const { current, queued } = this.store.snapshot()

    // (A) 没有当前通知 → 清计时器，发 clear
    if (!current) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      this.timingId = null
      this.emit({ type: 'clear' })
      return
    }

    // 先渲染（含 +N 徽标）
    this.emit({ type: 'render', view: toView(current, queued) })

    // (B) progress 常驻(timeoutMs<=0) → 不挂任何 timer
    if (current.timeoutMs <= 0) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      this.timingId = null
      return
    }

    // (C) 已经在给这条计时 → 不重置（内容刷新但不续命）
    if (this.timingId === current.id) return

    // (D) 新条目 → 重新计时
    if (this.timer) clearTimeout(this.timer)
    this.timingId = current.id
    const { id } = current
    this.timer = setTimeout(() => {
      this.timingId = null
      this.store.expire(id) // 过期 → 队首晋升
      this.sync()
    }, current.timeoutMs)
    this.timer.unref?.()
  }

  private emit(event: Record<string, unknown>): void {
    try {
      this.deps.send(event)
    } catch (err) {
      this.deps.onError?.(err)
    }
  }
}
