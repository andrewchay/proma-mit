/**
 * sourcing_list_inbox — 查看已同步收件箱（只读）
 *
 * 默认返回摘要列表（无正文，防止上下文膨胀）；传 email_id 时返回单封完整正文，
 * 供回复起草使用。不修改邮箱状态。
 */
import { listInboxSummaries, getInboxItem } from '../../../../src/main/lib/outbound-mail/mail-sync-service'

interface Input {
  category?: 'outreach_reply' | 'new_inbound' | 'other'
  unhandled_only?: boolean
  limit?: number
  email_id?: string
}

export async function execute(input: unknown): Promise<{ content: string; isError?: boolean }> {
  const v = (input ?? {}) as Input

  // 单封读取模式：返回完整正文供回复起草
  if (v.email_id?.trim()) {
    const item = getInboxItem(v.email_id.trim())
    if (!item) return { content: `未找到来信: ${v.email_id}`, isError: true }
    return { content: JSON.stringify(item, null, 2) }
  }

  const items = listInboxSummaries({
    category: v.category,
    unhandledOnly: v.unhandled_only,
    limit: v.limit ?? 20,
  })
  return {
    content: JSON.stringify({
      total: items.length,
      hint: items.length > 0
        ? '回复来信时用 sourcing_queue_email 入队（发送需人工逐封确认）；需要正文时传 email_id。'
        : '收件箱为空；请先在领域工作台配置邮箱并同步。',
      items,
    }, null, 2),
  }
}
