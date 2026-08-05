import type { ProviderType, SDKMessage } from '@gravitas/shared'
import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@gravitas/shared/utils'

export interface UsagePriceEntry {
  provider: ProviderType
  modelId: string
  effectiveAt: number
  inputPerMillionUsd: number
  outputPerMillionUsd: number
  cacheReadPerMillionUsd?: number
  cacheWritePerMillionUsd?: number
}

export interface NormalizedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface UsageLedgerRecord extends AgentRuntimeScope, NormalizedUsage {
  taskId: string
  sessionId: string
  provider: ProviderType
  modelId: string
  priceEffectiveAt?: number
  costMicroUsd?: number
  recordedAt: number
}

export interface TenantBudgetPolicy {
  monthlyCostMicroUsd?: number
  modelMonthlyCostMicroUsd?: number
}

export interface UsageLedgerQuery extends AgentRuntimeScope {
  from?: number
  to?: number
  limit?: number
}

export interface UsageLedgerSummary extends NormalizedUsage {
  costMicroUsd: number
  pricedRecordCount: number
  unpricedRecordCount: number
}

export interface BudgetThresholdAlert extends AgentRuntimeScope {
  thresholdPercent: 80 | 100
  costMicroUsd: number
  budgetMicroUsd: number
  monthStartedAt: number
}

export class PostgresUsageLedger {
  constructor(private readonly client: AgentRuntimePostgresClient, private readonly prices: UsagePriceEntry[]) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_usage (
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      input_tokens BIGINT NOT NULL,
      output_tokens BIGINT NOT NULL,
      cache_read_tokens BIGINT NOT NULL,
      cache_write_tokens BIGINT NOT NULL,
      price_effective_at BIGINT,
      cost_microusd BIGINT,
      recorded_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, user_id, task_id)
    )`)
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_budget_alerts (
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      month_started_at BIGINT NOT NULL,
      threshold_percent SMALLINT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, user_id, month_started_at, threshold_percent)
    )`)
  }

  async record(record: Omit<UsageLedgerRecord, 'priceEffectiveAt' | 'costMicroUsd' | 'recordedAt'>): Promise<UsageLedgerRecord> {
    const now = Date.now()
    const price = findPrice(this.prices, record.provider, record.modelId, now)
    const stored: UsageLedgerRecord = {
      ...record,
      ...(price ? { priceEffectiveAt: price.effectiveAt, costMicroUsd: calculateCostMicroUsd(record, price) } : {}),
      recordedAt: now,
    }
    await this.client.query(
      `INSERT INTO proma_runtime_usage (
        tenant_id, user_id, task_id, session_id, provider, model_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        price_effective_at, cost_microusd, recorded_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (tenant_id, user_id, task_id) DO NOTHING`,
      [stored.tenantId, stored.userId, stored.taskId, stored.sessionId, stored.provider, stored.modelId,
        stored.inputTokens, stored.outputTokens, stored.cacheReadTokens, stored.cacheWriteTokens,
        stored.priceEffectiveAt ?? null, stored.costMicroUsd ?? null, stored.recordedAt],
    )
    return stored
  }

  async assertTaskWithinBudget(scope: AgentRuntimeScope, modelId: string, policy: TenantBudgetPolicy | undefined): Promise<void> {
    if (!policy?.monthlyCostMicroUsd && !policy?.modelMonthlyCostMicroUsd) return
    const start = new Date()
    start.setUTCDate(1)
    start.setUTCHours(0, 0, 0, 0)
    const result = await this.client.query<{ cost_microusd: number | string | null }>(
      `SELECT COALESCE(SUM(cost_microusd), 0) AS cost_microusd
      FROM proma_runtime_usage
      WHERE tenant_id = $1 AND user_id = $2 AND recorded_at >= $3`,
      [scope.tenantId, scope.userId, start.getTime()],
    )
    if (policy.monthlyCostMicroUsd != null && Number(result.rows[0]?.cost_microusd ?? 0) >= policy.monthlyCostMicroUsd) {
      throw new Error('本月预算已用尽，无法启动新任务')
    }
    if (policy.modelMonthlyCostMicroUsd != null) {
      const modelResult = await this.client.query<{ cost_microusd: number | string | null }>(
        `SELECT COALESCE(SUM(cost_microusd), 0) AS cost_microusd FROM proma_runtime_usage WHERE tenant_id = $1 AND user_id = $2 AND model_id = $3 AND recorded_at >= $4`,
        [scope.tenantId, scope.userId, modelId, start.getTime()],
      )
      if (Number(modelResult.rows[0]?.cost_microusd ?? 0) >= policy.modelMonthlyCostMicroUsd) throw new Error('该模型本月额度已用尽，无法启动新任务')
    }
  }

  async list(query: UsageLedgerQuery): Promise<UsageLedgerRecord[]> {
    const limit = Math.min(Math.max(query.limit ?? 500, 1), 1_000)
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT tenant_id, user_id, task_id, session_id, provider, model_id,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              price_effective_at, cost_microusd, recorded_at
       FROM proma_runtime_usage
       WHERE tenant_id = $1 AND user_id = $2
         AND ($3::bigint IS NULL OR recorded_at >= $3)
         AND ($4::bigint IS NULL OR recorded_at <= $4)
       ORDER BY recorded_at DESC LIMIT $5`,
      [query.tenantId, query.userId, query.from ?? null, query.to ?? null, limit],
    )
    return result.rows.map(toUsageLedgerRecord)
  }

  async summarize(query: Omit<UsageLedgerQuery, 'limit'>): Promise<UsageLedgerSummary> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
              COALESCE(SUM(cost_microusd), 0) AS cost_microusd,
              COUNT(cost_microusd) AS priced_record_count,
              COUNT(*) - COUNT(cost_microusd) AS unpriced_record_count
       FROM proma_runtime_usage
       WHERE tenant_id = $1 AND user_id = $2
         AND ($3::bigint IS NULL OR recorded_at >= $3)
         AND ($4::bigint IS NULL OR recorded_at <= $4)`,
      [query.tenantId, query.userId, query.from ?? null, query.to ?? null],
    )
    const row = result.rows[0] ?? {}
    return {
      inputTokens: toSafeNumber(row.input_tokens),
      outputTokens: toSafeNumber(row.output_tokens),
      cacheReadTokens: toSafeNumber(row.cache_read_tokens),
      cacheWriteTokens: toSafeNumber(row.cache_write_tokens),
      costMicroUsd: toSafeNumber(row.cost_microusd),
      pricedRecordCount: toSafeNumber(row.priced_record_count),
      unpricedRecordCount: toSafeNumber(row.unpriced_record_count),
    }
  }

  async claimMonthlyBudgetThresholdAlert(scope: AgentRuntimeScope, policy: TenantBudgetPolicy | undefined): Promise<BudgetThresholdAlert | undefined> {
    const budgetMicroUsd = policy?.monthlyCostMicroUsd
    if (budgetMicroUsd == null || budgetMicroUsd < 1) return undefined
    const monthStartedAt = startOfCurrentMonth()
    const summary = await this.summarize({ ...scope, from: monthStartedAt })
    const thresholdPercent: 80 | 100 | undefined = summary.costMicroUsd >= budgetMicroUsd
      ? 100
      : summary.costMicroUsd * 100 >= budgetMicroUsd * 80 ? 80 : undefined
    if (!thresholdPercent) return undefined
    const inserted = await this.client.query<{ threshold_percent: number }>(
      `INSERT INTO proma_runtime_budget_alerts (tenant_id, user_id, month_started_at, threshold_percent, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING threshold_percent`,
      [scope.tenantId, scope.userId, monthStartedAt, thresholdPercent, Date.now()],
    )
    if (inserted.rows.length === 0) return undefined
    return { ...scope, thresholdPercent, costMicroUsd: summary.costMicroUsd, budgetMicroUsd, monthStartedAt }
  }
}

