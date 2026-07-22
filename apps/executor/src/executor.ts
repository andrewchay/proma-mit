const DEFAULT_MAX_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024

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

export interface ExecutorResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** 在独立容器内执行 allowlist 命令，绝不拼接或解释 shell 字符串。 */
export async function executeIsolatedCommand(request: ExecutorRequest, policy: ExecutorPolicy): Promise<ExecutorResult> {
  validateRequest(request, policy)
  const timeoutMs = Math.min(request.timeoutMs, policy.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS)
  const maxOutputBytes = Math.min(request.maxOutputBytes, policy.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
  const process = Bun.spawn([request.command, ...request.args], {
    cwd: request.workspaceDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    process.kill('SIGKILL')
  }, timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      readBoundedOutput(process.stdout, maxOutputBytes),
      readBoundedOutput(process.stderr, maxOutputBytes),
    ])
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timeout)
  }
}

function validateRequest(request: ExecutorRequest, policy: ExecutorPolicy): void {
  if (!request.taskId || !request.command) throw new Error('执行请求缺少 taskId 或 command')
  if (!policy.allowedCommands.includes(request.command)) throw new Error(`命令不在隔离执行器 allowlist: ${request.command}`)
  if (!Array.isArray(request.args) || request.args.length > 50 || request.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('命令参数不合法')
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1) {
    throw new Error('timeoutMs 或 maxOutputBytes 不合法')
  }
  const root = normalizeWorkspacePath(policy.workspaceRoot)
  const workspace = normalizeWorkspacePath(request.workspaceDir)
  if (workspace !== root && !workspace.startsWith(`${root}/`)) throw new Error('工作区不在隔离执行器挂载范围内')
}

async function readBoundedOutput(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const remaining = maxBytes - size
      if (remaining <= 0) {
        await reader.cancel()
        break
      }
      const chunk = next.value.byteLength > remaining ? next.value.subarray(0, remaining) : next.value
      chunks.push(chunk)
      size += chunk.byteLength
      if (size >= maxBytes) {
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(concatenate(chunks, size)) + (size >= maxBytes ? '\n[输出已截断]' : '')
}

function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function normalizeWorkspacePath(value: string): string {
  if (!value.startsWith('/')) throw new Error('工作区必须使用容器内绝对路径')
  const parts = value.split('/').filter(Boolean)
  if (parts.includes('..') || value.includes('\0')) throw new Error('工作区路径不合法')
  return `/${parts.join('/')}`
}
