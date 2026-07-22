import {
  AgentRuntimeEventReplayHub,
  createAgentRuntimeWebServer,
  createWebCryptoEnvelopeSecretCodec,
  createAgentRuntimeWorkspaceObjectKey,
  normalizeRelativeObjectPath,
  parseWebCryptoEnvelopeKey,
  PostgresTenantRuntimeStore,
  RedisAgentRuntimeEventStore,
} from '@proma/shared/utils'
import type {
  AgentRuntimePostgresClient,
  AgentRuntimeRedisClient,
  AgentRuntimeScope,
  AgentRuntimeWebAgentTurnRunner,
  AgentRuntimeWebAuthResolver,
} from '@proma/shared/utils'
import { createClient } from 'redis'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { AgentRuntimeObjectStore } from '@proma/shared/utils'
import { materializeAgentRuntimeWorkspace, syncAgentRuntimeWorkspaceToObjectStore } from '@proma/shared/utils/node'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { runAISDKWebAgentTurn } from './runtime.ts'
import { PostgresUsageLedger, usageFromMessages } from './billing.ts'
import { PostgresAuditLog } from './audit.ts'
import { PostgresRuntimeMetrics } from './metrics.ts'
import { PostgresTaskRecoveryInspector } from './recovery.ts'
import { PostgresAgentRuntimeInteractionStore } from './interactions.ts'
import { WEB_DASHBOARD_HTML } from './dashboard.ts'
import type { UsagePriceEntry } from './billing.ts'
import type { TenantBudgetPolicy } from './billing.ts'

export interface PromaWebServerConfig {
  databaseUrl: string
  redisUrl: string
  s3: PromaWebS3Config
  envelopeKey: string
  envelopeKeyId: string
  trustedHeaderAuth: boolean
  workspaceRoot: string
  workerId: string
  taskLeaseMs: number
  recoveryStaleAfterMs?: number
  priceCatalog?: UsagePriceEntry[]
  tenantBudget?: TenantBudgetPolicy
  rateLimit?: { maxTasks: number; windowMs: number }
}

export interface PromaWebServerDependencies {
  postgres?: AgentRuntimePostgresClient
  redis?: AgentRuntimeRedisClient
  objectStore?: AgentRuntimeObjectStore
  auth?: AgentRuntimeWebAuthResolver
  logger?: PromaWebLogger
  agentTurnRunner?: AgentRuntimeWebAgentTurnRunner
}

export interface PromaWebLogger {
  info(event: PromaWebLogEvent): void
  error(event: PromaWebLogEvent): void
}

export interface PromaWebLogEvent {
  event: string
  requestId?: string
  tenantId?: string
  userId?: string
  sessionId?: string
  taskId?: string
  status?: number
  durationMs?: number
  error?: string
}

export interface PromaWebS3Config {
  bucket: string
  region: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  maxUploadBytes: number
}

export interface PromaWebServerApplication {
  fetch(request: Request): Promise<Response>
  initialize(): Promise<void>
  shutdown(): Promise<void>
}

