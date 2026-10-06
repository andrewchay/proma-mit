/**
 * sourcing_outreach_metrics — 本地外联漏斗指标（只读）
 *
 * 覆盖 Redvia 追踪诉求中本地可确证的部分：外联 → 回信 → 回复率 → 首回时延。
 * 不含邮件打开/链接点击（需要公网跟踪端点，本地应用不提供）。
 */
import { computeOutreachMetrics } from '../../../../src/main/lib/outbound-mail/outreach-metrics-service'

interface Input {
  top?: number
}

function formatLatency(ms: number | null): string | null {
  if (ms === null) return null
  const hours = ms / 3_600_000
  return hours >= 24 ? `${(hours / 24).toFixed(1)} 天` : `${hours.toFixed(1)} 小时`
}

export async function execute(input: unknown): Promise<{ content: string; isError?: boolean }> {
  const v = (input ?? {}) as Input
  const top = Math.min(Math.max(Math.floor(v.top ?? 10), 1), 50)
  const metrics = computeOutreachMetrics()

  return {
    content: JSON.stringify({
      summary: {
        sent: metrics.sent,
        pending: metrics.pending,
        failed: metrics.failed,
        contactedCompanies: metrics.contactedCompanies,
        repliedCompanies: metrics.repliedCompanies,
        replies: metrics.replies,
        replyRate: `${(metrics.replyRate * 100).toFixed(0)}%`,
        averageFirstReplyLatency: formatLatency(metrics.averageFirstReplyLatencyMs),
      },
      companies: metrics.companies.slice(0, top).map((c) => ({
        email: c.email,
        sent: c.sent,
        replies: c.replies,
        pending: c.pending,
        firstSentAt: c.firstSentAt ? new Date(c.firstSentAt).toISOString() : null,
        firstReplyAt: c.firstReplyAt ? new Date(c.firstReplyAt).toISOString() : null,
        firstReplyLatency: formatLatency(c.firstReplyLatencyMs),
      })),
      note: '指标基于本地待发队列与已同步来信；打开/链接点击不在本地统计范围内。',
    }, null, 2),
  }
}
