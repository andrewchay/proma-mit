import type { ProviderType, SDKMessage } from '@proma/shared'
import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@proma/shared/utils'

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
