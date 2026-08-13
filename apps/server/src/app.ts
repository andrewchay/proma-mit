import {
  AgentRuntimeEventReplayHub,
  createAgentRuntimeWebServer,
  createWebCryptoEnvelopeSecretCodec,
  createCloudKmsEnvelopeSecretCodec,
  createAgentRuntimeWorkspaceObjectKey,
  normalizeRelativeObjectPath,
  validateServerMcpConfig,
  validateServerMcpOAuthEndpoint,
  parseWebCryptoEnvelopeKey,
  PostgresTenantRuntimeStore,
  RedisAgentRuntimeEventStore,
} from '@gravitas/shared/utils'
import { ServerMcpConnectionManager } from '@gravitas/shared/utils/node'
import type {
  AgentRuntimePostgresClient,
  AgentRuntimeRole,
  AgentRuntimeRedisClient,
  AgentRuntimeScope,
  AgentRuntimeWebAgentTurnRunner,
  AgentRuntimeWebAuthResolver,
} from '@gravitas/shared/utils'
import { createClient } from 'redis'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { AgentRuntimeObjectStore } from '@gravitas/shared/utils'
import { materializeAgentRuntimeWorkspace, syncAgentRuntimeWorkspaceToObjectStore } from '@gravitas/shared/utils/node'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { runAISDKWebAgentTurn } from './runtime.ts'
import { HttpServerMcpConnectionFactory } from './server-mcp-client.ts'
import { acquireServerMcpTools } from './server-mcp-tools.ts'
import { HttpIsolatedExecutor } from './isolated-executor.ts'
import { AwsKmsDataKeyProvider } from './aws-kms.ts'
import { createMcpOAuthAuthorizationUrl, exchangeMcpAuthorizationCode } from './server-mcp-oauth.ts'
import { PostgresUsageLedger, usageFromMessages } from './billing.ts'
import { PostgresAuditLog } from './audit.ts'
import type { AuditRecord } from './audit.ts'
import { PostgresRuntimeSpanStore } from './spans.ts'
import { createSpanQueryToolAdapter } from './span-query-tools.ts'
import { PostgresRunProfileAggregator } from './run-profile.ts'
import { PostgresRuntimeMetrics } from './metrics.ts'
import { computeHealthDashboard } from './health-dashboard.ts'
import { PostgresSignalStore } from './signals.ts'
import { PostgresSignalDataSource, SignalScanner } from './signal-scan.ts'
import type { SignalMatcher } from './signals.ts'
import { PostgresEvalDatasetStore } from './eval-dataset.ts'
import { PostgresTaskRecoveryInspector } from './recovery.ts'
import { PostgresAgentRuntimeInteractionStore } from './interactions.ts'
import { AgentRegistryStore } from './agent-registry.ts'
import { parseAgentCardFromBody, parseRegistryListQuery } from './agent-registry-api.ts'
import { HttpOperationsReporter, NoopOperationsReporter, redactOperationalError } from './operations.ts'
import type { OperationsReporter } from './operations.ts'
import { WEB_DASHBOARD_HTML } from './dashboard.ts'
import { createWorkspaceFileDownloadResponse } from './workspace-file-response.ts'
import { nextRunForSchedule, PostgresServerSchedulerStore } from './scheduler-store.ts'
import { ServerScheduler } from './server-scheduler.ts'
import type { UsagePriceEntry } from './billing.ts'
import type { TenantBudgetPolicy } from './billing.ts'
import type { UsageLedgerRecord } from './billing.ts'
import { PostgresAuthSessionStore } from './auth-session-store.ts'
import { createAuthHandler, readLoginCredentials, type AuthRoutesDeps } from './auth-routes.ts'
import { createCookieSessionAuthResolver, createCompositeAuthResolver } from './auth-resolvers.ts'
import { hashPassword, verifyPassword } from './local-admin-auth.ts'

export interface PromaWebServerConfig {
  databaseUrl: string
  redisUrl: string
  s3: PromaWebS3Config
  envelopeKey: string
  envelopeKeyId: string
  kms?: { keyId: string; region: string; endpoint?: string }
  trustedHeaderAuth: boolean
  /** 浏览器登录：local（本地用户名/密码）/ oidc / both / none（仅 Bearer/trusted-header） */
  authMode?: 'local' | 'oidc' | 'both' | 'none'
  /** OIDC Authorization Code 客户端配置（authMode=oidc|both 时需要） */
  oidc?: { authorizationEndpoint: string; tokenEndpoint: string; clientId: string; clientSecret?: string; redirectUri: string; scope?: string }
  /** 本地 bootstrap 管理员（authMode=local|both 时需要） */
  localAdmin?: { username: string; tenantId: string; password: string }
  workspaceRoot: string
  workerId: string
  taskLeaseMs: number
  recoveryStaleAfterMs?: number
  priceCatalog?: UsagePriceEntry[]
  tenantBudget?: TenantBudgetPolicy
  rateLimit?: { maxTasks: number; windowMs: number }
  /** 未配置时禁用服务端 MCP，防止工作区配置成为 SSRF 入口。 */
  mcpEgress?: { allowedOrigins: string[]; maxTimeoutMs: number; catalogCacheTtlMs?: number }
  executor?: { endpoint: string; token: string }
  mcpOAuthCallbackBaseUrl?: string
  subtaskLimits?: { maxDepth: number; maxChildrenPerTask: number; maxOutputTokensPerTask: number }
  operations?: { siemWebhookUrl?: string; alertWebhookUrl?: string }
  /** P-IV：运行时输入/输出采样；不配置则不采集内容快照（local-first）。 */
  spanSampling?: { enabled: boolean; rate?: number; maxBytes?: number }
}

