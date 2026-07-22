import { createPromaWebServerApplication } from './app.ts'
import { createOidcJwtAuth } from './jwt-auth.ts'

const databaseUrl = requireEnvironment('PROMA_WEB_DATABASE_URL')
const redisUrl = requireEnvironment('PROMA_WEB_REDIS_URL')
const s3 = {
  bucket: requireEnvironment('PROMA_WEB_S3_BUCKET'),
  region: process.env.PROMA_WEB_S3_REGION ?? 'auto',
  endpoint: process.env.PROMA_WEB_S3_ENDPOINT,
  accessKeyId: process.env.PROMA_WEB_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.PROMA_WEB_S3_SECRET_ACCESS_KEY,
  maxUploadBytes: Number.parseInt(process.env.PROMA_WEB_MAX_UPLOAD_BYTES ?? '26214400', 10),
}
const envelopeKey = requireEnvironment('PROMA_WEB_ENVELOPE_KEY')
const envelopeKeyId = process.env.PROMA_WEB_ENVELOPE_KEY_ID ?? 'local-v1'
const trustedHeaderAuth = process.env.PROMA_WEB_TRUSTED_HEADER_AUTH === '1'
const workspaceRoot = process.env.PROMA_WEB_WORKSPACE_ROOT ?? '/tmp/proma-web-workspaces'
const workerId = process.env.PROMA_WEB_WORKER_ID ?? crypto.randomUUID()
const taskLeaseMs = Number.parseInt(process.env.PROMA_WEB_TASK_LEASE_MS ?? '30000', 10)
const recoveryStaleAfterMs = parsePositiveInteger(process.env.PROMA_WEB_RECOVERY_STALE_AFTER_MS, 'PROMA_WEB_RECOVERY_STALE_AFTER_MS')
const priceCatalog = parsePriceCatalog(process.env.PROMA_WEB_PRICE_CATALOG)
const tenantBudget = parseTenantBudget(process.env.PROMA_WEB_MONTHLY_BUDGET_MICROUSD, process.env.PROMA_WEB_MODEL_MONTHLY_BUDGET_MICROUSD)
const rateLimit = parseRateLimit(process.env.PROMA_WEB_RATE_LIMIT_TASKS, process.env.PROMA_WEB_RATE_LIMIT_WINDOW_MS)
const mcpEgress = parseMcpEgress(process.env.PROMA_WEB_MCP_ALLOWED_ORIGINS, process.env.PROMA_WEB_MCP_MAX_TIMEOUT_MS)
const executor = parseExecutor(process.env.PROMA_WEB_EXECUTOR_ENDPOINT, process.env.PROMA_WEB_EXECUTOR_TOKEN)
const mcpOAuthCallbackBaseUrl = process.env.PROMA_WEB_MCP_OAUTH_CALLBACK_BASE_URL
const operations = parseOperations(process.env.PROMA_WEB_SIEM_WEBHOOK_URL, process.env.PROMA_WEB_ALERT_WEBHOOK_URL)
const subtaskLimits = parseSubtaskLimits(process.env.PROMA_WEB_SUBTASK_MAX_DEPTH, process.env.PROMA_WEB_SUBTASK_MAX_CHILDREN, process.env.PROMA_WEB_SUBTASK_MAX_OUTPUT_TOKENS)
const kms = parseKms(process.env.PROMA_WEB_AWS_KMS_KEY_ID, process.env.PROMA_WEB_AWS_REGION, process.env.PROMA_WEB_AWS_KMS_ENDPOINT)

if (!trustedHeaderAuth) {
  requireEnvironment('PROMA_WEB_OIDC_ISSUER')
  requireEnvironment('PROMA_WEB_OIDC_AUDIENCE')
  requireEnvironment('PROMA_WEB_OIDC_JWKS_URL')
}

const application = createPromaWebServerApplication({
  databaseUrl,
  redisUrl,
  s3,
  envelopeKey,
  envelopeKeyId,
  trustedHeaderAuth,
  workspaceRoot,
  workerId,
  taskLeaseMs,
  recoveryStaleAfterMs,
  priceCatalog,
  tenantBudget,
  rateLimit,
  mcpEgress,
  executor,
  mcpOAuthCallbackBaseUrl,
  operations,
  subtaskLimits,
  kms,
}, trustedHeaderAuth ? {} : { auth: createOidcJwtAuth({
  issuer: requireEnvironment('PROMA_WEB_OIDC_ISSUER'), audience: requireEnvironment('PROMA_WEB_OIDC_AUDIENCE'), jwksUrl: requireEnvironment('PROMA_WEB_OIDC_JWKS_URL'),
  tenantClaim: process.env.PROMA_WEB_OIDC_TENANT_CLAIM, userClaim: process.env.PROMA_WEB_OIDC_USER_CLAIM,
}) })

await application.initialize()

const port = Number.parseInt(process.env.PROMA_WEB_PORT ?? '3000', 10)
const hostname = process.env.PROMA_WEB_HOST ?? '127.0.0.1'
const server = Bun.serve({
  port,
  hostname,
  fetch: application.fetch,
})

console.info(`Proma Web 服务已启动: http://${hostname}:${port}`)

let isShuttingDown = false
const shutdown = async (): Promise<void> => {
  if (isShuttingDown) return
  isShuttingDown = true
  await application.shutdown()
  server.stop(true)
}
process.once('SIGTERM', () => { void shutdown() })
process.once('SIGINT', () => { void shutdown() })

function requireEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`缺少必要环境变量: ${name}`)
  return value
}

function parsePriceCatalog(raw: string | undefined): import('./billing.ts').UsagePriceEntry[] {
  if (!raw) return []
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value)) throw new Error('PROMA_WEB_PRICE_CATALOG 必须是 JSON 数组')
  return value as import('./billing.ts').UsagePriceEntry[]
}

function parseTenantBudget(tenantRaw: string | undefined, modelRaw: string | undefined): import('./billing.ts').TenantBudgetPolicy | undefined {
  if (!tenantRaw && !modelRaw) return undefined
  const parse = (raw: string | undefined, name: string): number | undefined => {
    if (!raw) return undefined
    const value = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`)
    return value
  }
  return {
    monthlyCostMicroUsd: parse(tenantRaw, 'PROMA_WEB_MONTHLY_BUDGET_MICROUSD'),
    modelMonthlyCostMicroUsd: parse(modelRaw, 'PROMA_WEB_MODEL_MONTHLY_BUDGET_MICROUSD'),
  }
}

function parseRateLimit(maxTasksRaw: string | undefined, windowMsRaw: string | undefined): { maxTasks: number; windowMs: number } | undefined {
  if (!maxTasksRaw && !windowMsRaw) return undefined
  const maxTasks = Number.parseInt(maxTasksRaw ?? '', 10)
  const windowMs = Number.parseInt(windowMsRaw ?? '', 10)
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1_000) {
    throw new Error('PROMA_WEB_RATE_LIMIT_TASKS 与 PROMA_WEB_RATE_LIMIT_WINDOW_MS 必须是有效正整数')
  }
  return { maxTasks, windowMs }
}

function parsePositiveInteger(raw: string | undefined, name: string): number | undefined {
  if (!raw) return undefined
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < 1_000) throw new Error(`${name} 必须是不小于 1000 的正整数`)
  return value
}

function parseMcpEgress(originsRaw: string | undefined, timeoutRaw: string | undefined): { allowedOrigins: string[]; maxTimeoutMs: number } | undefined {
  if (!originsRaw) return undefined
  const allowedOrigins = originsRaw.split(',').map((value) => value.trim()).filter(Boolean).map((value) => new URL(value).origin)
  if (allowedOrigins.length === 0) throw new Error('PROMA_WEB_MCP_ALLOWED_ORIGINS 至少需要一个 HTTP(S) origin')
  if (allowedOrigins.some((origin) => !origin.startsWith('https://') && !origin.startsWith('http://'))) {
    throw new Error('PROMA_WEB_MCP_ALLOWED_ORIGINS 只能包含 HTTP(S) origin')
  }
  const maxTimeoutMs = parsePositiveInteger(timeoutRaw, 'PROMA_WEB_MCP_MAX_TIMEOUT_MS') ?? 30_000
  return { allowedOrigins: [...new Set(allowedOrigins)], maxTimeoutMs }
}

function parseExecutor(endpoint: string | undefined, token: string | undefined): { endpoint: string; token: string } | undefined {
  if (!endpoint && !token) return undefined
  if (!endpoint || !token) throw new Error('PROMA_WEB_EXECUTOR_ENDPOINT 与 PROMA_WEB_EXECUTOR_TOKEN 必须同时配置')
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('PROMA_WEB_EXECUTOR_ENDPOINT 必须是 HTTP(S) URL')
  return { endpoint: url.toString(), token }
}

function parseOperations(siemWebhookUrl: string | undefined, alertWebhookUrl: string | undefined): { siemWebhookUrl?: string; alertWebhookUrl?: string } | undefined {
  if (!siemWebhookUrl && !alertWebhookUrl) return undefined
  for (const value of [siemWebhookUrl, alertWebhookUrl]) {
    if (!value) continue
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('运维 webhook 必须是 HTTP(S) URL')
  }
  return { siemWebhookUrl, alertWebhookUrl }
}

function parseSubtaskLimits(depthRaw: string | undefined, childrenRaw: string | undefined, outputTokensRaw: string | undefined): { maxDepth: number; maxChildrenPerTask: number; maxOutputTokensPerTask: number } {
  const parse = (value: string | undefined, fallback: number, name: string): number => {
    if (!value) return fallback
    const parsed = Number.parseInt(value, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} 必须是正整数`)
    return parsed
  }
  return {
    maxDepth: parse(depthRaw, 1, 'PROMA_WEB_SUBTASK_MAX_DEPTH'),
    maxChildrenPerTask: parse(childrenRaw, 3, 'PROMA_WEB_SUBTASK_MAX_CHILDREN'),
    maxOutputTokensPerTask: parse(outputTokensRaw, 4_000, 'PROMA_WEB_SUBTASK_MAX_OUTPUT_TOKENS'),
  }
}

function parseKms(keyId: string | undefined, region: string | undefined, endpoint: string | undefined): { keyId: string; region: string; endpoint?: string } | undefined {
  if (!keyId) return undefined
  if (!region) throw new Error('配置 PROMA_WEB_AWS_KMS_KEY_ID 时必须同时配置 PROMA_WEB_AWS_REGION')
  if (endpoint) new URL(endpoint)
  return { keyId, region, endpoint }
}
