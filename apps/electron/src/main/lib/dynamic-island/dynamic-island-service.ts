/**
 * DynamicIslandService — macOS 灵动岛通知服务（主进程）。
 *
 * 架构基于官方 Proma Agent Island 的会话状态机升级：
 * - 主进程状态机拥有全部产品状态（session → phase/detail/attention），
 *   原生渲染层只负责画；
 * - phase 语义：running 是执行脉冲，needs-interaction 需用户处理，
 *   completed/error 保留未读窗口后消失；
 * - 同一时刻渲染 attention 最高的会话（常驻胶囊），点击 dismiss 后切到下一个或隐藏；
 * - 三源归一：AI 主动调用、Agent 事件自动通知、手动测试共用 NotifyRequest；
 * - 渲染子进程隔离（island.fork.js + island.node），原生不进入主进程；
 * - 配置隔离：开关写在 ~/.proma-mit/dynamic-island/config.json。
 */

import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'
import type {
  DynamicIslandLevel,
  DynamicIslandNotifyInput,
  DynamicIslandRequest,
  DynamicIslandSource,
  DynamicIslandState,
  DynamicIslandActionResult,
  DynamicIslandProjectMutedResult,
  DynamicIslandSessionPhase,
  DynamicIslandSessionSnapshot,
  DynamicIslandPillSnapshot,
  AgentStreamPayload,
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  PromaEvent,
} from '@proma/shared'
import { TRAY_IPC_CHANNELS } from '../../../types/settings'
import { getDynamicIslandConfigPath } from '../config-paths'
import { DynamicIslandRendererController } from './renderer-controller'
import { DynamicIslandRendererProcess } from './renderer-process'
import { agentEventBus } from '../agent-service'

const IS_MAC = process.platform === 'darwin'
const MAX_RECENT = 5
/** 完成/错误后保留未读窗口（也是 terminal 会话在列表中的存活期） */
const UNREAD_RETAIN_MS = 10 * 60_000
/** 交互/计划变更等需要即时反馈的推送节流间隔 */
const PUSH_THROTTLE_MS = 80
/** 普通 Agent 流事件只需低频合并（running 的 token 流不触发重绘） */
const AGENT_STREAM_PUSH_THROTTLE_MS = 2_000

interface DynamicIslandConfig {
  enabled: boolean
  mutedProjects: string[]
}

const DEFAULT_CONFIG: DynamicIslandConfig = { enabled: true, mutedProjects: [] }

interface InternalSessionSnapshot extends DynamicIslandSessionSnapshot {
  /** 未读完成/错误标记（在 UNREAD_RETAIN_MS 内保留） */
  unread: boolean
  /** 完成/错误的时间戳 */
  terminalAt?: number
}

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

// ===== phase → 渲染映射 =====

function levelForPhase(phase: DynamicIslandSessionPhase): DynamicIslandLevel {
  switch (phase) {
    case 'needs-interaction': return 'warning'
    case 'error': return 'error'
    case 'completed': return 'success'
    case 'running': return 'progress'
    default: return 'info'
  }
}

function summaryForPhase(phase: DynamicIslandSessionPhase): string {
  switch (phase) {
    case 'needs-interaction': return '需要你的处理'
    case 'error': return '任务失败'
    case 'completed': return '任务已完成'
    case 'running': return '正在执行'
    default: return '空闲'
  }
}

class DynamicIslandService {
  private config: DynamicIslandConfig = { ...DEFAULT_CONFIG }
  private rendererProc: DynamicIslandRendererProcess | null = null
  private controller: DynamicIslandRendererController | null = null
  private running = false
  private sessions = new Map<string, InternalSessionSnapshot>()
  private recent: DynamicIslandSessionSnapshot[] = []
  private idCounter = 0
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private lastPushAt = 0
  private unsubscribeEventBus: (() => void) | null = null

  private genId(): string {
    return `island-${Date.now()}-${(this.idCounter += 1)}`
  }

  // ===== 状态查询 =====

  getState(): DynamicIslandState {
    const now = Date.now()
    return {
      supported: IS_MAC,
      running: this.running,
      enabled: this.config.enabled,
      pill: this.buildPill(now),
      recent: [...this.recent],
    }
  }

  // ===== 会话快照管理 =====