export interface PromaWebServerDependencies {
  postgres?: AgentRuntimePostgresClient
  redis?: AgentRuntimeRedisClient
  objectStore?: AgentRuntimeObjectStore
  auth?: AgentRuntimeWebAuthResolver
  logger?: PromaWebLogger
  agentTurnRunner?: AgentRuntimeWebAgentTurnRunner
  operationsReporter?: OperationsReporter
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
  traceId?: string
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
  const spanStore = new PostgresRuntimeSpanStore(postgres)
  const runProfileAggregator = new PostgresRunProfileAggregator(postgres, spanStore)
  const evalDatasetStore = new PostgresEvalDatasetStore(postgres, {
    querySpansInWindow: (scope, input) => spanStore.querySpansInWindow(scope, input),
    listTaskTree: (scope, taskId) => spanStore.listTask({ ...scope, taskId }),
  })
  const signalStore = new PostgresSignalStore(postgres)
  const signalScanner = new SignalScanner({
    store: signalStore,
    data: new PostgresSignalDataSource(postgres, spanStore),
  })
  const metrics = new PostgresRuntimeMetrics(postgres)
  const recovery = new PostgresTaskRecoveryInspector(postgres, config.recoveryStaleAfterMs ?? config.taskLeaseMs * 2)
  const interactionStore = new PostgresAgentRuntimeInteractionStore(postgres)
  const agentRegistry = new AgentRegistryStore(postgres)
  const rateLimiter = redis instanceof NodeRedisClient ? new RedisTaskRateLimiter(redis) : undefined
  const authSessionStore = new PostgresAuthSessionStore(postgres)
  // cookie 会话 resolver：authMode=local/oidc/both 时启用
  const cookieAuthCookieName = 'proma_session'
  const cookieAuthResolver = config.authMode && config.authMode !== 'none'
    ? createCookieSessionAuthResolver({ store: authSessionStore, cookieName: cookieAuthCookieName })
    : undefined
  // 现有 Bearer/trusted-header 链路（dependencies.auth 来自 index.ts 的 OIDC JWT，或 trustedHeaderAuth）
  const baseAuth = dependencies.auth ?? createTrustedHeaderAuth(config.trustedHeaderAuth)
  // 复合：cookie 会话优先，回退 Bearer/trusted-header
  const auth: AgentRuntimeWebAuthResolver = createCompositeAuthResolver(cookieAuthResolver, baseAuth)
  // 浏览器登录 handler（/auth/*）
  // localAdminResolver：启动时把明文口令 scrypt 哈希一次，之后每次登录用 timing-safe 校验
  const localAdmin = config.localAdmin
  const localAdminHashPromise = localAdmin ? hashPassword(localAdmin.password) : Promise.resolve(null)
  const authRoutesDeps: AuthRoutesDeps = {
    // 适配：AuthRoutesDeps 用对象形会话，store 用 4 参数形
    sessionStore: {
      create: async (session) => {
        await authSessionStore.create({ tenantId: session.tenantId, userId: session.userId }, session.sessionId, session.roles, session.expiresAt)
      },
      destroy: (sessionId) => authSessionStore.destroy(sessionId),
    },
    sessionCookieName: cookieAuthCookieName,
    verifyAdmin: localAdmin
      ? async (username, password) => {
          if (username !== localAdmin.username) return null
          const hash = await localAdminHashPromise
          if (!hash) return null
          const ok = await verifyPassword(password, hash)
          return ok ? { tenantId: localAdmin.tenantId, roles: ['admin'] as const } : null
        }
      : async () => null,
    oidc: config.oidc,
  }
  const authHandler = createAuthHandler(authRoutesDeps)
  const operationsReporter = dependencies.operationsReporter ?? (config.operations
    ? new HttpOperationsReporter(config.operations)
    : new NoopOperationsReporter())
  const mcpConnections = config.mcpEgress
    ? new ServerMcpConnectionManager(config.mcpEgress, new HttpServerMcpConnectionFactory(store), config.mcpEgress.catalogCacheTtlMs)
    : undefined
  const isolatedExecutor = config.executor ? new HttpIsolatedExecutor(config.executor.endpoint, config.executor.token) : undefined
  const app = createAgentRuntimeWebServer({
    store,
    eventHub: new AgentRuntimeEventReplayHub({
      durableStore: new RedisAgentRuntimeEventStore({ client: redis }),
    }),
    auth,
    interactionStore,
    secretCodec: config.kms
      ? createCloudKmsEnvelopeSecretCodec({ activeKeyId: config.kms.keyId, providers: { [config.kms.keyId]: new AwsKmsDataKeyProvider(config.kms.keyId, config.kms) } })
      : createWebCryptoEnvelopeSecretCodec({ keyId: config.envelopeKeyId, keyBytes: parseWebCryptoEnvelopeKey(config.envelopeKey) }),
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
        const runtimeInput = { ...input, workspace: { ...input.workspace, cwd: localDir } }
        const mcp = mcpConnections ? await acquireServerMcpTools(runtimeInput, mcpConnections) : undefined
        let output
        try {
          output = await agentTurnRunner({
            ...runtimeInput,
            mcpTools: mcp?.tools,
            spanSink: spanStore,
            spanQuery: createSpanQueryToolAdapter(spanStore),
            spanSampling: config.spanSampling ? { enabled: config.spanSampling.enabled, rate: config.spanSampling.rate ?? 0.1, maxBytes: config.spanSampling.maxBytes ?? 512 } : undefined,
            executeIsolatedCommand: isolatedExecutor ? (request, signal) => isolatedExecutor.execute(request, signal) : undefined,
          })
        } finally {
          await mcp?.release()
        }
        const usage = usageFromMessages(output)
        if (usage) {
          const usageRecord = await usageLedger.record({
            ...input.scope,
            taskId: input.taskId,
            sessionId: input.session.sessionId,
            provider: input.provider,
            modelId: input.modelId,
            ...usage,
          })
          if (usageRecord.costMicroUsd != null) {
            await spanStore.attachCost(input.scope, input.taskId, usageRecord.costMicroUsd)
          }
          const budgetAlert = await usageLedger.claimMonthlyBudgetThresholdAlert(input.scope, config.tenantBudget)
          if (budgetAlert) {
            const severity = budgetAlert.thresholdPercent === 100 ? 'critical' : 'warning'
            const message = `本月预算已使用 ${budgetAlert.thresholdPercent}%：${budgetAlert.costMicroUsd}/${budgetAlert.budgetMicroUsd} microUSD`
            void operationsReporter.reportAlert({
              severity,
              kind: 'monthly_budget_threshold',
              tenantId: input.scope.tenantId,
              userId: input.scope.userId,
              taskId: input.taskId,
              message,
              createdAt: Date.now(),
            }).catch((reportError) => logger.error({ event: 'operations_alert_delivery_failed', error: getErrorMessage(reportError) }))
          }
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
        const errorMessage = redactOperationalError(getErrorMessage(error))
        logger.error({ event: 'agent_task_failed', ...input.scope, sessionId: input.session.sessionId, durationMs: Date.now() - startedAt, error: errorMessage })
        void operationsReporter.reportAlert({ severity: 'critical', kind: 'agent_task_failed', tenantId: input.scope.tenantId, userId: input.scope.userId, taskId: input.taskId, message: errorMessage, createdAt: Date.now() }).catch((reportError) => logger.error({ event: 'operations_alert_delivery_failed', error: getErrorMessage(reportError) }))
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
    subtaskLimits: config.subtaskLimits,
  })
  const schedulerStore = new PostgresServerSchedulerStore(postgres)
  const scheduler = new ServerScheduler(schedulerStore, app, config.workerId)
  let signalTimer: ReturnType<typeof setInterval> | undefined
  const startSignalScanner = (intervalMs = 30_000) => {
    if (signalTimer) return
    signalTimer = setInterval(() => { void signalTick() }, intervalMs)
    void signalTick()
  }
  const signalTick = async () => {
    try {
      const scopes = await signalStore.listScopes()
      for (const scope of scopes) {
        const hits = await signalScanner.scan(scope)
        for (const hit of hits) {
          void operationsReporter.reportAlert({ severity: 'warning', kind: 'signal_hit', tenantId: hit.tenantId, userId: hit.userId, taskId: typeof hit.evidence.taskId === 'string' ? hit.evidence.taskId : undefined, message: hit.message, createdAt: Date.now() }).catch((error) => logger.error({ event: 'operations_alert_delivery_failed', error: getErrorMessage(error) }))
        }
      }
    } catch (error) {
      logger.error({ event: 'signal_scan_failed', error: getErrorMessage(error) })
    }
  }

  return {
    async fetch(request) {
      const url = new URL(request.url)
      const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()
      const traceId = request.headers.get('traceparent')?.split('-')[1] ?? request.headers.get('x-trace-id') ?? requestId
      const startedAt = Date.now()
      if (request.method === 'GET' && url.pathname === '/healthz') {
        const response = Response.json({ status: 'ok' })
        response.headers.set('x-trace-id', traceId)
        return response
      }
      if (request.method === 'GET' && url.pathname === '/agent/ui') {
        return new Response(WEB_DASHBOARD_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      // /auth/* 浏览器登录闭环（本地表单 + OIDC）
      if (url.pathname === '/auth/login') {
        if (request.method === 'GET') return authHandler.loginPage()
        if (request.method === 'POST') {
          const parsed = await readLoginCredentials(request)
          if (parsed.error || !parsed.credentials) return Response.json({ error: parsed.error ?? '请求体无效' }, { status: 400 })
          return authHandler.loginForm(parsed.credentials)
        }
      }
      if (url.pathname === '/auth/logout') return authHandler.logout()
      if (url.pathname === '/auth/oidc/start') return authHandler.oidcStart()
      if (url.pathname === '/auth/oidc/callback') {
        const code = url.searchParams.get('code') ?? ''
        const state = url.searchParams.get('state') ?? ''
        return authHandler.oidcCallback({ code, state })
      }
      const scope = await auth({ request, url })
      const actionAuthorizationError = scope ? requireAgentActionRole(scope, request) : undefined
      const fileRoute = matchWorkspaceFileRoute(request.method, url.pathname)
      const oauthStartRoute = matchMcpOAuthStartRoute(request.method, url.pathname)
      const mcpStatusRoute = matchMcpStatusRoute(request.method, url.pathname)
      let response: Response
      if (actionAuthorizationError) {
        response = actionAuthorizationError
      } else if (request.method === 'GET' && url.pathname === '/agent/billing') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['admin'])
            ? Response.json({ error: '需要 admin 角色' }, { status: 403 })
            : Response.json({
              summary: await usageLedger.summarize({ ...scope, from: parseAuditTimestamp(url.searchParams.get('from')), to: parseAuditTimestamp(url.searchParams.get('to')) }),
              records: await usageLedger.list({ ...scope, from: parseAuditTimestamp(url.searchParams.get('from')), to: parseAuditTimestamp(url.searchParams.get('to')), limit: parsePageLimit(url.searchParams.get('limit')) }),
            })
      } else if (request.method === 'GET' && url.pathname === '/agent/billing/export') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['admin'])
            ? Response.json({ error: '需要 admin 角色' }, { status: 403 })
            : createBillingExportResponse(
              await usageLedger.list({ ...scope, from: parseAuditTimestamp(url.searchParams.get('from')), to: parseAuditTimestamp(url.searchParams.get('to')), limit: 1_000 }),
              url.searchParams.get('format'),
            )
      } else if (request.method === 'GET' && url.pathname === '/agent/metrics') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin', 'security-auditor'])
            ? Response.json({ error: '需要 operator、admin 或 security-auditor 角色' }, { status: 403 })
            : Response.json({ metrics: await metrics.get(scope) })
      } else if (request.method === 'GET' && url.pathname === '/agent/health') {
        response = await getHealthDashboard(scope, metrics, usageLedger, config.tenantBudget)
      } else if (request.method === 'GET' && url.pathname === '/agent/registry') {
        const list = parseRegistryListQuery(scope ?? { tenantId: '', userId: '' }, url.searchParams)
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin'])
            ? Response.json({ error: '需要 operator 或 admin 角色' }, { status: 403 })
            : list.error
              ? Response.json({ error: list.error }, { status: 400 })
              : Response.json({ cards: await agentRegistry.list(scope, list.query) })
      } else if (request.method === 'PUT' && url.pathname === '/agent/registry') {
        response = await putAgentRegistry(request, scope, agentRegistry)
      } else if (request.method === 'GET' && url.pathname === '/agent/recovery/stale-tasks') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin'])
            ? Response.json({ error: '需要 operator 或 admin 角色' }, { status: 403 })
            : Response.json({ tasks: await recovery.listStale(scope) })
      } else if (request.method === 'GET' && url.pathname === '/agent/traces') {
        const taskId = url.searchParams.get('taskId')
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin', 'security-auditor'])
            ? Response.json({ error: '需要 operator、admin 或 security-auditor 角色' }, { status: 403 })
            : !taskId
              ? Response.json({ error: '缺少 taskId 参数' }, { status: 400 })
              : Response.json({ trace: await spanStore.listTask({ ...scope, taskId }) })
      } else if (request.method === 'GET' && url.pathname.startsWith('/agent/runs/')) {
        const runTaskId = decodeURIComponent(url.pathname.slice('/agent/runs/'.length))
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin', 'security-auditor'])
            ? Response.json({ error: '需要 operator、admin 或 security-auditor 角色' }, { status: 403 })
            : !runTaskId
              ? Response.json({ error: '缺少任务 ID' }, { status: 400 })
              : Response.json(await runProfileAggregator.profile(scope, runTaskId))
      } else if (request.method === 'GET' && url.pathname === '/agent/signals') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin', 'security-auditor'])
            ? Response.json({ error: '需要 operator、admin 或 security-auditor 角色' }, { status: 403 })
            : Response.json({ signals: await signalStore.list(scope) })
      } else if (request.method === 'POST' && url.pathname === '/agent/signals') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin'])
            ? Response.json({ error: '需要 operator 或 admin 角色' }, { status: 403 })
            : await createSignal(request, scope, signalStore)
      } else if (request.method === 'DELETE' && url.pathname.startsWith('/agent/signals/')) {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin'])
            ? Response.json({ error: '需要 operator 或 admin 角色' }, { status: 403 })
            : (await signalStore.delete(scope, decodeURIComponent(url.pathname.slice('/agent/signals/'.length)))
              ? new Response(null, { status: 204 })
              : Response.json({ error: 'Signal 不存在或不可访问' }, { status: 404 }))
      } else if (request.method === 'GET' && url.pathname === '/agent/signals/hits') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin', 'security-auditor'])
            ? Response.json({ error: '需要 operator、admin 或 security-auditor 角色' }, { status: 403 })
            : Response.json({ hits: await signalStore.listHits({
              ...scope,
              signalId: url.searchParams.get('signalId') ?? undefined,
              from: parseAuditTimestamp(url.searchParams.get('from')),
              to: parseAuditTimestamp(url.searchParams.get('to')),
              limit: parsePageLimit(url.searchParams.get('limit')),
            }) })
      } else if (request.method === 'GET' && url.pathname === '/agent/datasets') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin', 'security-auditor'])
            ? Response.json({ error: '需要 operator、admin 或 security-auditor 角色' }, { status: 403 })
            : Response.json({ datasets: await evalDatasetStore.listDatasets(scope) })
      } else if (request.method === 'POST' && url.pathname === '/agent/datasets') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin'])
            ? Response.json({ error: '需要 operator 或 admin 角色' }, { status: 403 })
            : await createEvalDataset(request, scope, evalDatasetStore)
      } else if (request.method === 'POST' && url.pathname === '/agent/datasets/from-run') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin'])
            ? Response.json({ error: '需要 operator 或 admin 角色' }, { status: 403 })
            : await archiveRunToDataset(request, scope, evalDatasetStore)
      } else if (request.method === 'DELETE' && url.pathname.startsWith('/agent/datasets/')) {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin'])
            ? Response.json({ error: '需要 operator 或 admin 角色' }, { status: 403 })
            : (await evalDatasetStore.deleteDataset(scope, decodeURIComponent(url.pathname.slice('/agent/datasets/'.length)))
              ? new Response(null, { status: 204 })
              : Response.json({ error: '数据集不存在' }, { status: 404 }))
      } else if (request.method === 'GET' && url.pathname.startsWith('/agent/datasets/') && url.pathname.endsWith('/samples')) {
        const datasetId = decodeURIComponent(url.pathname.slice('/agent/datasets/'.length, -'/samples'.length))
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['operator', 'admin', 'security-auditor'])
            ? Response.json({ error: '需要 operator、admin 或 security-auditor 角色' }, { status: 403 })
            : Response.json({ samples: await evalDatasetStore.listSamples({ ...scope, datasetId, limit: parsePageLimit(url.searchParams.get('limit')) }) })
      } else if (request.method === 'GET' && url.pathname === '/agent/audit') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['admin', 'security-auditor'])
            ? Response.json({ error: '需要 security-auditor 或 admin 角色' }, { status: 403 })
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
          : !hasAnyRole(scope, ['admin', 'security-auditor'])
            ? Response.json({ error: '需要 security-auditor 或 admin 角色' }, { status: 403 })
          : createAuditExportResponse(await auditLog.list({
            ...scope,
            action: url.searchParams.get('action') ?? undefined,
            result: parseAuditResult(url.searchParams.get('result')),
            taskId: url.searchParams.get('taskId') ?? undefined,
            from: parseAuditTimestamp(url.searchParams.get('from')),
            to: parseAuditTimestamp(url.searchParams.get('to')),
            limit: 500,
          }), url.searchParams.get('format'))
      } else if (request.method === 'POST' && url.pathname === '/agent/audit/purge') {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['admin'])
            ? Response.json({ error: '需要 admin 角色' }, { status: 403 })
            : await purgeAuditRecords(request, scope, auditLog)
      } else if (request.method === 'POST' && url.pathname === '/agent/audit/holds') {
        response = !scope ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['admin']) ? Response.json({ error: '需要 admin 角色' }, { status: 403 })
            : await createAuditLegalHold(request, scope, auditLog)
      } else if (request.method === 'DELETE' && url.pathname.startsWith('/agent/audit/holds/')) {
        response = !scope ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : !hasAnyRole(scope, ['admin']) ? Response.json({ error: '需要 admin 角色' }, { status: 403 })
            : await releaseAuditLegalHold(scope, decodeURIComponent(url.pathname.slice('/agent/audit/holds/'.length)), auditLog)
      } else if (request.method === 'GET' && url.pathname === '/agent/sessions') {
        const sessionsPage = parsePage(url.searchParams.get('page'))
        const sessionsLimit = parsePageLimit(url.searchParams.get('limit'))
        const archived = parseArchivedFilter(url.searchParams.get('archived'))
        const query = url.searchParams.get('q')?.trim() || null
        response = !scope ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 }) : Response.json({
          sessions: (await postgres.query<Record<string, unknown>>(
            `SELECT session_id AS "sessionId", workspace_slug AS "workspaceSlug", channel_id AS "channelId", model_id AS "modelId", runtime,
                    permission_mode AS "defaultPermissionMode", archived_at AS "archivedAt", COALESCE(title, session_id) AS title, updated_at AS "updatedAt"
             FROM proma_runtime_sessions
             WHERE tenant_id = $1 AND user_id = $2
               AND ($3::boolean IS NULL OR (archived_at IS NOT NULL) = $3)
               AND ($4::text IS NULL OR session_id ILIKE '%' || $4 || '%' OR title ILIKE '%' || $4 || '%')
             ORDER BY updated_at DESC LIMIT $5 OFFSET $6`,
            [scope.tenantId, scope.userId, archived, query, sessionsLimit, (sessionsPage - 1) * sessionsLimit],
          )).rows,
          page: sessionsPage,
          limit: sessionsLimit,
        })
      } else if (request.method === 'GET' && url.pathname === '/agent/tasks') {
        response = !scope ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 }) : Response.json({ tasks: (await postgres.query<Record<string, unknown>>('SELECT task_id, parent_task_id, session_id, status, started_at, completed_at, error FROM proma_runtime_tasks WHERE tenant_id = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT 100', [scope.tenantId, scope.userId])).rows })
      } else if (request.method === 'GET' && url.pathname === '/agent/schedules') {
        response = !scope ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 }) : Response.json({ schedules: await schedulerStore.list(scope) })
      } else if (request.method === 'POST' && url.pathname === '/agent/schedules') {
        response = !scope ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 }) : await createServerSchedule(request, scope, store, schedulerStore)
      } else if (request.method === 'POST' && url.pathname.startsWith('/agent/schedules/')) {
        response = !scope ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 }) : await setServerScheduleEnabled(url.pathname, scope, schedulerStore)
      } else if (fileRoute) {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : await handleWorkspaceFile(request, scope, fileRoute, store, objectStore, config.s3.maxUploadBytes)
      } else if (oauthStartRoute) {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : await startMcpOAuth(scope, oauthStartRoute.workspaceSlug, oauthStartRoute.serverName, store, app.oauthHandler, config.mcpOAuthCallbackBaseUrl, config.mcpEgress)
      } else if (mcpStatusRoute) {
        response = !scope
          ? Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
          : await getMcpStatus(scope, mcpStatusRoute.workspaceSlug, store)
      } else {
        response = await app.handleRequest(request)
      }
      const durationMs = Date.now() - startedAt
      logger.info({ event: 'http_request_completed', requestId, traceId, tenantId: scope?.tenantId, userId: scope?.userId, status: response.status, durationMs })
      void operationsReporter.reportTrace({ traceId, requestId, event: 'http_request_completed', tenantId: scope?.tenantId, userId: scope?.userId, status: response.status, durationMs, createdAt: Date.now() }).catch((error) => logger.error({ event: 'operations_trace_delivery_failed', traceId, error: getErrorMessage(error) }))
      if (scope) {
        const record: AuditRecord = {
          ...scope,
          action: `${request.method} ${url.pathname}`,
          resource: url.pathname,
          result: response.ok ? 'success' : 'failure',
          requestId,
          traceId,
        }
        await auditLog.append(record)
        void operationsReporter.reportAudit(record).catch((error) => logger.error({ event: 'operations_audit_delivery_failed', traceId, error: getErrorMessage(error) }))
      }
      response.headers.set('x-trace-id', traceId)
      return response
    },
    async initialize() {
      if (redis instanceof NodeRedisClient) await redis.connect()
      await store.initializeSchema()
      await taskLease.initializeSchema()
      await usageLedger.initializeSchema()
      await auditLog.initializeSchema()
      await spanStore.initializeSchema()
      await signalStore.initializeSchema()
      await evalDatasetStore.initializeSchema()
      await interactionStore.initializeSchema()
      await agentRegistry.initializeSchema()
      await authSessionStore.initializeSchema()
      await schedulerStore.initializeSchema()
      scheduler.start()
      startSignalScanner()
    },
    async shutdown() {
      scheduler.stop()
      if (signalTimer) clearInterval(signalTimer)
      const taskIds = app.taskRunner.cancelAllTasks()
      await Promise.all(taskIds.map((taskId) => app.taskRunner.waitForTask(taskId)))
      await app.taskRunner.flushDurableEventWrites()
      await mcpConnections?.closeAll()
      if (redis instanceof NodeRedisClient) await redis.close()
      logger.info({ event: 'server_shutdown_completed' })
    },
  }
}

