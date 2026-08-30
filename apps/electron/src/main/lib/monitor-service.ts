/**
 * MonitorService - 监听任务管理（完整实现）
 *
 * 管理各类 Monitor（文件监听、会话超时、Webhook、GitHub、命令监听），
 * 将事件转换为 TaskRun 并通过 AppEventBus 触发执行。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { getProactiveConfigPath } from './config-paths'
import type { ProactiveMonitor, MonitorTrigger, ProactiveTaskRun, ProactiveExecutionTarget } from '@gravitas/shared'
import { ProactiveSchedulerStore } from './proactive-scheduler-store'

const MONITORS_FILE = 'monitors.json'

/** 内存中的 monitor 状态 */
let monitorsCache: ProactiveMonitor[] | null = null

/** 文件监听器映射 */
const fileWatchers = new Map<string, FSWatcher>()

/** 命令轮询计时器映射 */
const commandTimers = new Map<string, NodeJS.Timeout>()

/** GitHub monitor 的本地轮询计时器。 */
const githubTimers = new Map<string, NodeJS.Timeout>()
const GITHUB_POLL_INTERVAL_MS = 5 * 60 * 1000

/** 防抖计时器 */
const debounceTimers = new Map<string, NodeJS.Timeout>()

/** 上次命令输出缓存（用于检测变化） */
const lastCommandOutput = new Map<string, string>()

/** Monitor 与 Scheduler 共用同一个本地运行事实源。 */
const runStore = new ProactiveSchedulerStore()

export interface MonitorRunResult {
  outputSummary?: string
  sessionId?: string
}

export type MonitorRunner = (
  monitor: ProactiveMonitor,
  run: ProactiveTaskRun,
  eventData?: unknown,
) => Promise<MonitorRunResult>

let monitorRunner: MonitorRunner | undefined

/** 由 Agent 服务注入，避免 Monitor 层自行猜测渠道或权限。 */
export function setMonitorRunner(runner: MonitorRunner): void {
  monitorRunner = runner
}

function getMonitorsFilePath(): string {
  return join(getProactiveConfigPath(), MONITORS_FILE)
}

function ensureDir(): void {
  const dir = getProactiveConfigPath()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function loadMonitors(): ProactiveMonitor[] {
  if (monitorsCache) return monitorsCache
  const path = getMonitorsFilePath()
  if (!existsSync(path)) return []
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    monitorsCache = Array.isArray(data) ? data : []
    return monitorsCache
  } catch {
    return []
  }
}

function saveMonitors(monitors: ProactiveMonitor[]): void {
  ensureDir()
  writeFileSync(getMonitorsFilePath(), JSON.stringify(monitors, null, 2))
  monitorsCache = monitors
}

// ===== CRUD =====

export function listMonitors(): ProactiveMonitor[] {
  return loadMonitors()
}

export function getMonitor(id: string): ProactiveMonitor | undefined {
  return loadMonitors().find((m) => m.id === id)
}

export interface CreateMonitorInput {
  title: string
  routineId: string
  routineInstanceId?: string
  execution: ProactiveExecutionTarget
  trigger: MonitorTrigger
  debounceMs?: number
}

