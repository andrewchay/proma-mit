interface Input { company?: string; country?: string; verified_country?: string; customer_type?: string; vertical_match?: string; has_website?: boolean; has_verified_email?: boolean; status?: string }
export async function execute(input: unknown): Promise<{ content: string; isError?: boolean }> {
  const v = (input ?? {}) as Input
  const company = String(v.company ?? '').trim()
  if (!company) return { content: '参数缺失：company', isError: true }
  let score = 50
  const reasons: string[] = []
  if (v.has_website) { score += 10; reasons.push('有网站证据') } else { score -= 15; reasons.push('缺少网站证据') }
  if (v.has_verified_email) { score += 15; reasons.push('有已核验邮箱') } else { score -= 12; reasons.push('邮箱未核验') }
  if (v.country && v.verified_country && v.country.toLowerCase() !== v.verified_country.toLowerCase()) { score -= 20; reasons.push('目标国家与核验国家不一致') }
  if (v.vertical_match === 'core') { score += 15; reasons.push('核心品类匹配') } else if (v.vertical_match === 'partial') { score += 5; reasons.push('部分品类匹配') } else if (v.vertical_match === 'none') { score -= 25; reasons.push('品类不匹配') }
  if (/brand|oem|manufacturer|direct buyer|品牌|工厂/i.test(String(v.customer_type ?? ''))) { score += 8; reasons.push('买家类型接近直接采购') }
  if (/已收到有效回复|已询价|replied|quoted/i.test(String(v.status ?? ''))) { score += 12; reasons.push('已有正向互动') }
  const priority = score >= 75 ? 'P1' : score >= 55 ? 'P2' : 'P3'
  return { content: JSON.stringify({ company, score: Math.max(0, Math.min(100, score)), priority, reasons, nextAction: priority === 'P1' ? '补齐联系人证据并准备个性化外联' : priority === 'P2' ? '先核验网站、国家与联系人' : '暂缓外联，补充证据或排除不匹配原因' }, null, 2) }
}