async function purgeAuditRecords(request: Request, scope: AgentRuntimeScope, auditLog: PostgresAuditLog): Promise<Response> {
  let body: { before?: unknown }
  try {
    body = await request.json() as { before?: unknown }
  } catch {
    return Response.json({ error: '请求体必须是 JSON' }, { status: 400 })
  }
  const before = typeof body.before === 'number' ? body.before : Number(body.before)
  if (!Number.isFinite(before) || before < 0) return Response.json({ error: 'before 必须是非负 Unix 毫秒时间戳' }, { status: 400 })
  try { await auditLog.purgeBefore(scope, before) } catch (error) { return Response.json({ error: getErrorMessage(error) }, { status: 409 }) }
  return new Response(null, { status: 204 })
}

async function createAuditLegalHold(request: Request, scope: AgentRuntimeScope, auditLog: PostgresAuditLog): Promise<Response> {
  let body: { holdId?: unknown; reason?: unknown }
  try { body = await request.json() as { holdId?: unknown; reason?: unknown } } catch { return Response.json({ error: '请求体必须是 JSON' }, { status: 400 }) }
  if (typeof body.holdId !== 'string' || body.holdId.trim().length === 0 || typeof body.reason !== 'string' || body.reason.trim().length === 0) {
    return Response.json({ error: 'holdId 与 reason 必须是非空字符串' }, { status: 400 })
  }
  await auditLog.createLegalHold({ ...scope, holdId: body.holdId.trim(), reason: body.reason.trim() })
  return new Response(null, { status: 201 })
}

