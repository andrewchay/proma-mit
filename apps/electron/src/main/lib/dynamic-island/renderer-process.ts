/**
 * DynamicIslandRendererProcess — 渲染子进程管理（spawn + 崩溃自愈）。
 *
 * 子进程跑 island.fork.js（加载 island.node 原生窗口）。
 * 启动器优先使用宿主提供的 Electron-as-node，其次 PATH 里的 node。
 * 崩溃重启：60s 内最多 3 次，超过放弃到下次 notify（不空转）。
 * stdin 不可写就丢命令；SIGTERM 后 1.5s 兜底 SIGKILL。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { parseStdout, serializeCmd } from './renderer-protocol'

const KILL_GRACE_MS = 1500
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60000

export interface RendererProcessOptions {
  /** island.fork.js 所在目录（打包后为 process.resourcesPath/dynamic-island） */
  root: string
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void
    warn: (msg: string, meta?: Record<string, unknown>) => void
    error: (msg: string, meta?: Record<string, unknown>) => void
  }
  onEvent: (event: Record<string, unknown>) => void
  onRunningChange?: (isRunning: boolean) => void
}

export function resolveLauncher(): { cmd: string; env: Record<string, string>; spawnOptions: Record<string, unknown> } {
  const isElectron = typeof process.versions.electron === 'string'
  return {
    cmd: process.execPath,
    env: isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    spawnOptions: { windowsHide: true },
  }
}

/** 获取渲染子进程脚本路径（root/dynamic-island/island.fork.js） */
export function getIslandForkScript(root: string): string {
  return join(root, 'island.fork.js')
}

export class DynamicIslandRendererProcess {
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private stdoutBuffer = ''
  private restarts: number[] = []
  private disposed = false
  private startFailCooldownUntil = 0
  private options: RendererProcessOptions

  constructor(options: RendererProcessOptions) {
    this.options = options
  }

  get running(): boolean {
    const { child } = this
    return child?.exitCode === null && child.signalCode === null
  }

  async send(cmd: Record<string, unknown>): Promise<void> {
    if (this.disposed) return
    await this.ensure()
    if (!this.child?.stdin?.writable) {
      this.options.logger.warn('island: stdin not writable, dropping command')
      return
    }
    this.child.stdin.write(serializeCmd(cmd))
  }

  async ensure(): Promise<void> {
    if (this.running || this.disposed) return
    // 脚本缺失导致启动失败时，冷却 30s 内不反复重试刷屏
    if (Date.now() < this.startFailCooldownUntil) return
    this.starting ??= this.start().finally(() => {
      this.starting = null
    })
    await this.starting
  }

  async start(): Promise<void> {
    const { cmd, env, spawnOptions } = resolveLauncher()
    const script = getIslandForkScript(this.options.root)
    if (!existsSync(script)) {
      // 冷启动 30s 内不再重试，避免每次 agent 事件都刷“script not found”
      this.startFailCooldownUntil = Date.now() + 30_000
      this.options.logger.error(`island: fork script not found: ${script}`)
      return
    }
    const child = spawn(cmd, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...spawnOptions,
      windowsHide: true,
      env: { ...process.env, ...env },
    })
    this.child = child

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      const { buffer, events } = parseStdout(this.stdoutBuffer, chunk)
      this.stdoutBuffer = buffer
      for (const event of events) {
        try {
          this.options.onEvent(event)
        } catch (err) {
          this.options.logger.error(`island: onEvent failed: ${String(err)}`)
        }
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      const msg = chunk.trim()
      if (msg.length > 0) this.options.logger.info(msg, { from: 'island-native' })
    })

    child.once('error', (err) => {
      this.startFailCooldownUntil = Date.now() + 15_000
      this.options.logger.error(`island: spawn failed: ${err.message}`, { cmd })
      this.child = null
      this.options.onRunningChange?.(false)
    })

    child.once('exit', (code, signal) => {
      this.child = null
      this.stdoutBuffer = ''
      this.options.onRunningChange?.(false)
      if (!this.disposed) {
        this.options.logger.warn(`island: renderer exited`, { code, signal })
        this.maybeRestart()
      }
    })

    this.options.logger.info(`island: renderer started`, { cmd, script })
    this.options.onRunningChange?.(true)
  }

  private maybeRestart(): void {
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS)
    if (this.restarts.length >= MAX_RESTARTS) {
      this.options.logger.error(`island: too many crashes, giving up until next notify`, { restarts: this.restarts.length })
      this.restarts = []
      return
    }
    this.restarts.push(now)
    this.ensure().catch((err) => this.options.logger.error(`island: restart failed: ${String(err)}`))
  }

  dispose(): void {
    this.disposed = true
    const { child } = this
    this.child = null
    if (!child?.pid) return
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }, KILL_GRACE_MS).unref?.()
  }
}