/** 创建 P0 Web 服务应用；运行时实例由 Bun.serve 在 index.ts 中托管。 */
export function createPromaWebServerApplication(
  config: PromaWebServerConfig,
  dependencies: PromaWebServerDependencies = {},
): PromaWebServerApplication {
  const postgres = dependencies.postgres ?? new BunPostgresClient(config.databaseUrl)
  const redis = dependencies.redis ?? new NodeRedisClient(config.redisUrl)
  const objectStore = dependencies.objectStore ?? new S3AgentRuntimeObjectStore(config.s3)
  const logger = dependencies.logger ?? consolePromaWebLogger
  const agentTurnRunner = dependencies.agentTurnRunner ?? runAISDKWebAgentTurn
  const store = new PostgresTenantRuntimeStore(postgres)
  const taskLease = new PostgresTaskLease(postgres, config.workerId, config.taskLeaseMs)
  const usageLedger = new PostgresUsageLedger(postgres, config.priceCatalog ?? [])
  const auditLog = new PostgresAuditLog(postgres)
  const metrics = new PostgresRuntimeMetrics(postgres)
  const recovery = new PostgresTaskRecoveryInspector(postgres, config.recoveryStaleAfterMs ?? config.taskLeaseMs * 2)
  const interactionStore = new PostgresAgentRuntimeInteractionStore(postgres)
  const rateLimiter = redis instanceof NodeRedisClient ? new RedisTaskRateLimiter(redis) : undefined
  const auth = dependencies.auth ?? createTrustedHeaderAuth(config.trustedHeaderAuth)
  const app = createAgentRuntimeWebServer({
    store,
    eventHub: new AgentRuntimeEventReplayHub({
      durableStore: new RedisAgentRuntimeEventStore({ client: redis }),
    }),
    auth,
    interactionStore,
    secretCodec: createWebCryptoEnvelopeSecretCodec({
      keyId: config.envelopeKeyId,
      keyBytes: parseWebCryptoEnvelopeKey(config.envelopeKey),
    }),
    runAgentTurn: async (input) => {
      const acquired = await taskLease.acquire(input.scope, input.session.sessionId, input.taskId)
      if (!acquired) throw new Error('会话已由其他 worker 执行')
      const localDir = createWorkspaceRunDirectory(config.workspaceRoot, input.scope, input.session.sessionId)
      const startedAt = Date.now()
      const heartbeat = setInterval(() => {
        void taskLease.renew(input.scope, input.session.sessionId, input.taskId)
      }, Math.max(1_000, Math.floor(config.taskLeaseMs / 3)))
      try {
        await materializeAgentRuntimeWorkspace({
          ...input.scope,
          workspaceSlug: input.workspace.workspaceSlug,
          objectStore,
          localDir,
        })
        const output = await agentTurnRunner({
          ...input,
          workspace: { ...input.workspace, cwd: localDir },
        })
        const usage = usageFromMessages(output)
        if (usage) {
          await usageLedger.record({
            ...input.scope,
            taskId: input.taskId,
            sessionId: input.session.sessionId,
            provider: input.provider,
            modelId: input.modelId,
            ...usage,
          })
        }
        await syncAgentRuntimeWorkspaceToObjectStore({
          ...input.scope,
          workspaceSlug: input.workspace.workspaceSlug,
          objectStore,
          localDir,
        })
        logger.info({ event: 'agent_task_completed', ...input.scope, sessionId: input.session.sessionId, durationMs: Date.now() - startedAt })
        return output
      } catch (error) {
        logger.error({ event: 'agent_task_failed', ...input.scope, sessionId: input.session.sessionId, durationMs: Date.now() - startedAt, error: getErrorMessage(error) })
        throw error
      } finally {
        clearInterval(heartbeat)
        await taskLease.release(input.scope, input.session.sessionId, input.taskId)
      }
    },
    beforeStartTask: async (input) => {
      await usageLedger.assertTaskWithinBudget(input.scope, input.modelId, config.tenantBudget)
      if (config.rateLimit && rateLimiter) {
        await rateLimiter.assertAllowed(input.scope, input.modelId, config.rateLimit)
      }
    },
    defaultRuntime: 'ai-sdk',
  })

  return {
    async fetch(request) {
      const url = new URL(request.url)
      const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()
      const startedAt = Date.now()
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return Response.json({ status: 'ok' })
      }
      if (request.method === 'GET' && url.pathname === '/agent/ui') {
        return new Response(WEB_DASHBOARD_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      const scope = await auth({ request, url })
      const fileRoute = matchWorkspaceFileRoute(request.method, url.pathname)
      let response: Response
      if (request.method === 'GET' && url.pathname === '/agent/metrics') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : Response.json({ metrics: await metrics.get(scope) })
      } else if (request.method === 'GET' && url.pathname === '/agent/recovery/stale-tasks') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : Response.json({ tasks: await recovery.listStale(scope) })
      } else if (request.method === 'GET' && url.pathname === '/agent/audit') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : Response.json({ records: await auditLog.list({
            ...scope,
            action: url.searchParams.get('action') ?? undefined,
            result: parseAuditResult(url.searchParams.get('result')),
            taskId: url.searchParams.get('taskId') ?? undefined,
            from: parseAuditTimestamp(url.searchParams.get('from')),
            to: parseAuditTimestamp(url.searchParams.get('to')),
          }) })
      } else if (request.method === 'GET' && url.pathname === '/agent/audit/export') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : createAuditExportResponse(await auditLog.list({
            ...scope,
            action: url.searchParams.get('action') ?? undefined,
            result: parseAuditResult(url.searchParams.get('result')),
            taskId: url.searchParams.get('taskId') ?? undefined,
            from: parseAuditTimestamp(url.searchParams.get('from')),
            to: parseAuditTimestamp(url.searchParams.get('to')),
            limit: 500,
          }), url.searchParams.get('format'))
      } else if (request.method === 'GET' && url.pathname === '/agent/sessions') {
        response = !scope ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 }) : Response.json({ sessions: (await postgres.query<Record<string, unknown>>('SELECT session_id AS "sessionId", workspace_slug AS "workspaceSlug", channel_id AS "channelId", model_id AS "modelId", COALESCE(title, session_id) AS title, updated_at AS "updatedAt" FROM proma_runtime_sessions WHERE tenant_id = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 100', [scope.tenantId, scope.userId])).rows })
      } else if (request.method === 'GET' && url.pathname === '/agent/tasks') {
        response = !scope ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 }) : Response.json({ tasks: (await postgres.query<Record<string, unknown>>('SELECT task_id, session_id, status, started_at, completed_at, error FROM proma_runtime_tasks WHERE tenant_id = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT 100', [scope.tenantId, scope.userId])).rows })
      } else if (fileRoute) {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : await handleWorkspaceFile(request, scope, fileRoute, store, objectStore, config.s3.maxUploadBytes)
      } else {
        response = await app.handleRequest(request)
      }
      logger.info({ event: 'http_request_completed', requestId, tenantId: scope?.tenantId, userId: scope?.userId, status: response.status, durationMs: Date.now() - startedAt })
      if (scope) {
        await auditLog.append({
          ...scope,
          action: `${request.method} ${url.pathname}`,
          resource: url.pathname,
          result: response.ok ? 'success' : 'failure',
          requestId,
        })
      }
      return response
    },
    async initialize() {
      if (redis instanceof NodeRedisClient) await redis.connect()
      await store.initializeSchema()
      await taskLease.initializeSchema()
      await usageLedger.initializeSchema()
      await auditLog.initializeSchema()
      await interactionStore.initializeSchema()
    },
    async shutdown() {
      const taskIds = app.taskRunner.cancelAllTasks()
      await Promise.all(taskIds.map((taskId) => app.taskRunner.waitForTask(taskId)))
      await app.taskRunner.flushDurableEventWrites()
      if (redis instanceof NodeRedisClient) await redis.close()
      logger.info({ event: 'server_shutdown_completed' })
    },
  }
}

