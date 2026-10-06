/**
 * 新媒体自动化排程：定时生成「待审批」外发动作。
 *
 * 三条铁律（对应 P4-10 的 DoD）：
 * 1. 自动化只创建 pending_approval 动作——本模块只 import requestControlledAction，
 *    不接触 approve / execute / simulate，代码层面就无法越权外发。
 * 2. 无预授权不得外发：规则创建与触发时都会校验执行器是否可用；
 *    没有执行器的平台不会产生「永远无法执行」的审批垃圾。
 * 3. 失败不补发风暴：应用离线期间的到期任务只补跑一次（不做逐次追赶）；
 *    单次失败计入连续失败，连续 3 次自动停用规则并写审计。
 */
import { randomUUID } from 'node:crypto'
import type {
  NewMediaAutomationCadence,
  NewMediaAutomationRule,
  NewMediaAutomationRun,
  NewMediaPlatform,
} from '@gravitas/shared'
import { appendNewMediaAudit, createNewMediaAuditEntry } from './new-media-audit'
import { getControlledActionExecutor, requireControlledActionExecutor } from './new-media-controlled-executor'
import { getNewMediaRecord, listNewMediaRecords, putNewMediaRecord, putNewMediaRecords } from './new-media-sqlite-store'

export const AUTOMATION_RULE_KIND = 'automation-rule'
export const AUTOMATION_RUN_KIND = 'automation-run'

/** 连续失败多少次后自动停用规则。 */
const MAX_CONSECUTIVE_FAILURES = 3

const RULE_KIND = AUTOMATION_RULE_KIND

export interface CreateAutomationRuleInput {
  accountId: string
  platform: NewMediaPlatform
  kind: 'publish' | 'send-reply'
  targetId: string
  summaryTemplate: string
  cadence: NewMediaAutomationCadence
  /** 首次触发时间；不传则按节奏立即计算。 */
  firstRunAt?: number
}