async function releaseAuditLegalHold(scope: AgentRuntimeScope, holdId: string, auditLog: PostgresAuditLog): Promise<Response> {
  if (!holdId) return Response.json({ error: 'holdId 不能为空' }, { status: 400 })
  return await auditLog.releaseLegalHold(scope, holdId) ? new Response(null, { status: 204 }) : Response.json({ error: '法律保全不存在或已释放' }, { status: 404 })
}

async function startMcpOAuth(
  scope: AgentRuntimeScope,
  workspaceSlug: string,
  serverName: string,
  store: PostgresTenantRuntimeStore,
  handler: import('@gravitas/shared/utils').ServerMcpOAuthCallbackHandler,
  callbackBaseUrl: string | undefined,
  egressPolicy: PromaWebServerConfig['mcpEgress'],
): Promise<Response> {
  if (!callbackBaseUrl || !egressPolicy) return Response.json({ error: '服务端未启用 MCP OAuth egress 或未配置回调地址' }, { status: 503 })
  const workspace = await store.getWorkspace(scope, workspaceSlug)
  const entry = workspace?.mcpServers[serverName]
  const auth = entry?.auth
  if (!entry || auth?.type !== 'oauthAuthorizationCode' || !auth.authorizationEndpoint || !auth.clientId || !auth.redirectUri) {
    return Response.json({ error: 'MCP OAuth 授权码配置不完整或不可访问' }, { status: 400 })
  }
  let mcpConfig
  try {
    mcpConfig = validateServerMcpConfig(serverName, entry, egressPolicy)
    validateServerMcpOAuthEndpoint(serverName, auth.authorizationEndpoint, mcpConfig)
    if (!auth.tokenEndpoint) throw new Error(`MCP ${serverName} OAuth 缺少 token endpoint`)
    validateServerMcpOAuthEndpoint(serverName, auth.tokenEndpoint, mcpConfig)
  } catch (error) {
    return Response.json({ error: redactOperationalError(getErrorMessage(error)) }, { status: 400 })
  }
  if (auth.clientSecret) await store.setMcpClientSecret({ ...scope, workspaceSlug, serverName, clientSecret: auth.clientSecret })
  const registered = handler.registerPending({
    ...scope,
    workspaceSlug,
    serverName,
    callbackBaseUrl,
    finishAuth: async (code) => exchangeMcpAuthorizationCode(entry, code, mcpConfig, await store.getMcpClientSecret(scope, workspaceSlug, serverName)),
  })
  return Response.json({ authorizationUrl: createMcpOAuthAuthorizationUrl({ authorizationEndpoint: auth.authorizationEndpoint, clientId: auth.clientId, redirectUri: auth.redirectUri, scope: auth.scope, state: registered.authorizationState }) })
}