function parseAuditResult(value: string | null): 'success' | 'failure' | undefined {
  return value === 'success' || value === 'failure' ? value : undefined
}

function parseAuditTimestamp(value: string | null): number | undefined {
  if (!value) return undefined
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined
}

function createAuditExportResponse(records: Awaited<ReturnType<PostgresAuditLog['list']>>, format: string | null): Response {
  if (format === 'json') {
    return new Response(JSON.stringify({ records }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="proma-audit.json"' },
    })
  }
  const header = ['createdAt', 'tenantId', 'userId', 'action', 'resource', 'result', 'requestId', 'taskId']
  const rows = records.map((record) => header.map((key) => csvValue(record[key as keyof typeof record])).join(','))
  return new Response([header.join(','), ...rows].join('\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="proma-audit.csv"' },
  })
}

function csvValue(value: unknown): string {
  const raw = value == null ? '' : String(value)
  return `"${raw.replaceAll('"', '""')}"`
}

export class PostgresTaskLease {
  constructor(
    private readonly client: AgentRuntimePostgresClient,
    private readonly workerId: string,
    private readonly leaseMs: number,
  ) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_task_leases (
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      lease_expires_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, user_id, session_id)
    )`)
  }

  async acquire(scope: AgentRuntimeScope, sessionId: string, taskId: string): Promise<boolean> {
    const now = Date.now()
    const result = await this.client.query<{ task_id: string }>(
      `INSERT INTO proma_runtime_task_leases (
        tenant_id, user_id, session_id, task_id, worker_id, lease_expires_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, user_id, session_id) DO UPDATE SET
        task_id = EXCLUDED.task_id,
        worker_id = EXCLUDED.worker_id,
        lease_expires_at = EXCLUDED.lease_expires_at,
        updated_at = EXCLUDED.updated_at
      WHERE proma_runtime_task_leases.lease_expires_at < $7
      RETURNING task_id`,
      [scope.tenantId, scope.userId, sessionId, taskId, this.workerId, now + this.leaseMs, now],
    )
    return result.rows[0]?.task_id === taskId
  }

  async renew(scope: AgentRuntimeScope, sessionId: string, taskId: string): Promise<boolean> {
    const now = Date.now()
    const result = await this.client.query<{ task_id: string }>(
      `UPDATE proma_runtime_task_leases SET lease_expires_at = $6, updated_at = $7
      WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3 AND task_id = $4 AND worker_id = $5
      RETURNING task_id`,
      [scope.tenantId, scope.userId, sessionId, taskId, this.workerId, now + this.leaseMs, now],
    )
    return result.rows.length > 0
  }

  async release(scope: AgentRuntimeScope, sessionId: string, taskId: string): Promise<void> {
    await this.client.query(
      `DELETE FROM proma_runtime_task_leases
      WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3 AND task_id = $4 AND worker_id = $5`,
      [scope.tenantId, scope.userId, sessionId, taskId, this.workerId],
    )
  }
}

export class RedisTaskRateLimiter {
  constructor(private readonly redis: RedisWindowCounter) {}

  async assertAllowed(scope: AgentRuntimeScope, modelId: string, policy: { maxTasks: number; windowMs: number }): Promise<void> {
    const count = await this.redis.incrementInWindow(
      `proma:runtime:rate:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.userId)}:${encodeURIComponent(modelId)}`,
      policy.windowMs,
    )
    if (count > policy.maxTasks) throw new Error('请求过于频繁，请稍后再试')
  }
}

export interface RedisWindowCounter {
  incrementInWindow(key: string, windowMs: number): Promise<number>
}

const consolePromaWebLogger: PromaWebLogger = {
  info(event) { console.info(JSON.stringify(event)) },
  error(event) { console.error(JSON.stringify(event)) },
}

function createWorkspaceRunDirectory(root: string, scope: AgentRuntimeScope, sessionId: string): string {
  const digest = createHash('sha256').update(`${scope.tenantId}\u0000${scope.userId}\u0000${sessionId}`).digest('hex')
  return join(root, digest)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function handleWorkspaceFile(
  request: Request,
  scope: AgentRuntimeScope,
  route: { workspaceSlug: string; relativePath: string },
  store: PostgresTenantRuntimeStore,
  objectStore: AgentRuntimeObjectStore,
  maxUploadBytes: number,
): Promise<Response> {
  if (!await store.getWorkspace(scope, route.workspaceSlug)) {
    return Response.json({ error: '工作区不存在或不可访问' }, { status: 404 })
  }
  const key = createAgentRuntimeWorkspaceObjectKey({ ...scope, ...route })
  if (request.method === 'PUT') {
    const contentLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
    if (contentLength > maxUploadBytes) return Response.json({ error: '文件超过上传大小限制' }, { status: 413 })
    const body = new Uint8Array(await request.arrayBuffer())
    if (body.byteLength > maxUploadBytes) return Response.json({ error: '文件超过上传大小限制' }, { status: 413 })
    const object = await objectStore.putObject({
      key,
      body,
      contentType: request.headers.get('content-type') ?? undefined,
    })
    return Response.json({ object }, { status: 201 })
  }
  const object = await objectStore.getObject(key)
  if (!object) return Response.json({ error: '文件不存在或不可访问' }, { status: 404 })
  return new Response(bytesToArrayBuffer(object.body), { headers: { 'content-type': object.contentType ?? 'application/octet-stream' } })
}

function matchWorkspaceFileRoute(method: string, pathname: string): { workspaceSlug: string; relativePath: string } | undefined {
  if (method !== 'GET' && method !== 'PUT') return undefined
  const prefix = '/agent/workspaces/'
  if (!pathname.startsWith(prefix)) return undefined
  const remainder = pathname.slice(prefix.length).split('/files/')
  const workspaceSlug = remainder[0]
  const rawPath = remainder[1]
  if (!workspaceSlug || !rawPath || remainder.length !== 2) return undefined
  try {
    return {
      workspaceSlug: decodeURIComponent(workspaceSlug),
      relativePath: normalizeRelativeObjectPath(decodeURIComponent(rawPath)),
    }
  } catch {
    return undefined
  }
}

class S3AgentRuntimeObjectStore implements AgentRuntimeObjectStore {
  private readonly client: S3Client

  constructor(private readonly config: PromaWebS3Config) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: Boolean(config.endpoint),
      credentials: config.accessKeyId && config.secretAccessKey
        ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
        : undefined,
    })
  }

  async putObject(input: { key: string; body: Uint8Array; contentType?: string }) {
    await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: input.key, Body: input.body, ContentType: input.contentType }))
    return { key: input.key, size: input.body.byteLength, contentType: input.contentType, updatedAt: Date.now() }
  }

  async getObject(key: string) {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }))
      if (!response.Body) return undefined
      return { key, size: Number(response.ContentLength ?? 0), contentType: response.ContentType, updatedAt: Date.now(), body: new Uint8Array(await response.Body.transformToByteArray()) }
    } catch (error) {
      if (isS3NotFound(error)) return undefined
      throw error
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }))
  }

  async listObjects(input: { prefix: string; limit?: number }) {
    const response = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: input.prefix, MaxKeys: input.limit }))
    return (response.Contents ?? []).flatMap((item) => item.Key ? [{ key: item.Key, size: Number(item.Size ?? 0), updatedAt: item.LastModified?.getTime() ?? 0 }] : [])
  }
}

function isS3NotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && '$metadata' in error
    && (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

interface RedisStreamEntry {
  id: string
  message: Record<string, string>
}

interface RedisNodeClient {
  connect(): Promise<unknown>
  close(): Promise<void>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
  xAdd(key: string, id: string, fields: Record<string, string>): Promise<string>
  xRange(key: string, start: string, end: string, options?: { COUNT?: number }): Promise<RedisStreamEntry[]>
  xTrim(key: string, strategy: 'MAXLEN' | 'MINID', threshold: number): Promise<number>
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>
  get(key: string): Promise<string | null>
  del(key: string): Promise<number>
}

class NodeRedisClient implements AgentRuntimeRedisClient {
  private readonly client: RedisNodeClient

  constructor(redisUrl: string) {
    this.client = createClient({ url: redisUrl })
  }

  async connect(): Promise<void> {
    await this.client.connect()
  }

  async close(): Promise<void> {
    await this.client.close()
  }

  async incrementInWindow(key: string, windowMs: number): Promise<number> {
    const count = await this.client.eval(
      "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return count",
      { keys: [key], arguments: [String(windowMs)] },
    )
    if (typeof count !== 'number') throw new Error('Redis 限速计数返回无效结果')
    return count
  }

  async xadd(key: string, id: string, fields: Record<string, string>): Promise<string> {
    return this.client.xAdd(key, id, fields)
  }

  async xrange(key: string, start: string, end: string, options?: { count?: number }) {
    const entries = await this.client.xRange(key, start, end, options?.count ? { COUNT: options.count } : undefined)
    return entries.map((entry) => ({ id: entry.id, fields: entry.message }))
  }

  async xtrim(key: string, maxLen: number): Promise<void> {
    await this.client.xTrim(key, 'MAXLEN', maxLen)
  }

  async set(key: string, value: string, options?: { ttlMs?: number }): Promise<void> {
    await this.client.set(key, value, options?.ttlMs ? { PX: options.ttlMs } : undefined)
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.client.get(key)) ?? undefined
  }

  async del(key: string): Promise<void> {
    await this.client.del(key)
  }
}

class BunPostgresClient implements AgentRuntimePostgresClient {
  private readonly sql: Bun.SQL

  constructor(databaseUrl: string) {
    this.sql = new Bun.SQL(databaseUrl)
  }

  async query<Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<{ rows: Row[] }> {
    const rows = await this.sql.unsafe<Row[]>(sql, [...params])
    return { rows }
  }
}

function createTrustedHeaderAuth(enabled: boolean): AgentRuntimeWebAuthResolver {
  return (input): AgentRuntimeScope | undefined => {
    if (!enabled) return undefined
    const tenantId = input.request.headers.get('x-proma-tenant-id') ?? ''
    const userId = input.request.headers.get('x-proma-user-id') ?? ''
    return tenantId && userId ? { tenantId, userId } : undefined
  }
}
