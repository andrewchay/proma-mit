export const TERMINAL_IPC_CHANNELS = {
  CREATE: 'terminal:create',
  INPUT: 'terminal:input',
  RESIZE: 'terminal:resize',
  KILL: 'terminal:kill',
  SNAPSHOT: 'terminal:snapshot',
  OUTPUT: 'terminal:output',
  EXIT: 'terminal:exit',
} as const

export interface TerminalCreateInput {
  terminalId: string
  sessionId: string
  cols: number
  rows: number
}

export interface TerminalInput { terminalId: string; data: string }
export interface TerminalResizeInput { terminalId: string; cols: number; rows: number }

export interface TerminalState {
  terminalId: string
  sessionId: string
  cwd: string
  pid: number
}

export interface TerminalOutputEvent { terminalId: string; sequence: number; data: string }
export interface TerminalSnapshot { state: TerminalState; output: string; sequence: number }
export interface TerminalExitEvent { terminalId: string; exitCode: number; signal?: number }