export function createMonitor(input: CreateMonitorInput): ProactiveMonitor {
  validateExecutionTarget(input.execution)
  const monitor: ProactiveMonitor = {
    id: randomUUID(),
    title: input.title,
    routineId: input.routineId,
    routineInstanceId: input.routineInstanceId,
    execution: {
      ...input.execution,
      permissionMode: input.execution.permissionMode ?? 'safe',
      newSession: input.execution.newSession ?? false,
    },
    trigger: input.trigger,
    enabled: true,
    debounceMs: input.debounceMs ?? 5000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const monitors = loadMonitors()
  monitors.push(monitor)
  saveMonitors(monitors)
  return monitor
}

export function updateMonitor(id: string, updates: Partial<Omit<ProactiveMonitor, 'id' | 'createdAt'>>): ProactiveMonitor | null {
  const monitors = loadMonitors()
  const idx = monitors.findIndex((m) => m.id === id)
  if (idx === -1) return null
  const updated = { ...monitors[idx], ...updates, updatedAt: Date.now() }
  monitors[idx] = updated as ProactiveMonitor
  saveMonitors(monitors)
  return monitors[idx]
}

export function deleteMonitor(id: string): boolean {
  const monitors = loadMonitors()
  const filtered = monitors.filter((m) => m.id !== id)
  if (filtered.length === monitors.length) return false
  saveMonitors(filtered)
  // 清理所有资源
  stopMonitorResources(id)
  return true
}

export function setMonitorEnabled(id: string, enabled: boolean): boolean {
  const result = updateMonitor(id, { enabled })
  if (!result) return false
  // 启用/禁用后重新管理监听器
  if (enabled) {
    startSingleMonitor(result)
  } else {
    stopMonitorResources(id)
  }
  return true
}

/** 停止某个 monitor 的所有资源 */
function stopMonitorResources(monitorId: string): void {
  // 停止文件监听
  const watcher = fileWatchers.get(monitorId)
  if (watcher) {
    watcher.close().catch(() => {})
    fileWatchers.delete(monitorId)
  }
  // 停止命令轮询
  const timer = commandTimers.get(monitorId)
  if (timer) {
    clearInterval(timer)
    commandTimers.delete(monitorId)
  }
  const githubTimer = githubTimers.get(monitorId)
  if (githubTimer) {
    clearInterval(githubTimer)
    githubTimers.delete(monitorId)
  }
  // 清理防抖计时器
  if (debounceTimers.has(monitorId)) {
    clearTimeout(debounceTimers.get(monitorId)!)
    debounceTimers.delete(monitorId)
  }
  // 清理命令输出缓存
  lastCommandOutput.delete(monitorId)
}

// ===== 事件触发 =====

/**
 * 触发 Monitor 事件（带防抖），创建 TaskRun 并执行
 */
export function triggerMonitorEvent(monitorId: string, eventData?: unknown): void {
  const monitor = getMonitor(monitorId)
  if (!monitor || !monitor.enabled) return

  // 清理旧计时器
  if (debounceTimers.has(monitorId)) {
    clearTimeout(debounceTimers.get(monitorId)!)
  }

  // 设置新防抖计时器
  const timer = setTimeout(() => {
    debounceTimers.delete(monitorId)
    void handleMonitorEvent(monitor, eventData)
  }, monitor.debounceMs)

  debounceTimers.set(monitorId, timer)
}

/**
 * 处理 Monitor 事件，创建 TaskRun 并通过 AppEventBus 触发执行
 */
async function handleMonitorEvent(monitor: ProactiveMonitor, eventData?: unknown): Promise<void> {
  console.log(`[MonitorService] 事件触发: ${monitor.title} (${monitor.id})`)

  const now = Date.now()
  updateMonitor(monitor.id, { lastEventAt: now, lastRunAt: now })

  let run = createMonitorTaskRun(monitor)
  emitMonitorRunEvent(monitor, run, 'started', eventData)

  try {
    if (!monitorRunner) throw new Error('Monitor 执行器未就绪')
    const result = await monitorRunner(monitor, run, eventData)
    run = runStore.saveRun({
      ...run,
      status: 'success',
      endedAt: Date.now(),
      outputSummary: result.outputSummary,
      sessionId: result.sessionId ?? run.sessionId,
    })
    emitMonitorRunEvent(monitor, run, 'completed', eventData)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Monitor 执行失败'
    run = runStore.saveRun({ ...run, status: 'failed', endedAt: Date.now(), error: message })
    emitMonitorRunEvent(monitor, run, 'failed', eventData)
    console.error('[MonitorService] 执行失败:', error)
  }
}

function createMonitorTaskRun(monitor: ProactiveMonitor): ProactiveTaskRun {
  return runStore.saveRun({
    id: randomUUID(),
    sourceType: 'monitor',
    sourceId: monitor.id,
    sessionId: monitor.execution.sessionId,
    status: 'running',
    trigger: 'event',
    startedAt: Date.now(),
  })
}

function emitMonitorRunEvent(
  monitor: ProactiveMonitor,
  run: ProactiveTaskRun,
  type: 'started' | 'completed' | 'failed',
  eventData?: unknown,
): void {
  try {
    const { getRunStore } = require('./run-store') as { getRunStore: () => { record: (event: import('@gravitas/shared').AppEventEnvelope) => void } }
    const eventDetail = eventData ? ` · ${JSON.stringify(eventData).slice(0, 200)}` : ''
    getRunStore().record({
      id: `monitor-run-${run.id}`,
      source: 'automation',
      taskId: run.id,
      title: monitor.title,
      timestamp: Date.now(),
      ...(type === 'started'
        ? { type: 'started' as const, detail: `监听触发: ${monitor.trigger.type}${eventDetail}` }
        : type === 'completed'
          ? { type: 'completed' as const, detail: run.outputSummary ?? `监听执行完成${eventDetail}` }
          : { type: 'failed' as const, detail: run.error ?? `监听执行失败${eventDetail}` }),
    })
  } catch {
    // 统一运行中心不可用时不阻塞本地执行和持久化。
  }
}

function validateExecutionTarget(target: ProactiveExecutionTarget): void {
  if (!target.channelId.trim() || !target.prompt.trim()) {
    throw new Error('Monitor 缺少渠道或执行内容')
  }
  if (!target.newSession && !target.sessionId?.trim()) {
    throw new Error('复用会话的 Monitor 缺少目标会话')
  }
}

// ===== 文件监听实现 =====

/**
 * 启动文件监听（使用 chokidar）
 */
export function startFileMonitor(monitor: ProactiveMonitor): void {
  if (monitor.trigger.type !== 'file') return

  const { path, events } = monitor.trigger

  // 如果已存在监听器，先关闭
  stopMonitorResources(monitor.id)

  const watcher = watch(path, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  })

  watcher.on('all', (event, filePath) => {
    // 映射 chokidar 事件到 monitor 事件
    const eventMap: Record<string, string> = {
      add: 'create',
      change: 'modify',
      unlink: 'delete',
      addDir: 'create',
      unlinkDir: 'delete',
    }
    const mappedEvent = eventMap[event]
    if (!mappedEvent || !events.includes(mappedEvent as 'create' | 'modify' | 'delete')) return

    triggerMonitorEvent(monitor.id, { event: mappedEvent, path: filePath })
  })

  watcher.on('error', (error) => {
    console.error(`[MonitorService] 文件监听错误 (${monitor.id}):`, error)
  })

  fileWatchers.set(monitor.id, watcher)
  console.log(`[MonitorService] 文件监听已启动: ${path} (${monitor.id})`)
}

