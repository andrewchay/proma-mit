import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { BrowserWindow } from 'electron'
import { spawn, type IPty } from 'node-pty'
import { TERMINAL_IPC_CHANNELS } from '@gravitas/shared'
import type { TerminalCreateInput, TerminalInput, TerminalOutputEvent, TerminalResizeInput, TerminalSnapshot, TerminalState } from '@gravitas/shared'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentWorkspaceCwd, listAgentWorkspaces } from './agent-workspace-manager'
import { appendTerminalOutput } from './terminal-output-buffer'

interface ManagedTerminal {
  pty: IPty
  state: TerminalState
  output: string
  sequence: number
}

const terminals = new Map<string, ManagedTerminal>()
const MAX_OUTPUT_CHARS = 200_000

function requireSessionCwd(sessionId: string): string {
  const session = getAgentSessionMeta(sessionId)
  if (!session) throw new Error('终端所属 Agent 会话不存在')
  const workspace = listAgentWorkspaces().find((item) => item.id === session.workspaceId)
  if (!workspace) throw new Error('终端所属工作区不存在')
  const cwd = getAgentWorkspaceCwd(workspace, sessionId)
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('终端工作目录不可用')
  return cwd
}

function resolveShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

function safeEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value
  environment.HOME ||= homedir()
  environment.TERM = 'xterm-256color'
  return environment
}

function sendToMainWindow(channel: string, payload: unknown): void {
  const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
  window?.webContents.send(channel, payload)
}

export function createTerminal(input: TerminalCreateInput): TerminalState {
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(input.terminalId)) throw new Error('终端 ID 无效')
  if (!Number.isSafeInteger(input.cols) || !Number.isSafeInteger(input.rows) || input.cols < 2 || input.cols > 500 || input.rows < 1 || input.rows > 300) {
    throw new Error('终端尺寸无效')
  }
  const existing = terminals.get(input.terminalId)
  if (existing) {
    if (existing.state.sessionId !== input.sessionId) throw new Error('终端 ID 已属于其他会话')
    return existing.state
  }
  const cwd = requireSessionCwd(input.sessionId)
  const pty = spawn(resolveShell(), process.platform === 'win32' ? [] : ['-l'], {
    name: 'xterm-256color', cols: input.cols, rows: input.rows, cwd, env: safeEnvironment(),
  })
  const state: TerminalState = { terminalId: input.terminalId, sessionId: input.sessionId, cwd, pid: pty.pid }
  const managed: ManagedTerminal = { pty, state, output: '', sequence: 0 }
  terminals.set(input.terminalId, managed)
  pty.onData((data) => {
    const next = appendTerminalOutput(managed, data, MAX_OUTPUT_CHARS)
    managed.output = next.output
    managed.sequence = next.sequence
    const event: TerminalOutputEvent = { terminalId: input.terminalId, sequence: managed.sequence, data }
    sendToMainWindow(TERMINAL_IPC_CHANNELS.OUTPUT, event)
  })
  pty.onExit(({ exitCode, signal }) => {
    terminals.delete(input.terminalId)
    sendToMainWindow(TERMINAL_IPC_CHANNELS.EXIT, { terminalId: input.terminalId, exitCode, signal })
  })
  return state
}

export function writeTerminal(input: TerminalInput): void { terminals.get(input.terminalId)?.pty.write(input.data) }
export function resizeTerminal(input: TerminalResizeInput): void {
  if (Number.isSafeInteger(input.cols) && Number.isSafeInteger(input.rows) && input.cols >= 2 && input.cols <= 500 && input.rows >= 1 && input.rows <= 300) {
    terminals.get(input.terminalId)?.pty.resize(input.cols, input.rows)
  }
}
export function getTerminalSnapshot(terminalId: string): TerminalSnapshot {
  const terminal = terminals.get(terminalId)
  if (!terminal) throw new Error('终端不存在或已经退出')
  return { state: terminal.state, output: terminal.output, sequence: terminal.sequence }
}
export function killTerminal(terminalId: string): void {
  const terminal = terminals.get(terminalId)
  if (!terminal) return
  terminals.delete(terminalId)
  terminal.pty.kill()
}
