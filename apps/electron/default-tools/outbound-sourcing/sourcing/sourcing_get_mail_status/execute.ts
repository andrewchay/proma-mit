/**
 * sourcing_get_mail_status — 查询邮件往来状态（只读）
 *
 * 供 Agent 判断"这家公司发过没有/发出去没有/回没回"，避免重复外联。
 */
import { getMailStatus } from '../../../../src/main/lib/outbound-mail/mail-send-service'

interface Input {
  company_email?: string
  thread_mail_id?: string
}

export async function execute(input: unknown): Promise<{ content: string; isError?: boolean }> {
  const v = (input ?? {}) as Input
  if (!v.company_email?.trim() && !v.thread_mail_id?.trim()) {
    return { content: '参数缺失：company_email 与 thread_mail_id 至少填写一项', isError: true }
  }
  const items = getMailStatus({
    companyEmail: v.company_email?.trim() || undefined,
    threadMailId: v.thread_mail_id?.trim() || undefined,
  })
  return {
    content: JSON.stringify({
      count: items.length,
      note: items.length === 0 ? '该联系人暂无邮件往来记录；发送过的邮件状态为 sent' : undefined,
      items,
    }, null, 2),
  }
}