// ===== 会话超时检测 =====

/**
 * 检查单个会话超时 monitor
 */
function checkSessionMonitor(monitor: ProactiveMonitor): void {
  if (monitor.trigger.type !== 'session') return

  const { maxIdleMs } = monitor.trigger

  try {
    const { listAgentSessions } = require('./agent-session-manager') as { listAgentSessions: () => Array<{ id: string; lastMessageAt?: number; updatedAt?: number }> }
    const sessions = listAgentSessions()
    const now = Date.now()

    for (const session of sessions) {
      const lastActive = session.lastMessageAt ?? session.updatedAt ?? 0
      if (lastActive > 0 && now - lastActive > maxIdleMs) {
        triggerMonitorEvent(monitor.id, {
          sessionId: session.id,
          idleMs: now - lastActive,
          thresholdMs: maxIdleMs,
        })
      }
    }
  } catch (error) {
    console.error('[MonitorService] 会话检查失败:', error)
  }
}

// ===== Webhook 监听 =====

/**
 * Webhook monitor 不需要常驻监听器。
 * 外部事件通过 HTTP 端点接收后调用 triggerMonitorEvent。
 * 这里仅做验证和日志记录。
 */
export function startWebhookMonitor(monitor: ProactiveMonitor): void {
  if (monitor.trigger.type !== 'webhook') return
  console.log(`[MonitorService] Webhook monitor 已注册: ${monitor.trigger.endpoint} (${monitor.id})`)
}

/**
 * 验证 Webhook 请求签名（如果配置了 secret）
 */
