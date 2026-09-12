interface Input { company?: string; country?: string; contact_name?: string; product?: string; angle?: string; language?: string }
export async function execute(input: unknown): Promise<{ content: string; isError?: boolean }> {
  const v = (input ?? {}) as Input
  const company = String(v.company ?? '').trim(); const product = String(v.product ?? '').trim(); const angle = String(v.angle ?? '').trim()
  if (!company || !product || !angle) return { content: '参数缺失：company、product、angle', isError: true }
  const greeting = v.contact_name ? `Hi ${v.contact_name},` : 'Hello,'
  const subject = `Exploring ${product} supply for ${company}`
  const body = [greeting, '', `I’m reaching out because ${company} may be a relevant partner for ${product}.`, `Our proposed angle is: ${angle}.`, '', 'Would you be open to a short exchange on your current sourcing needs, target specifications, and preferred next step?', '', 'Best regards,', 'Jack', 'Redvia / RedVia-BRY International Co.'].join('\n')
  return { content: JSON.stringify({ subject, body, language: v.language ?? 'en', country: v.country ?? '', safety: ['发送前由人工核验收件人、事实、价格与合规表述', '未明确表达推进意向前不附 Calendly', '该工具不发送邮件'] }, null, 2) }
}
