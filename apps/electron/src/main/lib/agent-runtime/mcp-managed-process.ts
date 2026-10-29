import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

/** 监督者自己作为进程组组长发信号，避免由外部按可能复用的 PID 清理后代。 */
const SUPERVISOR_SOURCE = String.raw`
const { spawn } = require('node:child_process')
let target
let stopping = false
process.on('SIGTERM', () => {})
function stop() {
  if (stopping) return
  stopping = true
  try { if (target && target.stdin) target.stdin.end() } catch {}
  try { process.kill(-process.pid, 'SIGTERM') } catch {}
  setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(1) } }, 500)
}
process.on('disconnect', stop)
process.on('message', message => {
  if (message && message.type === 'stop') return stop()
  if (!message || message.type !== 'start' || target) return
  try {
    target = spawn(message.command, message.args, { cwd: message.cwd, env: message.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    target.on('error', error => { if (process.connected) process.send({ type: 'error', message: error.message }); stop() })
    target.on('spawn', () => { if (process.connected) process.send({ type: 'ready' }) })
    target.on('exit', (code, signal) => { if (process.connected) process.send({ type: 'target-exit', code, signal }) })
    process.stdin.pipe(target.stdin)
    target.stdout.pipe(process.stdout)
    target.stderr.pipe(process.stderr)
    target.stdin.on('error', () => {})
  } catch (error) {
    if (process.connected) process.send({ type: 'error', message: String(error) })
    stop()
  }
})
`

export interface ManagedMcpProcessOptions {
  command: string
  args?: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface ManagedMcpStopResult {
  status: 'unconfirmed'
  reason: string
}

export interface ManagedMcpProcess {
  pid: number
  stdin: Writable
  stdout: Readable
  stderr: Readable
  process: ChildProcess
  close(): Promise<ManagedMcpStopResult>
}

/** 启动隔离组内监督者；目前只提供基础进程接口，尚未接入 MCP transport。 */
export async function startManagedMcpProcess(options: ManagedMcpProcessOptions): Promise<ManagedMcpProcess> {
  if (process.platform === 'win32') throw new Error('当前平台不支持受管 MCP 进程组')
  const child = spawn(process.execPath, ['-e', SUPERVISOR_SOURCE], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  if (!child.stdin || !child.stdout || !child.stderr || !child.pid) throw new Error('无法创建受管 MCP 监督进程')

  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return
      if (message.type === 'ready') resolve()
      if (message.type === 'error') reject(new Error('message' in message ? String(message.message) : '受管 MCP 服务启动失败'))
    })
    child.once('error', reject)
    child.once('exit', () => reject(new Error('受管 MCP 监督进程提前退出')))
  })
  child.send({ type: 'start', ...options }, (error) => { if (error) child.disconnect() })
  await ready
  const stdin = child.stdin
  const stdout = child.stdout
  const stderr = child.stderr
  let closing: Promise<ManagedMcpStopResult> | undefined
  return {
    pid: child.pid,
    stdin,
    stdout,
    stderr,
    process: child,
    close() {
      closing ??= (async () => {
        if (child.connected) child.send({ type: 'stop' }, () => {})
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([exited, new Promise<void>((resolve) => { timeout = setTimeout(resolve, 3000) })])
        } finally { if (timeout) clearTimeout(timeout) }
        return { status: 'unconfirmed', reason: '监督进程退出不能证明脱离进程组的后代已退出' }
      })()
      return closing
    },
  }
}
