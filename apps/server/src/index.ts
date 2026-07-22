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
