import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@gravitas/shared/utils'

export type ServerScheduleSpec =
  | { type: 'interval'; intervalMs: number }
  | { type: 'cron'; expression: string; timezone: string }

export interface ServerSchedule extends AgentRuntimeScope {
  scheduleId: string
  sessionId: string
  prompt: string
  schedule: ServerScheduleSpec
  enabled: boolean
  nextRunAt: number
  lastRunAt?: number
}

export interface ServerScheduleRun extends AgentRuntimeScope {
  runId: string
  scheduleId: string
  sessionId: string
  prompt: string
  status: 'claimed' | 'running' | 'success' | 'failed'
  workerId: string
  startedAt: number
  endedAt?: number
  error?: string
}

/** 服务端 durable Scheduler 存储；claim 使用行锁，两个 worker 不会领取同一 schedule。 */
export class PostgresServerSchedulerStore {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_schedules (
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, schedule_id TEXT NOT NULL, session_id TEXT NOT NULL,
      prompt TEXT NOT NULL, interval_ms BIGINT NOT NULL, schedule_type TEXT NOT NULL DEFAULT 'interval', cron_expression TEXT, timezone TEXT,
      enabled BOOLEAN NOT NULL, next_run_at BIGINT NOT NULL,
      last_run_at BIGINT, PRIMARY KEY (tenant_id, user_id, schedule_id))`)
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_schedule_runs (
      tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, run_id TEXT NOT NULL, schedule_id TEXT NOT NULL,
      session_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, worker_id TEXT NOT NULL, started_at BIGINT NOT NULL,
      ended_at BIGINT, error TEXT, PRIMARY KEY (tenant_id, user_id, run_id))`)
    // 为已创建的开发/测试表补齐首版漏掉的列，保证升级无需删库。
    await this.client.query(`ALTER TABLE proma_runtime_schedule_runs ADD COLUMN IF NOT EXISTS prompt TEXT NOT NULL DEFAULT ''`)
    await this.client.query(`ALTER TABLE proma_runtime_schedules ADD COLUMN IF NOT EXISTS schedule_type TEXT NOT NULL DEFAULT 'interval'`)
    await this.client.query(`ALTER TABLE proma_runtime_schedules ADD COLUMN IF NOT EXISTS cron_expression TEXT`)
    await this.client.query(`ALTER TABLE proma_runtime_schedules ADD COLUMN IF NOT EXISTS timezone TEXT`)
  }

  async create(input: Omit<ServerSchedule, 'scheduleId' | 'nextRunAt'> & { scheduleId?: string; nextRunAt?: number }): Promise<ServerSchedule> {
    const schedule: ServerSchedule = { ...input, scheduleId: input.scheduleId ?? randomUUID(), nextRunAt: input.nextRunAt ?? nextRunForSchedule(input.schedule) }
    await this.client.query(`INSERT INTO proma_runtime_schedules (tenant_id,user_id,schedule_id,session_id,prompt,interval_ms,schedule_type,cron_expression,timezone,enabled,next_run_at,last_run_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [schedule.tenantId, schedule.userId, schedule.scheduleId, schedule.sessionId, schedule.prompt, intervalMsOf(schedule.schedule), schedule.schedule.type, cronExpressionOf(schedule.schedule), timezoneOf(schedule.schedule), schedule.enabled, schedule.nextRunAt, schedule.lastRunAt ?? null])
    return schedule
  }

  async list(scope: AgentRuntimeScope): Promise<ServerSchedule[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT tenant_id,user_id,schedule_id,session_id,prompt,interval_ms,schedule_type,cron_expression,timezone,enabled,next_run_at,last_run_at
       FROM proma_runtime_schedules WHERE tenant_id=$1 AND user_id=$2 ORDER BY next_run_at ASC`,
      [scope.tenantId, scope.userId],
    )
    return result.rows.map(scheduleFromRow)
  }

  async setEnabled(scope: AgentRuntimeScope, scheduleId: string, enabled: boolean, now = Date.now()): Promise<ServerSchedule | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      `UPDATE proma_runtime_schedules
       SET enabled=$4
       WHERE tenant_id=$1 AND user_id=$2 AND schedule_id=$3
       RETURNING tenant_id,user_id,schedule_id,session_id,prompt,interval_ms,schedule_type,cron_expression,timezone,enabled,next_run_at,last_run_at`,
      [scope.tenantId, scope.userId, scheduleId, enabled],
    )
    const schedule = result.rows[0] ? scheduleFromRow(result.rows[0]) : undefined
    if (!schedule || !enabled) return schedule
    const resumed = await this.client.query<Record<string, unknown>>(`UPDATE proma_runtime_schedules SET next_run_at=$4 WHERE tenant_id=$1 AND user_id=$2 AND schedule_id=$3 RETURNING tenant_id,user_id,schedule_id,session_id,prompt,interval_ms,schedule_type,cron_expression,timezone,enabled,next_run_at,last_run_at`, [scope.tenantId, scope.userId, scheduleId, nextRunForSchedule(schedule.schedule, now)])
    return resumed.rows[0] ? scheduleFromRow(resumed.rows[0]) : undefined
  }

  async listDue(now = Date.now()): Promise<ServerSchedule[]> {
    const result = await this.client.query<Record<string, unknown>>(`SELECT tenant_id,user_id,schedule_id,session_id,prompt,interval_ms,schedule_type,cron_expression,timezone,enabled,next_run_at,last_run_at FROM proma_runtime_schedules WHERE enabled=TRUE AND next_run_at <= $1 ORDER BY next_run_at`, [now])
    return result.rows.map(scheduleFromRow)
  }

  async claimDue(schedule: ServerSchedule, workerId: string, nextRunAt: number, now = Date.now()): Promise<ServerScheduleRun | undefined> {
    const claimed = await this.client.query<Record<string, unknown>>(`WITH due AS (
      SELECT tenant_id,user_id,schedule_id,session_id FROM proma_runtime_schedules
      WHERE tenant_id=$1 AND user_id=$2 AND schedule_id=$3 AND enabled = TRUE AND next_run_at <= $4 FOR UPDATE SKIP LOCKED
    ), advanced AS (
      UPDATE proma_runtime_schedules s
      SET next_run_at = $5, last_run_at = $4
      FROM due WHERE s.tenant_id=due.tenant_id AND s.user_id=due.user_id AND s.schedule_id=due.schedule_id
      RETURNING s.tenant_id,s.user_id,s.schedule_id,s.session_id,s.prompt
    ) INSERT INTO proma_runtime_schedule_runs (tenant_id,user_id,run_id,schedule_id,session_id,prompt,status,worker_id,started_at)
      SELECT tenant_id,user_id,$6,schedule_id,session_id,prompt,'claimed',$7,$4 FROM advanced
      RETURNING *`, [schedule.tenantId, schedule.userId, schedule.scheduleId, now, nextRunAt, randomUUID(), workerId])
    return claimed.rows[0] ? runFromRow(claimed.rows[0]) : undefined
  }

  async finish(run: ServerScheduleRun, status: Extract<ServerScheduleRun['status'], 'success' | 'failed'>, error?: string): Promise<void> {
    await this.client.query(`UPDATE proma_runtime_schedule_runs SET status=$6,ended_at=$7,error=$8 WHERE tenant_id=$1 AND user_id=$2 AND run_id=$3 AND worker_id=$4 AND schedule_id=$5`, [run.tenantId, run.userId, run.runId, run.workerId, run.scheduleId, status, Date.now(), error ?? null])
  }
}

