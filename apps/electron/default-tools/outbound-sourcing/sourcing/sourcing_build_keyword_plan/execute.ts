interface Input { product?: string; markets?: string[]; buyer_types?: string[]; applications?: string[]; language?: string }
export async function execute(input: unknown): Promise<{ content: string; isError?: boolean }> {
  const value = (input ?? {}) as Input
  const product = String(value.product ?? '').trim()
  const markets = Array.isArray(value.markets) ? value.markets.map(String).map((item) => item.trim()).filter(Boolean) : []
  if (!product || markets.length === 0) return { content: '参数缺失：product 与 markets 至少各填写一项', isError: true }
  const types = (value.buyer_types?.length ? value.buyer_types : ['distributor', 'ingredient buyer', 'OEM manufacturer', 'brand'])
  const applications = value.applications?.length ? value.applications : ['functional food', 'beverage', 'nutrition', 'ingredient supply']
  const language = String(value.language ?? 'en').trim() || 'en'
  const queries = markets.flatMap((market) => types.flatMap((type) => applications.map((application) => `${product} ${type} ${application} ${market}`)))
  return { content: JSON.stringify({ product, markets, buyerTypes: types, applications, language, queries, verificationChecklist: ['公司官网或可信目录', '总部/运营国家', '业务是否匹配', '联系人职位与邮箱来源', '国家与产品合规约束'] }, null, 2) }
}