export function usageFromMessages(messages: SDKMessage[]): NormalizedUsage | undefined {
  const assistant = messages.findLast((message) => message.type === 'assistant')
  if (!assistant || !hasMessage(assistant) || typeof assistant.message !== 'object' || assistant.message == null) return undefined
  const message = assistant.message as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
  if (!message.usage) return undefined
  return {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  }
}

function hasMessage(value: SDKMessage): value is SDKMessage & { message: unknown } {
  return typeof value === 'object' && value !== null && 'message' in value
}

function findPrice(prices: UsagePriceEntry[], provider: ProviderType, modelId: string, now: number): UsagePriceEntry | undefined {
  return prices
    .filter((price) => price.provider === provider && price.modelId === modelId && price.effectiveAt <= now)
    .sort((left, right) => right.effectiveAt - left.effectiveAt)[0]
}

function calculateCostMicroUsd(usage: NormalizedUsage, price: UsagePriceEntry): number {
  const usd = usage.inputTokens * price.inputPerMillionUsd / 1_000_000
    + usage.outputTokens * price.outputPerMillionUsd / 1_000_000
    + usage.cacheReadTokens * (price.cacheReadPerMillionUsd ?? price.inputPerMillionUsd) / 1_000_000
    + usage.cacheWriteTokens * (price.cacheWritePerMillionUsd ?? price.inputPerMillionUsd) / 1_000_000
  return Math.round(usd * 1_000_000)
}

function toUsageLedgerRecord(row: Record<string, unknown>): UsageLedgerRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    taskId: String(row.task_id),
    sessionId: String(row.session_id),
    provider: String(row.provider) as ProviderType,
    modelId: String(row.model_id),
    inputTokens: toSafeNumber(row.input_tokens),
    outputTokens: toSafeNumber(row.output_tokens),
    cacheReadTokens: toSafeNumber(row.cache_read_tokens),
    cacheWriteTokens: toSafeNumber(row.cache_write_tokens),
    ...(row.price_effective_at == null ? {} : { priceEffectiveAt: toSafeNumber(row.price_effective_at) }),
    ...(row.cost_microusd == null ? {} : { costMicroUsd: toSafeNumber(row.cost_microusd) }),
    recordedAt: toSafeNumber(row.recorded_at),
  }
}

function toSafeNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function startOfCurrentMonth(): number {
  const start = new Date()
  start.setUTCDate(1)
  start.setUTCHours(0, 0, 0, 0)
  return start.getTime()
}
