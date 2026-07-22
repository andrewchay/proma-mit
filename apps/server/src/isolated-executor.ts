/**
 * 高风险命令的隔离执行边界。
 * API 进程只能依赖此接口，不能直接启动 Shell 或子进程。
 */
export interface IsolatedExecutionRequest {
  taskId: string
  workspaceDir: string
  command: string
  args: readonly string[]
  timeoutMs: number
  maxOutputBytes: number
}

export interface IsolatedExecutionResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface IsolatedExecutor {
  execute(request: IsolatedExecutionRequest, signal: AbortSignal): Promise<IsolatedExecutionResult>
}

/** 在容器 worker 接入前的安全默认值：拒绝执行而不是回退到宿主机。 */
export class DisabledIsolatedExecutor implements IsolatedExecutor {
  async execute(_request: IsolatedExecutionRequest, _signal: AbortSignal): Promise<IsolatedExecutionResult> {
    throw new Error('隔离执行器未配置；服务端 API 进程禁止直接执行 Shell')
  }
}

/** 仅与独立 executor 容器通信的 HTTP 客户端；不包含任何本机进程启动能力。 */
export class HttpIsolatedExecutor implements IsolatedExecutor {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}

  async execute(request: IsolatedExecutionRequest, signal: AbortSignal): Promise<IsolatedExecutionResult> {
    const response = await fetch(new URL('/execute', this.endpoint), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal,
    })
    const body = await response.json() as unknown
    if (!response.ok) throw new Error(`隔离执行器拒绝请求: ${readError(body, response.status)}`)
    if (!isExecutionResult(body)) throw new Error('隔离执行器返回了无效结果')
    return body
  }
}

function isExecutionResult(value: unknown): value is IsolatedExecutionResult {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return Number.isSafeInteger(record.exitCode)
    && typeof record.stdout === 'string'
    && typeof record.stderr === 'string'
    && typeof record.timedOut === 'boolean'
}

function readError(value: unknown, status: number): string {
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') return value.error
  return `HTTP ${status}`
}