function runFromRow(row: Record<string, unknown>): ServerScheduleRun {
  return { tenantId: String(row.tenant_id), userId: String(row.user_id), runId: String(row.run_id), scheduleId: String(row.schedule_id), sessionId: String(row.session_id), prompt: String(row.prompt), status: row.status as ServerScheduleRun['status'], workerId: String(row.worker_id), startedAt: Number(row.started_at) }
}

function scheduleFromRow(row: Record<string, unknown>): ServerSchedule {
  const lastRunAt = row.last_run_at == null ? undefined : Number(row.last_run_at)
  return {
    tenantId: String(row.tenant_id), userId: String(row.user_id), scheduleId: String(row.schedule_id),
    sessionId: String(row.session_id), prompt: String(row.prompt), schedule: scheduleSpecFromRow(row),
    enabled: Boolean(row.enabled), nextRunAt: Number(row.next_run_at), ...(lastRunAt === undefined ? {} : { lastRunAt }),
  }
}

function scheduleSpecFromRow(row: Record<string, unknown>): ServerScheduleSpec {
  if (row.schedule_type === 'cron') return { type: 'cron', expression: String(row.cron_expression), timezone: String(row.timezone) }
  return { type: 'interval', intervalMs: Number(row.interval_ms) }
}

function intervalMsOf(schedule: ServerScheduleSpec): number { return schedule.type === 'interval' ? schedule.intervalMs : 0 }
function cronExpressionOf(schedule: ServerScheduleSpec): string | null { return schedule.type === 'cron' ? schedule.expression : null }
function timezoneOf(schedule: ServerScheduleSpec): string | null { return schedule.type === 'cron' ? schedule.timezone : null }

export function nextRunForSchedule(schedule: ServerScheduleSpec, now = Date.now()): number {
  if (schedule.type === 'interval') return now + schedule.intervalMs
  const next = new Cron(schedule.expression, { timezone: schedule.timezone, paused: true }).nextRun(new Date(now))
  if (!next) throw new Error('Cron 表达式没有未来执行时间')
  return next.getTime()
}