function matchMcpOAuthStartRoute(method: string, pathname: string): { workspaceSlug: string; serverName: string } | undefined {
  const segments = pathname.split('/').filter(Boolean)
  if (method !== 'POST' || segments.length !== 6 || segments[0] !== 'agent' || segments[1] !== 'workspaces' || segments[3] !== 'mcp' || segments[5] !== 'oauth') return undefined
  return { workspaceSlug: decodeURIComponent(segments[2] ?? ''), serverName: decodeURIComponent(segments[4] ?? '') }
}

function matchMcpStatusRoute(method: string, pathname: string): { workspaceSlug: string } | undefined {
  const segments = pathname.split('/').filter(Boolean)
  if (method !== 'GET' || segments.length !== 4 || segments[0] !== 'agent' || segments[1] !== 'workspaces' || segments[3] !== 'mcp') return undefined
  return { workspaceSlug: decodeURIComponent(segments[2] ?? '') }
}

async function getMcpStatus(scope: AgentRuntimeScope, workspaceSlug: string, store: PostgresTenantRuntimeStore): Promise<Response> {
  const workspace = await store.getWorkspace(scope, workspaceSlug)
  if (!workspace) return Response.json({ error: '工作区不存在或不可访问' }, { status: 404 })
  const servers = await Promise.all(Object.entries(workspace.mcpServers).map(async ([serverName, config]) => ({
    serverName,
    transport: config.type,
    authType: config.auth?.type ?? 'none',
    connected: Boolean(await store.getMcpOAuthTokens(scope, workspaceSlug, serverName)),
  })))
  return Response.json({ workspaceSlug, servers })
}

