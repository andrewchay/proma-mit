import { executeIsolatedCommand } from './executor.ts'

const token = requireEnvironment('PROMA_EXECUTOR_TOKEN')
const workspaceRoot = process.env.PROMA_EXECUTOR_WORKSPACE_ROOT ?? '/data/workspaces'
const allowedCommands = (process.env.PROMA_EXECUTOR_ALLOWED_COMMANDS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
const maxTimeoutMs = parsePositiveInteger(process.env.PROMA_EXECUTOR_MAX_TIMEOUT_MS) ?? 60_000
const maxOutputBytes = parsePositiveInteger(process.env.PROMA_EXECUTOR_MAX_OUTPUT_BYTES) ?? 256 * 1024

const server = Bun.serve({
  port: Number.parseInt(process.env.PROMA_EXECUTOR_PORT ?? '3010', 10),
  hostname: process.env.PROMA_EXECUTOR_HOST ?? '0.0.0.0',
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/healthz') return Response.json({ status: 'ok' })
    if (request.method !== 'POST' || url.pathname !== '/execute') return Response.json({ error: 'not found' }, { status: 404 })
    if (request.headers.get('authorization') !== `Bearer ${token}`) return Response.json({ error: 'unauthorized' }, { status: 401 })
    try {
      const body = await request.json()
      const result = await executeIsolatedCommand(body as import('./executor.ts').ExecutorRequest, {
        workspaceRoot,
        allowedCommands,
        maxTimeoutMs,
        maxOutputBytes,
      })
      return Response.json(result)
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
    }
  },
})

console.info(`Proma 隔离执行器已启动: http://${server.hostname}:${server.port}`)

function requireEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`缺少必要环境变量: ${name}`)
  return value
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('执行器限制必须是正整数')
  return parsed
}