export function verifyWebhookSignature(monitorId: string, payload: string, signature?: string): boolean {
  const monitor = getMonitor(monitorId)
  if (!monitor || monitor.trigger.type !== 'webhook') return false

  const { secret } = monitor.trigger
  if (!secret) return true // 无 secret 时不验证

  if (!signature) return false

  try {
    const { createHmac } = require('node:crypto')
    const expected = createHmac('sha256', secret).update(payload).digest('hex')
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

/**
 * 供受管 HTTP/IPC bridge 转发 Webhook。
 * 不在 Electron 主进程直接开放网络端口；bridge 必须显式传入 monitor ID，
 * 并在配置了 secret 时通过 HMAC 校验后才能触发执行。
 */
export function receiveWebhookEvent(
  monitorId: string,
  payload: string,
  signature?: string,
): { accepted: boolean; error?: string } {
  const monitor = getMonitor(monitorId)
  if (!monitor || monitor.trigger.type !== 'webhook') return { accepted: false, error: 'Webhook monitor 不存在' }
  if (!monitor.enabled) return { accepted: false, error: 'Webhook monitor 已停用' }
  if (!verifyWebhookSignature(monitorId, payload, signature)) return { accepted: false, error: 'Webhook 签名无效' }
  triggerMonitorEvent(monitorId, { webhook: true, payloadLength: payload.length })
  return { accepted: true }
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a[i]! ^ b[i]!
  }
  return result === 0
}

// ===== GitHub 监听 =====

/**
 * GitHub monitor 使用轮询方式检查事件。
 * 实际生产环境建议使用 GitHub Webhook + Webhook monitor。
 */
export function startGitHubMonitor(monitor: ProactiveMonitor): void {
  if (monitor.trigger.type !== 'github') return
  stopMonitorResources(monitor.id)
  console.log(`[MonitorService] GitHub monitor 已注册: ${monitor.trigger.repo} (${monitor.id})`)
  void pollGitHubMonitor(monitor.id)
  githubTimers.set(monitor.id, setInterval(() => {
    void pollGitHubMonitor(monitor.id)
  }, GITHUB_POLL_INTERVAL_MS))
}

/**
 * 轮询 GitHub API 检查新事件（供外部定时调用）
 */
export async function pollGitHubMonitor(monitorId: string): Promise<void> {
  const monitor = getMonitor(monitorId)
  if (!monitor || monitor.trigger.type !== 'github') return

  const { repo, events: eventTypes } = monitor.trigger

  try {
    // 使用 GitHub API 轮询（无认证，速率限制 60/hr）
    const response = await fetch(`https://api.github.com/repos/${repo}/events?per_page=10`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
    })

    if (!response.ok) {
      console.warn(`[MonitorService] GitHub API 错误: ${response.status}`)
      return
    }

    const events = await response.json() as Array<{ type: string; created_at: string }>
    const now = Date.now()
    const lastCheck = monitor.lastRunAt ?? 0

    for (const event of events) {
      const eventTime = new Date(event.created_at).getTime()
      if (eventTime > lastCheck && eventTypes.includes(event.type)) {
        triggerMonitorEvent(monitor.id, { type: event.type, repo })
      }
    }

    updateMonitor(monitor.id, { lastRunAt: now })
  } catch (error) {
    console.error(`[MonitorService] GitHub 轮询失败 (${monitor.id}):`, error)
  }
}

// ===== 命令监听 =====

/**
 * 启动命令轮询 monitor
 */
export function startCommandMonitor(monitor: ProactiveMonitor): void {
  if (monitor.trigger.type !== 'command') return

  // 如果已存在轮询，先停止
  stopMonitorResources(monitor.id)

  const { command, intervalMs } = monitor.trigger
  const timer = setInterval(() => {
    void executeCommandMonitor(monitor.id, command)
  }, Math.max(intervalMs, 5000)) // 最小 5 秒间隔

  commandTimers.set(monitor.id, timer)
  console.log(`[MonitorService] 命令轮询已启动: ${command} (每 ${intervalMs}ms) (${monitor.id})`)
}

