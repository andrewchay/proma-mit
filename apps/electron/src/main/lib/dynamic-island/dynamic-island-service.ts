/**
 * DynamicIslandService — macOS 灵动岛通知服务（主进程）。
 *
 * 架构移植自 weavelynx DynamicIsland 插件：
 * - JS 管业务（队列/计时/配置/路由），Swift/AppKit 只管画；
 * - 三源归一：AI 主动调用、Agent 事件自动通知、手动测试共用 NotifyRequest；
 * - 渲染子进程隔离（island.fork.js + island.node），原生不进入主进程；
 * - 配置隔离：开关写在 ~/.proma-mit/dynamic-island/config.json。
 */

import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'
import type {
  DynamicIslandNotifyInput,
  DynamicIslandRequest,
  DynamicIslandSource,
  DynamicIslandState,
  DynamicIslandActionResult,
  DynamicIslandProjectMutedResult,
} from '@proma/shared'
import { TRAY_IPC_CHANNELS } from '../../../types/settings'
import { getDynamicIslandConfigPath } from '../config-paths'
import { DynamicIslandRendererController } from './renderer-controller'
import { DynamicIslandRendererProcess } from './renderer-process'
import { agentEventBus } from '../agent-service'
import type { AgentStreamPayload } from '@proma/shared'

const IS_MAC = process.platform === 'darwin'
const MAX_RECENT = 5

interface DynamicIslandConfig {
  enabled: boolean
  mutedProjects: string[]
}

const DEFAULT_CONFIG: DynamicIslandConfig = { enabled: true, mutedProjects: [] }

function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}

function isMuted(config: DynamicIslandConfig, workspace?: string): boolean {
  if (!workspace) return false
  const target = normalizePath(workspace)
  return config.mutedProjects.some((muted) => {
    const m = normalizePath(muted)
    return target === m || target.startsWith(`${m}/`) || target.startsWith(`${m}\\`)
  })
}