function parseAuditResult(value: string | null): 'success' | 'failure' | undefined {
  return value === 'success' || value === 'failure' ? value : undefined
}

function hasAnyRole(scope: AgentRuntimeScope, required: readonly AgentRuntimeRole[]): boolean {
  return scope.roles?.some((role) => required.includes(role)) ?? false
}

/** 普通 Agent 写操作只允许 operator 或 admin；viewer 与 security-auditor 保持只读。 */
function requireAgentActionRole(scope: AgentRuntimeScope, request: Request): Response | undefined {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return undefined
  if (!urlStartsWithAgentApi(request.url)) return undefined
  return hasAnyRole(scope, ['operator', 'admin'])
    ? undefined
    : Response.json({ error: '执行或修改 Agent 资源需要 operator 或 admin 角色' }, { status: 403 })
}

function urlStartsWithAgentApi(rawUrl: string): boolean {
  return new URL(rawUrl).pathname.startsWith('/agent/')
}

function parseAuditTimestamp(value: string | null): number | undefined {
  if (!value) return undefined
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined
}

function parsePage(value: string | null): number {
  const page = Number(value)
  return Number.isSafeInteger(page) && page > 0 ? page : 1
}

function parsePageLimit(value: string | null): number {
  const limit = Number(value)
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50
}