async function executeCommandMonitor(monitorId: string, command: string): Promise<void> {
  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const previous = lastCommandOutput.get(monitorId)
    lastCommandOutput.set(monitorId, output)

    // 如果输出变化，触发事件
    if (previous !== undefined && previous !== output) {
      triggerMonitorEvent(monitorId, { command, outputChanged: true, outputLength: output.length })
    }
  } catch (error) {
    // 命令执行失败也触发事件（错误状态变化）
    const errorMessage = error instanceof Error ? error.message : '命令执行失败'
    const previous = lastCommandOutput.get(monitorId)
    if (previous !== `ERROR: ${errorMessage}`) {
      lastCommandOutput.set(monitorId, `ERROR: ${errorMessage}`)
      triggerMonitorEvent(monitorId, { command, error: errorMessage })
    }
  }
}

// ===== 启动/停止 =====

let monitorInterval: NodeJS.Timeout | null = null

/**
 * 启动所有启用的 Monitor
 */
export function startAllMonitors(): void {
  const monitors = loadMonitors().filter((m) => m.enabled)
  for (const monitor of monitors) {
    startSingleMonitor(monitor)
  }

  // 定期检查会话超时（每 5 分钟）
  if (!monitorInterval) {
    monitorInterval = setInterval(checkAllSessionMonitors, 5 * 60 * 1000)
  }

  console.log(`[MonitorService] 已启动 ${monitors.length} 个 monitor`)
}

function startSingleMonitor(monitor: ProactiveMonitor): void {
  switch (monitor.trigger.type) {
    case 'file':
      startFileMonitor(monitor)
      break
    case 'session':
      // 会话 monitor 由全局定时器统一检查
      break
    case 'webhook':
      startWebhookMonitor(monitor)
      break
    case 'github':
      startGitHubMonitor(monitor)
      break
    case 'command':
      startCommandMonitor(monitor)
      break
  }
}

/**
 * 停止所有 Monitor
 */
export function stopAllMonitors(): void {
  // 停止所有文件监听
  for (const [id, watcher] of fileWatchers) {
    watcher.close().catch(() => {})
    console.log(`[MonitorService] 文件监听已停止: ${id}`)
  }
  fileWatchers.clear()

  // 停止所有命令轮询
  for (const [id, timer] of commandTimers) {
    clearInterval(timer)
    console.log(`[MonitorService] 命令轮询已停止: ${id}`)
  }
  commandTimers.clear()

  for (const [id, timer] of githubTimers) {
    clearInterval(timer)
    console.log(`[MonitorService] GitHub 监听已停止: ${id}`)
  }
  githubTimers.clear()

  // 停止全局定时器
  if (monitorInterval) {
    clearInterval(monitorInterval)
    monitorInterval = null
  }

  // 清理所有防抖计时器
  for (const [id, timer] of debounceTimers) {
    clearTimeout(timer)
  }
  debounceTimers.clear()

  lastCommandOutput.clear()
}

/** 仅用于行为测试，清理模块级缓存和计时器。 */
export function resetMonitorServiceForTests(): void {
  stopAllMonitors()
  monitorsCache = null
  monitorRunner = undefined
}

function checkAllSessionMonitors(): void {
  const monitors = loadMonitors().filter((m) => m.enabled && m.trigger.type === 'session')
  for (const monitor of monitors) {
    checkSessionMonitor(monitor)
  }
}

// ===== IPC 处理器注册 =====

export function registerMonitorIPCHandlers(): void {
  const { ipcMain } = require('electron')

  ipcMain.handle('proactive:listMonitors', () => listMonitors())
  ipcMain.handle('proactive:createMonitor', (_event: unknown, input: CreateMonitorInput) => createMonitor(input))
  ipcMain.handle('proactive:updateMonitor', (_event: unknown, id: string, updates: Partial<Omit<ProactiveMonitor, 'id' | 'createdAt'>>) => updateMonitor(id, updates))
  ipcMain.handle('proactive:deleteMonitor', (_event: unknown, id: string) => deleteMonitor(id))
  ipcMain.handle('proactive:setMonitorEnabled', (_event: unknown, id: string, enabled: boolean) => setMonitorEnabled(id, enabled))
  ipcMain.handle('proactive:receiveWebhook', (_event: unknown, id: string, payload: string, signature?: string) => receiveWebhookEvent(id, payload, signature))
}
