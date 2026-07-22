import type { AuditRecord } from './audit.ts'

export interface OperationalTraceEvent {
  traceId: string
  requestId: string
  event: string
  tenantId?: string
  userId?: string
  taskId?: string
  status?: number
  durationMs?: number
  error?: string
  createdAt: number
}

export interface OperationalAlert {
  severity: 'warning' | 'critical'
  kind: 'agent_task_failed'
  traceId?: string
  tenantId: string
  userId: string
  taskId?: string
  message: string
  createdAt: number
}

export interface OperationsReporter {
  reportTrace(event: OperationalTraceEvent): Promise<void>
  reportAudit(record: AuditRecord): Promise<void>
  reportAlert(alert: OperationalAlert): Promise<void>
}

/** 出站内容仅包含已脱敏的运维元数据；失败不得影响 Agent 主流程。 */
export class HttpOperationsReporter implements OperationsReporter {
  constructor(private readonly options: { siemWebhookUrl?: string; alertWebhookUrl?: string; fetchImpl?: (url: string, init: RequestInit) => Promise<Response> }) {}

  async reportTrace(event: OperationalTraceEvent): Promise<void> {
    if (!this.options.siemWebhookUrl) return
    await this.post(this.options.siemWebhookUrl, { type: 'trace', event })
  }

  async reportAudit(record: AuditRecord): Promise<void> {
    if (!this.options.siemWebhookUrl) return
    await this.post(this.options.siemWebhookUrl, { type: 'audit', record })
  }

  async reportAlert(alert: OperationalAlert): Promise<void> {
    if (!this.options.alertWebhookUrl) return
    await this.post(this.options.alertWebhookUrl, { type: 'alert', alert })
  }

  private async post(url: string, body: unknown): Promise<void> {
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`运维 webhook 返回 ${response.status}`)
  }
}

export class NoopOperationsReporter implements OperationsReporter {
  async reportTrace(_event: OperationalTraceEvent): Promise<void> {}
  async reportAudit(_record: AuditRecord): Promise<void> {}
  async reportAlert(_alert: OperationalAlert): Promise<void> {}
}

export function redactOperationalError(error: string): string {
  return error
    .replaceAll(/authorization\s*:\s*bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [redacted]')
    .replaceAll(/(api[_-]?key|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 1_000)
}