function parseArchivedFilter(value: string | null): boolean | null {
  if (value === 'true') return true
  if (value === 'all') return null
  return false
}

async function createServerSchedule(request: Request, scope: AgentRuntimeScope, store: PostgresTenantRuntimeStore, schedulerStore: PostgresServerSchedulerStore): Promise<Response> {
  let body: { sessionId?: unknown; prompt?: unknown; intervalMs?: unknown; schedule?: unknown }
  try { body = await request.json() as { sessionId?: unknown; prompt?: unknown; intervalMs?: unknown; schedule?: unknown } } catch { return Response.json({ error: '请求体必须是 JSON' }, { status: 400 }) }
  if (typeof body.sessionId !== 'string' || !body.sessionId.trim() || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return Response.json({ error: 'sessionId 与 prompt 必须是非空字符串' }, { status: 400 })
  }
  const schedule = parseServerSchedule(body)
  if (!schedule) return Response.json({ error: '计划必须是 interval（不小于 60000ms）或带有效 IANA 时区的 cron' }, { status: 400 })
  try { nextRunForSchedule(schedule) } catch { return Response.json({ error: 'Cron 表达式或时区无效' }, { status: 400 }) }
  if (!await store.getSession(scope, body.sessionId)) return Response.json({ error: '会话不存在或不可访问' }, { status: 404 })
  const created = await schedulerStore.create({ ...scope, sessionId: body.sessionId, prompt: body.prompt.trim(), schedule, enabled: true })
  return Response.json({ schedule: created }, { status: 201 })
}

async function getHealthDashboard(
  scope: AgentRuntimeScope | undefined,
  metrics: PostgresRuntimeMetrics,
  usageLedger: PostgresUsageLedger,
  budget: TenantBudgetPolicy | undefined,
): Promise<Response> {
  if (!scope) return Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
  if (!hasAnyRole(scope, ['operator', 'admin', 'security-auditor'])) {
    return Response.json({ error: '需要 operator、admin 或 security-auditor 角色' }, { status: 403 })
  }
  const m = await metrics.get(scope)
  const monthStart = Date.now() - 30 * 24 * 60 * 60 * 1_000
  const usage = await usageLedger.summarize({ ...scope, from: monthStart })
  const health = computeHealthDashboard({
    monthlyCostMicroUsd: usage.costMicroUsd,
    // 慢：暂无 spans latency 聚合，先以 0 占位；接入 spans p95 后替换
    p95LatencyMs: 0,
    totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    totalRuns: m.runningTasks + m.completedTasks24h + m.failedTasks24h + m.cancelledTasks24h,
    successRuns: m.completedTasks24h,
    monthlyBudgetMicroUsd: budget?.monthlyCostMicroUsd,
  })
  return Response.json({ health })
}

async function putAgentRegistry(request: Request, scope: AgentRuntimeScope | undefined, store: AgentRegistryStore): Promise<Response> {
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: '请求体必须是 JSON' }, { status: 400 }) }
  if (!scope) return Response.json({ error: '未认证或缺少租户上下文' }, { status: 401 })
  if (!hasAnyRole(scope, ['admin'])) return Response.json({ error: '需要 admin 角色' }, { status: 403 })
  const parsed = parseAgentCardFromBody(body)
  if (parsed.error) return Response.json({ error: parsed.error }, { status: 400 })
  await store.upsert(scope, parsed.card!)
  return Response.json({ ok: true })
}

async function createSignal(request: Request, scope: AgentRuntimeScope, signalStore: PostgresSignalStore): Promise<Response> {
  let body: { description?: unknown; matcher?: unknown; enabled?: unknown }
  try { body = await request.json() as { description?: unknown; matcher?: unknown; enabled?: unknown } } catch { return Response.json({ error: '请求体必须是 JSON' }, { status: 400 }) }
  if (typeof body.description !== 'string' || !body.description.trim()) return Response.json({ error: 'description 必须是非空字符串（用自然语言描述要监测的行为）' }, { status: 400 })
  const matcher = parseSignalMatcher(body.matcher)
  if (!matcher) return Response.json({ error: 'matcher 无效或缺少必填字段' }, { status: 400 })
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled)
  const signal = await signalStore.create({ ...scope, description: body.description.trim(), matcher, enabled })
  return Response.json({ signal }, { status: 201 })
}

function parseSignalMatcher(value: unknown): SignalMatcher | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const m = value as Record<string, unknown>
  const type = m.type
  if (type === 'task_failure_rate') {
    const minFailRate = numberIn(m.minFailRate, 0, 1)
    const windowMs = numberIn(m.windowMs, 1_000, undefined)
    return minFailRate != null && windowMs != null && windowMs >= 1_000 ? { type: 'task_failure_rate', minFailRate, windowMs } : undefined
  }
  if (type === 'tool_repeat_failure') {
    const namePrefix = typeof m.namePrefix === 'string' && m.namePrefix.trim() ? m.namePrefix.trim() : 'tool:'
    const minFailures = numberIn(m.minFailures, 1, undefined)
    const windowMs = numberIn(m.windowMs, 1_000, undefined)
    return minFailures != null && minFailures >= 1 && windowMs != null && windowMs >= 1_000 ? { type: 'tool_repeat_failure', namePrefix, minFailures, windowMs } : undefined
  }
  if (type === 'task_cost_threshold') {
    const thresholdMicroUsd = numberIn(m.thresholdMicroUsd, 1, undefined)
    const windowMs = numberIn(m.windowMs, 1_000, undefined)
    return thresholdMicroUsd != null && thresholdMicroUsd >= 1 && windowMs != null && windowMs >= 1_000 ? { type: 'task_cost_threshold', thresholdMicroUsd, windowMs } : undefined
  }
  if (type === 'stale_task') {
    const staleAfterMs = numberIn(m.staleAfterMs, 1_000, undefined)
    return staleAfterMs != null && staleAfterMs >= 1_000 ? { type: 'stale_task', staleAfterMs } : undefined
  }
  if (type === 'provider_error') {
    const namePrefix = typeof m.namePrefix === 'string' && m.namePrefix.trim() ? m.namePrefix.trim() : 'provider:'
    const minErrors = numberIn(m.minErrors, 1, undefined)
    const windowMs = numberIn(m.windowMs, 1_000, undefined)
    return minErrors != null && minErrors >= 1 && windowMs != null && windowMs >= 1_000 ? { type: 'provider_error', namePrefix, minErrors, windowMs } : undefined
  }
  return undefined
}

