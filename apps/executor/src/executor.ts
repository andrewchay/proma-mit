import { spawn } from 'node:child_process'
import { closeSync, constants, existsSync, openSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const DEFAULT_MAX_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const SANDBOX_BINARY = '/usr/bin/bwrap'
const SANDBOX_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' }

export interface ExecutorPolicy {
  workspaceRoot: string
  allowedCommands: readonly string[]
  maxTimeoutMs?: number
  maxOutputBytes?: number
}
export interface ExecutorRequest {
  taskId: string
  workspaceDir: string
  command: string
  args: string[]
  timeoutMs: number
  maxOutputBytes: number
}
export interface ExecutorResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean }

/** Linux namespace 沙箱不可用时拒绝执行，绝不回退为只设置 cwd 的宿主进程。 */
export async function executeIsolatedCommand(request: ExecutorRequest, policy: ExecutorPolicy, signal?: AbortSignal): Promise<ExecutorResult> {
  const workspace = validateRequest(request, policy)
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
  if (process.platform !== 'linux' || !existsSync(SANDBOX_BINARY)) throw new Error('隔离执行器需要 Linux bubblewrap；禁止在无沙箱环境执行')
  const timeoutMs = Math.min(request.timeoutMs, policy.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS)
  const maxBytes = Math.min(request.maxOutputBytes, policy.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
  const directory = openSync(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  return new Promise((resolveResult, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      if (realpathSync('/proc/self/fd/' + directory) !== workspace) throw new Error('工作区在校验后发生变化')
      child = spawn(SANDBOX_BINARY, buildSandboxArgs(3, request), {
        env: SANDBOX_ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe', directory],
      })
    } finally { closeSync(directory) }
    let timedOut = false
    const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    const truncated = { stdout: false, stderr: false }
    // 继续排空管道但只保留上限内字节，避免取消读取造成子进程挂起。
    for (const key of ['stdout', 'stderr'] as const) {
      child[key]!.on('data', (chunk: Buffer) => {
        const remaining = maxBytes - output[key].length
        truncated[key] ||= chunk.length > remaining
        if (remaining > 0) output[key] = Buffer.concat([output[key], chunk.subarray(0, remaining)])
      })
    }
    const kill = (): void => {
      if (!child.pid) return
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    const cancel = (): void => { kill() }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
    child.once('error', (error) => { cleanup(); reject(error) })
    child.once('close', (code) => {
      cleanup()
      if (signal?.aborted) { reject(new DOMException('任务已取消', 'AbortError')); return }
      resolveResult({
        exitCode: code ?? 137, timedOut,
        stdout: output.stdout.toString('utf8') + (truncated.stdout ? '\n[输出已截断]' : ''),
        stderr: output.stderr.toString('utf8') + (truncated.stderr ? '\n[输出已截断]' : ''),
      })
    })
  })
}

/** 仅映射系统运行库与当前目录；不映射 /app、/data、宿主 /tmp、环境凭证或网络。 */
export function buildSandboxArgs(workspaceFd: number, request: ExecutorRequest): string[] {
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv']
  for (const path of ['/usr', '/bin', '/lib', '/lib64']) {
    if (existsSync(path)) args.push('--ro-bind', path, path)
  }
  args.push('--dir', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/workspace',
    '--bind-fd', String(workspaceFd), '/workspace', '--chdir', '/workspace',
    '--setenv', 'PATH', SANDBOX_ENV.PATH, '--setenv', 'HOME', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8', '--', request.command, ...request.args)
  return args
}

function validateRequest(request: ExecutorRequest, policy: ExecutorPolicy): string {
  if (!request || typeof request.taskId !== 'string' || !request.taskId.trim() || typeof request.command !== 'string') throw new Error('执行请求缺少 taskId 或 command')
  if (!/^[A-Za-z0-9._-]+$/.test(request.command) || !policy.allowedCommands.includes(request.command)) throw new Error('命令不在隔离执行器 allowlist')
  if (!Array.isArray(request.args) || request.args.length > 50 || request.args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 65_536)) throw new Error('命令参数不合法')
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1) throw new Error('timeoutMs 或 maxOutputBytes 不合法')
  if (typeof request.workspaceDir !== 'string' || !isAbsolute(request.workspaceDir) || request.workspaceDir.includes('\0')) throw new Error('工作区必须使用绝对路径')
  const root = realpathSync(policy.workspaceRoot)
  const path = realpathSync(resolve(request.workspaceDir))
  const inside = relative(root, path)
  if (!inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside) || !statSync(path).isDirectory()) throw new Error('工作区不在隔离执行器挂载范围内，不能挂载整个共享根目录')
  return path
}
