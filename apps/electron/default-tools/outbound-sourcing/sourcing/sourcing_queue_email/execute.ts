/**
 * sourcing_queue_email — 入队待发邮件（审批制）
 *
 * Agent 生成邮件的唯一出口：只入队（draft），不发送。
 * 用户在领域工作台"待发队列"中逐封确认后才经 SMTP 发出。
 */
import { queueEmail } from '../../../../src/main/lib/outbound-mail/mail-send-service'

interface Input {
  to?: string
  subject?: string
  body?: string
  in_reply_to?: string
  references?: string[]
  reply_to_inbox_id?: string
}

export async function execute(input: unknown): Promise<{ content: string; isError?: boolean }> {
  const v = (input ?? {}) as Input
  try {
    const item = queueEmail({
      to: v.to ?? '',
      subject: v.subject ?? '',
      body: v.body ?? '',
      inReplyTo: v.in_reply_to ?? null,
      references: v.references,
      source: 'agent',
      replyToInboxId: v.reply_to_inbox_id ?? null,
    })
    return {
      content: JSON.stringify({
        id: item.id,
        status: item.status,
        to: item.to,
        subject: item.subject,
        safety: [
          '该邮件已进入待发队列，等待用户在"待发队列"中逐封确认后才会发出',
          '本工具不直接发送邮件；用户可编辑或驳回队列中的任何邮件',
        ],
      }, null, 2),
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true }
  }
}
