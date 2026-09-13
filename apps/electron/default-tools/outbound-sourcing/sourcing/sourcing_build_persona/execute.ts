/**
 * sourcing_build_persona — 决策人画像合成（模板 + 证据约束）
 *
 * 对齐 Redvia 的 profile_enrich.py 的画像环节：输出结构化画像草稿，
 * 由 Agent 结合证据填写，最终喂给 sourcing_draft_outreach 的
 * decision_maker_role / pain_points 字段。
 *
 * 边界：未提供证据的推断必须标记为"待核实"，不得写成事实。
 */
interface Input {
  company?: string
  contact_name?: string
  contact_role?: string
  product?: string
  country?: string
  evidence?: string[]
}

/** 常见买家角色 → 采购关注点与痛点假设（作为待验证假设，不作为结论） */
const ROLE_PROFILES: Array<{ match: RegExp; role: string; concerns: string[]; painHypotheses: string[] }> = [
  {
    match: /procure|purchas|buyer|sourcing|supply/i,
    role: '采购/供应链负责人',
    concerns: ['到岸成本与价格稳定性', '交期与产能保障', '认证与合规文件', '供应商可靠性'],
    painHypotheses: ['多供应商管理成本', '断供或缺货风险', '质量批次波动', '进口合规文件不全'],
  },
  {
    match: /product|r&d|innovation|technolog/i,
    role: '产品/研发负责人',
    concerns: ['原料规格与稳定性', '配方适配性', '新品类开发周期', '差异化卖点'],
    painHypotheses: ['原料规格不一致导致打样反复', '缺少有机/认证原料', '新品上市窗口压力'],
  },
  {
    match: /market|brand|commercial|sales|growth/i,
    role: '市场/商务负责人',
    concerns: ['差异化定位与故事', '终端动销与复购', '消费者教育与合规宣称', '渠道配合'],
    painHypotheses: ['同质化严重难以溢价', '功能宣称受监管限制', '渠道对供应商背书要求高'],
  },
  {
    match: /quality|qa|regulat|compliance/i,
    role: '质量/合规负责人',
    concerns: ['检测报告与残留限值', '认证有效性', '追溯体系', '目标市场法规'],
    painHypotheses: ['跨境农残/重金属限值差异', '证书真伪与更新频率', '审核供应商耗时'],
  },
]

export async function execute(input: unknown): Promise<{ content: string; isError?: boolean }> {
  const v = (input ?? {}) as Input
  const company = String(v.company ?? '').trim()
  const product = String(v.product ?? '').trim()
  if (!company || !product) return { content: '参数缺失：company、product', isError: true }

  const role = String(v.contact_role ?? '').trim()
  const evidence = (Array.isArray(v.evidence) ? v.evidence : []).map(String).filter(Boolean)

  const matched = ROLE_PROFILES.find((p) => role && p.match.test(role))
  const profile = matched ?? {
    role: role || '（待确认：未提供联系人职位）',
    concerns: ['价格与成本结构', '质量与规格一致性', '供应稳定性', '合规与认证'],
    painHypotheses: ['供应商切换成本', '交付不确定', '合规材料准备耗时'],
  }

  return {
    content: JSON.stringify({
      company,
      contactName: v.contact_name?.trim() || null,
      contactRole: role || null,
      country: v.country?.trim() || null,
      product,
      persona: {
        role: profile.role,
        purchaseConcerns: profile.concerns,
        painPointHypotheses: profile.painHypotheses,
        /** 建议的切入角度：从痛点假设 + 品类价值主张组合 */
        suggestedAngles: profile.painHypotheses.slice(0, 3).map((pain) => `以「${product} 如何降低 ${pain}」作为切入角度`),
      },
      evidenceUsed: evidence,
      openQuestions: [
        '该联系人是否真的有采购决策权？（未核验则标记待核实）',
        '其当前供应商结构与切换周期？',
        '目标市场对本品类的具体合规要求？',
      ],
      handoff: {
        nextTool: 'sourcing_draft_outreach',
        fields: {
          decision_maker_role: profile.role,
          pain_points: profile.painHypotheses,
        },
      },
      caveat: '以上为基于职位与品类的画像假设；未由证据支持的部分必须在对外内容中避免当作事实陈述。',
    }, null, 2),
  }
}