function isValidTimeOfDay(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

function validateCadence(cadence: NewMediaAutomationCadence): void {
  if (cadence.type === 'daily') {
    if (!isValidTimeOfDay(cadence.timeOfDay)) throw new Error('daily 节奏的 timeOfDay 必须是 HH:mm（24 小时制）')
  } else if (cadence.type === 'intervalHours') {
    if (!Number.isInteger(cadence.hours) || cadence.hours < 1 || cadence.hours > 24 * 30) {
      throw new Error('intervalHours 必须是 1 到 720 的整数小时')
    }
  } else {
    throw new Error('不支持的排程节奏')
  }
}

/** 计算下一次触发时间（严格晚于 from，避免同一分钟重复触发）。 */
export function computeNextRunAt(cadence: NewMediaAutomationCadence, from: number): number {
  if (cadence.type === 'intervalHours') return from + cadence.hours * 3_600_000
  const [hours, minutes] = cadence.timeOfDay.split(':').map(Number) as [number, number]
  const candidate = new Date(from)
  candidate.setHours(hours, minutes, 0, 0)
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

async function loadRule(ruleId: string): Promise<NewMediaAutomationRule> {
  const rule = await getNewMediaRecord<NewMediaAutomationRule>(RULE_KIND, ruleId)
  if (!rule) throw new Error('自动化规则不存在')
  return rule
}

export async function createAutomationRule(input: CreateAutomationRuleInput): Promise<NewMediaAutomationRule> {
  if (!input.accountId.trim()) throw new Error('账号标识不能为空')
  if (!input.targetId.trim()) throw new Error('目标内容不能为空')
  if (!input.summaryTemplate.trim()) throw new Error('摘要模板不能为空')
  validateCadence(input.cadence)
  // 无执行器的平台不产生「永远无法执行」的审批。
  requireControlledActionExecutor(input.kind, input.platform)

  const now = Date.now()
  const rule: NewMediaAutomationRule = {
    id: randomUUID(),
    accountId: input.accountId.trim(),
    platform: input.platform,
    kind: input.kind,
    targetId: input.targetId.trim(),
    summaryTemplate: input.summaryTemplate.trim(),
    cadence: input.cadence,
    enabled: true,
    nextRunAt: input.firstRunAt ?? computeNextRunAt(input.cadence, now),
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  }
  await appendNewMediaAudit(
    await createNewMediaAuditEntry({
      domain: 'governance',
      event: 'automation_triggered',
      actor: 'local-user',
      subjectId: rule.id,
      detail: '已创建自动化排程规则；该规则只会生成待审批动作，不会自动执行任何外发。',
      metadata: { platform: rule.platform, kind: rule.kind, cadenceType: rule.cadence.type, targetId: rule.targetId },
    }),
    [{ kind: RULE_KIND, value: rule }],
  )
  return rule
}

export async function listAutomationRules(): Promise<NewMediaAutomationRule[]> {
  const rules = await listNewMediaRecords<NewMediaAutomationRule>(RULE_KIND)
  return rules.sort((left, right) => left.nextRunAt - right.nextRunAt)
}

export async function setAutomationRuleEnabled(ruleId: string, enabled: boolean, reason?: string): Promise<NewMediaAutomationRule> {
  const rule = await loadRule(ruleId)
  const next: NewMediaAutomationRule = { ...rule, enabled, consecutiveFailures: enabled ? 0 : rule.consecutiveFailures, autoDisabledAt: undefined, autoDisabledReason: undefined, updatedAt: Date.now() }
  await putNewMediaRecord(RULE_KIND, next)
  if (!enabled) {
    await appendNewMediaAudit(await createNewMediaAuditEntry({
      domain: 'governance', event: 'automation_disabled', actor: 'local-user', subjectId: ruleId,
      detail: `已停用自动化规则${reason ? `：${reason}` : '。'}`,
      metadata: { platform: rule.platform, kind: rule.kind },
    }))
  }
  return next
}

export async function deleteAutomationRule(ruleId: string): Promise<boolean> {
  const rule = await loadRule(ruleId)
  await setAutomationRuleEnabled(ruleId, false, '规则删除前停用')
  return putNewMediaRecord('automation-rule-deleted', { id: rule.id, deletedAt: Date.now() }).then(async () => {
    // 删除采用 tombstone：保留审计与运行历史可追溯，规则本体不再返回。
    const { deleteNewMediaRecord } = await import('./new-media-sqlite-store')
    return deleteNewMediaRecord(RULE_KIND, rule.id)
  })
}

export async function listAutomationRuns(ruleId?: string): Promise<NewMediaAutomationRun[]> {
  const runs = await listNewMediaRecords<NewMediaAutomationRun>(AUTOMATION_RUN_KIND)
  const scoped = ruleId ? runs.filter((run) => run.ruleId === ruleId) : runs
  return scoped.sort((left, right) => right.ranAt - left.ranAt)
}

function renderSummary(template: string, at: number): string {
  return template.replace(/\{\{date\}\}/g, new Date(at).toISOString().slice(0, 10))
}

async function runOccurrence(rule: NewMediaAutomationRule, occurrenceAt: number, now: number): Promise<NewMediaAutomationRun> {
  // 幂等：同一触发时刻只处理一次。
  const existing = (await listNewMediaRecords<NewMediaAutomationRun>(AUTOMATION_RUN_KIND))
    .find((run) => run.ruleId === rule.id && run.occurrenceAt === occurrenceAt)
  if (existing) return existing

  const makeRun = async (outcome: NewMediaAutomationRun['outcome'], detail: string, extra: Partial<NewMediaAutomationRun> = {}): Promise<NewMediaAutomationRun> => {
    const run: NewMediaAutomationRun = { id: randomUUID(), ruleId: rule.id, occurrenceAt, outcome, detail, ranAt: now, ...extra }
    await putNewMediaRecord(AUTOMATION_RUN_KIND, run)
    return run
  }

  // 执行器缺失时按失败处理：生成无法执行的审批只会堆积垃圾。
  if (!getControlledActionExecutor(rule.kind, rule.platform)) {
    const run = await makeRun('failed', `平台 ${rule.platform} 尚无可用执行器，未生成审批`, { errorCode: 'executor_unavailable' })
    await applyFailure(rule, run)
    return run
  }

  try {
    const { requestControlledAction } = await import('./controlled-actions')
    const action = await requestControlledAction({
      kind: rule.kind,
      platform: rule.platform,
      targetId: rule.targetId,
      accountId: rule.accountId,
      summary: renderSummary(rule.summaryTemplate, occurrenceAt),
    }, 'system:automation')
    const run = await makeRun('created', `已生成待审批动作，等待人工审批（不会自动执行）。`, { actionId: action.id })
    await appendNewMediaAudit(await createNewMediaAuditEntry({
      domain: 'governance', event: 'automation_triggered', actor: 'system:automation', subjectId: rule.id,
      detail: '按排程生成了待审批外发动作；是否执行由人工决定。',
      metadata: { actionId: action.id, occurrenceAt, platform: rule.platform },
    }))
    return run
  } catch (error) {
    const run = await makeRun('failed', `生成审批动作失败：${error instanceof Error ? error.message : String(error)}`, {
      errorCode: 'automation_run_failed',
    })
    await applyFailure(rule, run)
    return run
  }
}

/** 失败策略：累计连续失败；达到阈值自动停用，避免风暴。 */
async function applyFailure(rule: NewMediaAutomationRule, run: NewMediaAutomationRun): Promise<void> {
  const consecutive = rule.consecutiveFailures + 1
  const next: NewMediaAutomationRule = { ...rule, consecutiveFailures: consecutive, lastRunAt: run.ranAt, updatedAt: Date.now() }
  if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
    next.enabled = false
    next.autoDisabledAt = Date.now()
    next.autoDisabledReason = `连续 ${consecutive} 次触发失败，已自动停用；请排查后重新启用`
    await putNewMediaRecords([
      { kind: RULE_KIND, value: next },
      { kind: 'new-media-audit', value: await createNewMediaAuditEntry({
        domain: 'governance', event: 'automation_disabled', actor: 'system:automation', subjectId: rule.id,
        detail: next.autoDisabledReason as string,
        metadata: { platform: rule.platform, consecutiveFailures: consecutive },
      }) },
    ])
    return
  }
  await appendNewMediaAudit(await createNewMediaAuditEntry({
    domain: 'governance', event: 'automation_failed', actor: 'system:automation', subjectId: rule.id,
    detail: run.detail, metadata: { consecutiveFailures: consecutive, occurrenceAt: run.occurrenceAt },
  }))
  await putNewMediaRecord(RULE_KIND, next)
}

export interface AutomationTickResult {
  triggered: number
  created: number
  failed: number
  skipped: number
}

/**
 * 处理所有到期的规则。
 *
 * 每条规则每次 tick 最多处理一个触发时刻：应用离线多天也只补跑最近一次，
 * 其余时刻直接跳过（不做逐次追赶，防补发风暴）。
 */
export async function tickNewMediaAutomations(now = Date.now()): Promise<AutomationTickResult> {
  const result: AutomationTickResult = { triggered: 0, created: 0, failed: 0, skipped: 0 }
  const rules = (await listAutomationRules()).filter((rule) => rule.enabled && rule.nextRunAt <= now)
  for (const rule of rules) {
    result.triggered += 1
    const occurrenceAt = rule.nextRunAt
    const run = await runOccurrence(rule, occurrenceAt, now)
    if (run.outcome === 'created') result.created += 1
    else if (run.outcome === 'failed') result.failed += 1
    else result.skipped += 1

    // 触发时刻远早于当前时间（离线补跑）时，下次从当前时间起算，不逐次追赶。
    const nextBase = Math.max(now, occurrenceAt)
    const current = await loadRule(rule.id)
    if (current.enabled) {
      await putNewMediaRecord(RULE_KIND, { ...current, nextRunAt: computeNextRunAt(current.cadence, nextBase), lastRunAt: now, updatedAt: now })
    }
  }
  return result
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null

/** 启动本地调度循环（应用启动时调用；测试不调用）。 */
export function startNewMediaAutomationScheduler(intervalMs = 60_000): void {
  if (schedulerTimer) return
  schedulerTimer = setInterval(() => {
    void tickNewMediaAutomations().catch((error) => {
      console.error('[新媒体] 自动化调度失败', error)
    })
  }, intervalMs)
}

export function stopNewMediaAutomationScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer)
  schedulerTimer = null
}