function numberIn(value: unknown, min?: number, max?: number): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return undefined
  if (min != null && n < min) return undefined
  if (max != null && n > max) return undefined
  return n
}

async function createEvalDataset(request: Request, scope: AgentRuntimeScope, evalDatasetStore: PostgresEvalDatasetStore): Promise<Response> {
  let body: { name?: unknown; description?: unknown; windowMs?: unknown; sampleRate?: unknown }
  try { body = await request.json() as { name?: unknown; description?: unknown; windowMs?: unknown; sampleRate?: unknown } } catch { return Response.json({ error: '请求体必须是 JSON' }, { status: 400 }) }
  if (typeof body.name !== 'string' || !body.name.trim()) return Response.json({ error: 'name 必须是非空字符串' }, { status: 400 })
  const windowMs = numberIn(body.windowMs, 1_000, undefined)
  if (windowMs == null) return Response.json({ error: 'windowMs 必须是不小于 1s 的数' }, { status: 400 })
  let sampleRate = 1
  if (body.sampleRate != null) {
    const rate = numberIn(body.sampleRate, 0.001, 1)
    if (rate == null) return Response.json({ error: 'sampleRate 必须在 0..1 之间' }, { status: 400 })
    sampleRate = rate
  }
  const dataset = await evalDatasetStore.createDatasetFromWindow({
    scope, name: body.name.trim(), description: typeof body.description === 'string' ? body.description : undefined, windowMs, sampleRate,
  })
  return Response.json({ dataset }, { status: 201 })
}

async function archiveRunToDataset(request: Request, scope: AgentRuntimeScope, evalDatasetStore: PostgresEvalDatasetStore): Promise<Response> {
  let body: { datasetId?: unknown; taskId?: unknown }
  try { body = await request.json() as { datasetId?: unknown; taskId?: unknown } } catch { return Response.json({ error: '请求体必须是 JSON' }, { status: 400 }) }
  if (typeof body.datasetId !== 'string' || !body.datasetId.trim() || typeof body.taskId !== 'string' || !body.taskId.trim()) return Response.json({ error: 'datasetId 与 taskId 必须是非空字符串' }, { status: 400 })
  const sample = await evalDatasetStore.archiveRun({ scope, datasetId: body.datasetId.trim(), taskId: body.taskId.trim() })
  return sample ? Response.json({ sample }, { status: 201 }) : Response.json({ error: '数据集不存在或无对应 span' }, { status: 404 })
}

function parseServerSchedule(body: { intervalMs?: unknown; schedule?: unknown }): import('./scheduler-store.ts').ServerScheduleSpec | undefined {
  if (body.schedule && typeof body.schedule === 'object') {
    const input = body.schedule as { type?: unknown; intervalMs?: unknown; expression?: unknown; timezone?: unknown }
    if (input.type === 'cron' && typeof input.expression === 'string' && input.expression.trim() && typeof input.timezone === 'string' && input.timezone.trim()) return { type: 'cron', expression: input.expression.trim(), timezone: input.timezone.trim() }
    if (input.type === 'interval') return intervalSchedule(input.intervalMs)
    return undefined
  }
  return intervalSchedule(body.intervalMs)
}

function intervalSchedule(value: unknown): import('./scheduler-store.ts').ServerScheduleSpec | undefined {
  const intervalMs = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(intervalMs) && intervalMs >= 60_000 ? { type: 'interval', intervalMs } : undefined
}

async function setServerScheduleEnabled(pathname: string, scope: AgentRuntimeScope, schedulerStore: PostgresServerSchedulerStore): Promise<Response> {
  const match = /^\/agent\/schedules\/([^/]+)\/(pause|resume)$/.exec(pathname)
  if (!match) return Response.json({ error: '未知 Scheduler 操作' }, { status: 404 })
  const schedule = await schedulerStore.setEnabled(scope, decodeURIComponent(match[1] ?? ''), match[2] === 'resume')
  return schedule ? Response.json({ schedule }) : Response.json({ error: '定时任务不存在或不可访问' }, { status: 404 })
}

function createAuditExportResponse(records: Awaited<ReturnType<PostgresAuditLog['list']>>, format: string | null): Response {
  if (format === 'json') {
    return new Response(JSON.stringify({ records }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="proma-audit.json"' },
    })
  }
  const header = ['createdAt', 'tenantId', 'userId', 'action', 'resource', 'result', 'requestId', 'traceId', 'taskId']
  const rows = records.map((record) => header.map((key) => csvValue(record[key as keyof typeof record])).join(','))
  return new Response([header.join(','), ...rows].join('\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="proma-audit.csv"' },
  })
}

function createBillingExportResponse(records: UsageLedgerRecord[], format: string | null): Response {
  if (format === 'json') {
    return new Response(JSON.stringify({ records }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="proma-billing.json"' },
    })
  }
  const header = ['recordedAt', 'tenantId', 'userId', 'taskId', 'sessionId', 'provider', 'modelId', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'priceEffectiveAt', 'costMicroUsd']
  const rows = records.map((record) => header.map((key) => csvValue(record[key as keyof UsageLedgerRecord])).join(','))
  return new Response([header.join(','), ...rows].join('\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="proma-billing.csv"' },
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
  return createWorkspaceFileDownloadResponse(object.body, object.contentType)
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
    return tenantId && userId ? { tenantId, userId, roles: ['operator'] } : undefined
  }
}