  private ensureSession(sessionId: string): InternalSessionSnapshot {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = {
        sessionId,
        title: sessionId.slice(0, 8),
        phase: 'running',
        detail: '',
        attention: false,
        unread: false,
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
      }
      this.sessions.set(sessionId, session)
    }
    return session
  }

  /** 会话是否应出现在灵动岛（running 常驻脉冲；terminal 保留未读窗口） */
  private isIslandSession(session: InternalSessionSnapshot, now: number): boolean {
    if (now - session.lastActivityAt >= 24 * 60 * 60_000) return false
    if (session.phase === 'running' || session.phase === 'needs-interaction' || session.phase === 'error') return true
    return session.phase === 'completed'
      && session.unread
      && session.terminalAt !== undefined
      && now - session.terminalAt < UNREAD_RETAIN_MS
  }

  /** 优先级：需要交互 > 错误 > 完成未读 > 执行中 */
  private attentionScore(session: InternalSessionSnapshot): number {
    if (session.phase === 'needs-interaction') return 3
    if (session.phase === 'error') return 2
    if (session.phase === 'completed' && session.unread) return 1
    return 0
  }

  private buildPill(now: number): DynamicIslandPillSnapshot {
    const visible = [...this.sessions.values()].filter((session) => this.isIslandSession(session, now))
    const pendingInteraction = visible.filter((session) => session.phase === 'needs-interaction').length
    const unread = visible.filter((session) => session.phase === 'completed' && session.unread).length
    const active = visible.filter((session) => session.phase === 'running' || session.phase === 'needs-interaction').length
    const priority = visible.sort((a, b) => this.attentionScore(b) - this.attentionScore(a))[0]

    return {
      priorityStatus: priority?.phase ?? 'idle',
      sessionCount: visible.length,
      activeSessionCount: active,
      pendingInteractionCount: pendingInteraction,
      unreadCompletedCount: unread,
    }
  }

  /** 渲染 priority 会话为常驻胶囊；无需要用户注意的会话则 clear */
  private renderPrioritySession(): void {
    const now = Date.now()
    const visible = [...this.sessions.values()]
      .filter((session) => this.isIslandSession(session, now))
      .sort((a, b) => {
        const score = this.attentionScore(b) - this.attentionScore(a)
        if (score !== 0) return score
        return a.startedAt - b.startedAt
      })

    if (visible.length === 0) {
      this.controller?.dismissAll()
      return
    }

    const priority = visible[0]!
    const needsAttention = this.attentionScore(priority) > 0
    const request: DynamicIslandRequest = {
      id: `session:${priority.sessionId}`,
      title: truncate(priority.title || summaryForPhase(priority.phase), 48),
      body: truncate(priority.detail || summaryForPhase(priority.phase), 72),
      level: levelForPhase(priority.phase),
      // 需要用户注意的常驻（直到点击处理）；running 显示 2s 执行脉冲后自动收起
      timeoutMs: needsAttention ? 0 : 2000,
      activateOnClick: needsAttention,
      sessionId: priority.sessionId,
      createdAt: now,
      source: 'agent_event',
    }
    this.controller?.show(request)
  }

  // ===== 事件处理（会话状态机） =====

  private handleAgentPayload(sessionId: string, payload: AgentStreamPayload): void {
    if (!this.config.enabled) return
    if (payload.kind === 'proma_event') {
      this.handlePromaEvent(sessionId, payload.event)
    } else if (payload.kind === 'agent_event') {
      this.handleAgentEvent(sessionId, payload.event)
    } else if (payload.kind === 'sdk_message') {
      this.handleSdkMessage(sessionId, payload.message)
    }
    // 事件处理后合并推送（attention 变更即时、流事件低频）
    this.schedulePush(this.requiresImmediatePush(payload) ? PUSH_THROTTLE_MS : AGENT_STREAM_PUSH_THROTTLE_MS)
    this.refreshRecent(sessionId)
  }

  private handlePromaEvent(sessionId: string, event: PromaEvent): void {
    switch (event.type) {
      case 'permission_request': {
        const session = this.ensureSession(sessionId)
        session.phase = 'needs-interaction'
        session.interactionKind = 'permission'
        session.detail = '等待权限确认'
        session.attention = true
        session.lastActivityAt = Date.now()
        break
      }
      case 'ask_user_request': {
        const session = this.ensureSession(sessionId)
        session.phase = 'needs-interaction'
        session.interactionKind = 'ask_user_question'
        const question = event.request?.questions?.[0]?.question ?? event.request?.questions?.[0]?.header ?? '等待回答'
        session.detail = truncate(question, 50)
        session.attention = true
        session.lastActivityAt = Date.now()
        break
      }
      case 'exit_plan_mode_request': {
        const session = this.ensureSession(sessionId)
        session.phase = 'needs-interaction'
        session.interactionKind = 'plan_review'
        session.detail = '等待计划审批'
        session.attention = true
        session.lastActivityAt = Date.now()
        break
      }
      case 'permission_resolved':
      case 'ask_user_resolved':
      case 'exit_plan_mode_resolved': {
        const session = this.sessions.get(sessionId)
        if (session && session.phase === 'needs-interaction') {
          session.phase = 'running'
          session.interactionKind = undefined
          session.attention = false
          session.lastActivityAt = Date.now()
        }
        break
      }
      case 'external_run_started': {
        const session = this.ensureSession(sessionId)
        if (event.title) session.title = event.title
        session.phase = 'running'
        session.attention = false
        session.lastActivityAt = Date.now()
        break
      }
      case 'retry': {
        const session = this.sessions.get(sessionId)
        if (session) {
          session.phase = 'running'
          session.detail = event.status === 'attempt' ? `重试第 ${event.attempt ?? 1} 次` : '等待重试…'
          session.lastActivityAt = Date.now()
        }
        break
      }
      default:
        break
    }
  }

  private handleAgentEvent(sessionId: string, event: Extract<AgentStreamPayload, { kind: 'agent_event' }>['event']): void {
    if (event.type === 'complete') {
      const session = this.ensureSession(sessionId)
      session.phase = 'completed'
      session.detail = '任务已完成'
      session.unread = true
      session.attention = true
      session.terminalAt = Date.now()
      session.lastActivityAt = Date.now()
    } else if (event.type === 'error' || event.type === 'typed_error') {
      const session = this.ensureSession(sessionId)
      session.phase = 'error'
      session.detail = truncate(event.type === 'error' ? event.message : event.error.message ?? '', 60)
      session.unread = true
      session.attention = true
      session.terminalAt = Date.now()
      session.lastActivityAt = Date.now()
    }
  }

  private handleSdkMessage(sessionId: string, message: SDKMessage): void {
    switch (message.type) {
      case 'assistant': {
        const aMsg = message as SDKAssistantMessage
        if (aMsg.isReplay) return
        if (aMsg.error) {
          const session = this.ensureSession(sessionId)
          session.phase = 'error'
          session.detail = truncate(aMsg.error.message || '发生错误', 60)
          session.unread = true
          session.attention = true
          session.terminalAt = Date.now()
          session.lastActivityAt = Date.now()
          return
        }
        const session = this.ensureSession(sessionId)
        session.phase = 'running'
        session.lastActivityAt = Date.now()
        for (const block of aMsg.message.content ?? []) {
          if (block.type === 'text') {
            const textBlock = block as { text?: unknown }
            if (typeof textBlock.text === 'string' && textBlock.text) {
              session.detail = truncate(textBlock.text, 60)
            }
          } else if (block.type === 'tool_use') {
            const toolBlock = block as { name?: string; input?: Record<string, unknown> }
            const toolName = (toolBlock.input?.['_displayName'] as string | undefined) || toolBlock.name || '工具'
            session.detail = `正在使用 ${toolName}`
          }
        }
        break
      }
      case 'result': {
        const rMsg = message as SDKResultMessage
        const session = this.ensureSession(sessionId)
        if (rMsg.subtype === 'success') {
          session.phase = 'completed'
          session.detail = '已完成'
          session.unread = true
          session.attention = true
          session.terminalAt = Date.now()
        } else {
          session.phase = 'error'
          session.detail = truncate(rMsg.errors?.[0] ?? '执行出错', 60)
          session.unread = true
          session.attention = true
          session.terminalAt = Date.now()
        }
        session.lastActivityAt = Date.now()
        break
      }
      case 'system': {
        const sMsg = message as SDKSystemMessage
        const session = this.ensureSession(sessionId)
        const subtype = sMsg.subtype
        if (subtype === 'task_started' || subtype === 'task_progress') {
          session.phase = 'running'
          session.detail = subtype === 'task_started'
            ? truncate(sMsg.description ?? '', 40)
            : (sMsg.last_tool_name ? `子任务正在 ${sMsg.last_tool_name}` : session.detail)
        } else if (subtype === 'compact_boundary') {
          session.detail = '正在压缩上下文…'
        } else if (subtype === 'permission_denied') {
          session.phase = 'needs-interaction'
          session.interactionKind = 'permission'
          session.detail = truncate(sMsg.message ?? '权限被拒绝', 40)
          session.attention = true
        }
        session.lastActivityAt = Date.now()
        break
      }
      default:
        break
    }
  }

  // ===== 推送节流 =====

  /** 更新最近会话快照（最多 MAX_RECENT 条，按最后活动排序） */
  private refreshRecent(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const snapshot: DynamicIslandSessionSnapshot = {
      sessionId: session.sessionId,
      title: session.title,
      phase: session.phase,
      interactionKind: session.interactionKind,
      detail: session.detail,
      attention: session.attention,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
    }
    this.recent = [
      snapshot,
      ...this.recent.filter((item) => item.sessionId !== sessionId),
    ].slice(0, MAX_RECENT)
  }

  private requiresImmediatePush(payload: AgentStreamPayload): boolean {
    if (payload.kind === 'proma_event') {
      return ['permission_request', 'ask_user_request', 'exit_plan_mode_request'].includes(payload.event.type)
    }
    if (payload.kind === 'agent_event') {
      return payload.event.type === 'complete' || payload.event.type === 'error' || payload.event.type === 'typed_error'
    }
    const message = payload.message
    return message.type === 'result' || (message.type === 'assistant' && Boolean(message.error))
  }

  private schedulePush(throttleMs: number): void {
    const now = Date.now()
    const dueAt = this.lastPushAt + throttleMs
    if (now >= dueAt) {
      if (this.pushTimer) {
        clearTimeout(this.pushTimer)
        this.pushTimer = null
      }
      this.lastPushAt = now
      this.pushNow()
      return
    }
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.lastPushAt = Date.now()
      this.pushNow()
    }, dueAt - now)
  }

  private pushNow(): void {
    this.ensureRenderer()
    this.renderPrioritySession()
  }

  // ===== 对外操作 =====

  async notify(input: DynamicIslandNotifyInput, source: DynamicIslandSource = 'ai'): Promise<DynamicIslandActionResult> {
    if (!IS_MAC) return { ok: false, reason: 'unsupported' }
    if (!this.config.enabled) return { ok: false, reason: 'disabled' }
    if (typeof input.title !== 'string' || input.title.trim().length === 0) {
      return { ok: false, reason: 'title required' }
    }

    // AI/手动通知在会话状态机上作为临时快照渲染（不持久化到 sessions）
    try {
      this.ensureRenderer()
      const id = input.id?.trim() || this.genId()
      const level = input.level ?? 'info'
      const timeoutMs =
        typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs >= 0
          ? Math.round(input.timeoutMs)
          : level === 'progress' ? 0 : 4500
      const request: DynamicIslandRequest = {
        id,
        title: truncate(input.title, 48),
        level,
        timeoutMs,
        createdAt: Date.now(),
        source,
        ...(input.body ? { body: truncate(input.body, 72) } : {}),
        ...(input.activateOnClick ? { activateOnClick: true } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }
      this.controller?.show(request)
    } catch (err) {
      console.error('[Dynamic Island] 渲染失败:', err)
      return { ok: false, reason: 'renderer unavailable' }
    }
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

  // ===== 渲染事件 =====

  /** 点击 → dismiss 当前会话 attention；若有下一个 attention 会话则切到它，否则隐藏 */
  private handleClicked(event: Record<string, unknown>): void {
    const id = typeof event.id === 'string' ? event.id : ''
    const sessionId = id.startsWith('session:') ? id.slice('session:'.length) : ''

    if (sessionId) {
      // 会话点击：清除该会话 attention/unread，再重新渲染（切到下一个或隐藏）
      const session = this.sessions.get(sessionId)
      if (session) {
        session.attention = false
        session.unread = false
        if (session.phase === 'completed' || session.phase === 'error') {
          session.terminalAt = undefined
        }
      }
      this.pushNow()

      // 打开对应会话（复用托盘打开逻辑）
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized()
      )
      if (win) {
        win.show()
        win.focus()
        win.webContents.send(TRAY_IPC_CHANNELS.OPEN_AGENT_SESSION, {
          sessionId,
          title: session?.title ?? '',
        })
      }
      return
    }

    // 非会话通知（测试/手动）：仅 dismiss
    this.controller?.dismiss(id)
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

  /** 懒初始化渲染栈（首次 push 时才建） */
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

  // ===== 生命周期 =====

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
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    this.disposeRenderer()
  }
}

/** 单例 */
let service: DynamicIslandService | null = null

export function getDynamicIslandService(): DynamicIslandService {
  service ??= new DynamicIslandService()
  return service
}

/** 灵动岛是否应作为通知主力（mac + 开关开启） */
export function isDynamicIslandPrimary(): boolean {
  if (!IS_MAC) return false
  try {
    const config = loadConfig()
    return config.enabled
  } catch {
    return false
  }
}

export function startDynamicIslandService(): void {
  getDynamicIslandService().start()
}

export function stopDynamicIslandService(): void {
  service?.stop()
  service = null
}