function loadConfig(): DynamicIslandConfig {
  try {
    const raw = JSON.parse(readFileSync(getDynamicIslandConfigPath(), 'utf-8')) as Partial<DynamicIslandConfig>
    return {
      enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
      mutedProjects: Array.isArray(raw.mutedProjects) ? raw.mutedProjects.filter((m) => typeof m === 'string') : [],
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function saveConfig(config: DynamicIslandConfig): void {
  const file = getDynamicIslandConfigPath()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8')
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

function defaultTimeout(level: DynamicIslandRequest['level']): number {
  return level === 'progress' ? 0 : 4500
}

/** 三源归一：ai / agent_event / manual → 统一 NotifyRequest */
function normalizeRequest(input: DynamicIslandNotifyInput, source: DynamicIslandSource, now: number, idGen: () => string): DynamicIslandRequest {
  const level = input.level ?? 'info'
  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs >= 0
      ? Math.round(input.timeoutMs)
      : defaultTimeout(level)
  const request: DynamicIslandRequest = {
    id: input.id?.trim() || idGen(),
    title: truncate(input.title, 48),
    level,
    timeoutMs,
    createdAt: now,
    source,
  }
  const body = input.body ? truncate(input.body, 72) : ''
  if (body.length > 0) request.body = body
  if (input.activateOnClick) request.activateOnClick = true
  if (input.sessionId) request.sessionId = input.sessionId
  return request
}

class DynamicIslandService {
  private config: DynamicIslandConfig = { ...DEFAULT_CONFIG }
  private rendererProc: DynamicIslandRendererProcess | null = null
  private controller: DynamicIslandRendererController | null = null
  private running = false
  private recent: DynamicIslandRequest[] = []
  private idCounter = 0
  private unsubscribeEventBus: (() => void) | null = null

  private genId(): string {
    return `island-${Date.now()}-${(this.idCounter += 1)}`
  }

  getState(): DynamicIslandState {
    return {
      supported: IS_MAC,
      running: this.running,
      enabled: this.config.enabled,
      recent: [...this.recent],
    }
  }

  async notify(input: DynamicIslandNotifyInput, source: DynamicIslandSource = 'ai'): Promise<DynamicIslandActionResult> {
    if (!IS_MAC) return { ok: false, reason: 'unsupported' }
    if (!this.config.enabled) return { ok: false, reason: 'disabled' }
    if (typeof input.title !== 'string' || input.title.trim().length === 0) {
      return { ok: false, reason: 'title required' }
    }

    const request = normalizeRequest(input, source, Date.now(), () => this.genId())
    try {
      this.ensureRenderer()
      this.controller?.show(request)
    } catch (err) {
      console.error('[Dynamic Island] 渲染失败:', err)
      return { ok: false, reason: 'renderer unavailable' }
    }

    this.recent.unshift(request)
    if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT
    return { ok: true }
  }

  dismiss(id: string): DynamicIslandActionResult {
    if (!IS_MAC || !this.controller) return { ok: false, reason: 'unsupported' }
    this.controller.dismiss(id)
    return { ok: true }
  }

  dismissAll(): void {
    this.controller?.dismissAll()
  }

  async setEnabled(enabled: boolean): Promise<DynamicIslandState> {
    this.config = { ...this.config, enabled }
    saveConfig(this.config)
    if (!enabled) this.disposeRenderer()
    return this.getState()
  }

  async test(): Promise<DynamicIslandActionResult> {
    // 测试通知不激活窗口：仅验证刘海渲染效果，点击不应弹跳 Dock
    return this.notify(
      {
        title: '灵动岛已就绪',
        body: '这是一条来自设置面板的测试通知',
        level: 'success',
        activateOnClick: false,
      },
      'manual',
    )
  }

  getProjectMuted(workspace?: string): DynamicIslandProjectMutedResult {
    return { muted: isMuted(this.config, workspace) }
  }

  setProjectMuted(workspace: string, muted: boolean): DynamicIslandProjectMutedResult {
    const others = this.config.mutedProjects.filter((m) => normalizePath(m) !== normalizePath(workspace))
    this.config = { ...this.config, mutedProjects: muted ? [...others, workspace] : others }
    saveConfig(this.config)
    return { muted: isMuted(this.config, workspace) }
  }

  /** 点击通知 → 聚焦窗口 + 打开对应 Agent 会话（复用托盘打开逻辑） */
  private handleClicked(event: Record<string, unknown>): void {
    const id = typeof event.id === 'string' ? event.id : ''
    const request = this.recent.find((r) => r.id === id) ?? this.controller?.store.current ?? null
    this.controller?.dismiss(id)
    // 仅带 sessionId 的通知（需要确认/任务完成等）点击后导航到会话并聚焦主窗口；
    // 无 sessionId 的通知（如测试通知）点击只关闭，不激活窗口，避免 Dock 弹跳。
    if (!request?.activateOnClick || !request.sessionId) return

    // 选一个可见且非销毁的主窗口；优先主窗口（不弹 dock、不拉起隐藏的 quick-task）
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized()
    )
    if (!win) return
    win.show()
    win.focus()

    win.webContents.send(TRAY_IPC_CHANNELS.OPEN_AGENT_SESSION, {
      sessionId: request.sessionId,
      title: request.title,
    })
  }

  private handleRendererEvent(event: Record<string, unknown>): void {
    const type = event.type
    if (type === 'clicked') {
      this.handleClicked(event)
      return
    }
    if (type === 'log') {
      const level = typeof event.level === 'string' ? event.level : 'info'
      const msg = typeof event.msg === 'string' ? event.msg : String(event.msg ?? '')
      if (level === 'error') console.error(`[Dynamic Island] ${msg}`)
      else if (level === 'warn') console.warn(`[Dynamic Island] ${msg}`)
      else console.log(`[Dynamic Island] ${msg}`)
    }
  }

  /** 懒初始化渲染栈（首次 notify 时才建） */
  private ensureRenderer(): void {
    if (this.rendererProc && this.controller) return
    const root = app.isPackaged
      ? join(process.resourcesPath, 'dynamic-island')
      : join(process.cwd(), 'apps/electron/dist/resources/dynamic-island')

    this.rendererProc = new DynamicIslandRendererProcess({
      root,
      logger: {
        info: (msg) => console.log(`[Dynamic Island] ${msg}`),
        warn: (msg) => console.warn(`[Dynamic Island] ${msg}`),
        error: (msg) => console.error(`[Dynamic Island] ${msg}`),
      },
      onEvent: (event) => this.handleRendererEvent(event),
      onRunningChange: (isRunning) => {
        const justCameOnline = isRunning && !this.running
        this.running = isRunning
        if (justCameOnline) this.controller?.resync()
      },
    })
    this.controller = new DynamicIslandRendererController({
      send: (cmd) => void this.rendererProc?.send(cmd),
      onError: (err) => console.error('[Dynamic Island] send failed:', err),
    })
  }

  private disposeRenderer(): void {
    this.controller?.dispose()
    this.controller = null
    this.rendererProc?.dispose()
    this.rendererProc = null
    this.running = false
  }

  /** 监听 Agent 事件 → 自动通知 */
  start(): void {
    if (!IS_MAC) return
    this.config = loadConfig()
    this.unsubscribeEventBus = agentEventBus.on((sessionId, payload) => {
      this.handleAgentPayload(sessionId, payload)
    })
  }

  stop(): void {
    this.unsubscribeEventBus?.()
    this.unsubscribeEventBus = null
    this.disposeRenderer()
  }

  private handleAgentPayload(sessionId: string, payload: AgentStreamPayload): void {
    if (!this.config.enabled) return
    if (payload.kind === 'proma_event') {
      const event = payload.event
      if (event.type === 'permission_request' || event.type === 'ask_user_request' || event.type === 'exit_plan_mode_request') {
        const title = event.type === 'permission_request'
          ? 'Agent 需要权限确认'
          : event.type === 'ask_user_request'
            ? 'Agent 正在向你提问'
            : 'Agent 需要计划审批'
        void this.notify({
          title,
          body: truncate(event.type === 'permission_request' ? event.request.description ?? '' : '', 72) || '点击查看详情',
          level: 'warning',
          activateOnClick: true,
          sessionId,
        }, 'agent_event')
      }
      return
    }
    if (payload.kind === 'agent_event') {
      const event = payload.event
      if (event.type === 'complete') {
        void this.notify({
          title: '任务已完成',
          body: 'Agent 已完成任务',
          level: 'success',
          activateOnClick: true,
          sessionId,
        }, 'agent_event')
      } else if (event.type === 'error' || event.type === 'typed_error') {
        void this.notify({
          title: '任务失败',
          body: event.type === 'error' ? event.message : event.error.message ?? '',
          level: 'error',
          activateOnClick: true,
          sessionId,
        }, 'agent_event')
      }
    }
  }
}

/** 单例 */
let service: DynamicIslandService | null = null

export function getDynamicIslandService(): DynamicIslandService {
  service ??= new DynamicIslandService()
  return service
}

export function startDynamicIslandService(): void {
  getDynamicIslandService().start()
}

export function stopDynamicIslandService(): void {
  service?.stop()
  service = null
}
