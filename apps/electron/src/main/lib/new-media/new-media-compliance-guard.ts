/**
 * 新媒体合规守卫（nm-compliance-guard）。
 *
 * 定位（对应 P4-08 的 DoD）：
 * - 只做「提示 + 升级人工」，绝不自动判定内容合法或不合法；
 * - 高风险发现（广告法绝对化用语、平台禁则、危机信号）输出修改建议并要求人工复核，
 *   是否外发仍由审批流程决定，本模块不做阻断；
 * - 版权维度与 P4-09 的素材 provenance 门控互补：provenance 管素材授权（阻断），
 *   本模块管文字内容中的版权风险提示（建议）。
 *
 * 内置规则是「常见风险信号」而不是法律标准；规则库需要产品与法务持续维护，
 * 每条规则的 message 都声明了这一点，避免使用者误以为通过了检查就合规。
 */
import { randomUUID } from 'node:crypto'
import type {
  NewMediaComplianceFinding,
  NewMediaComplianceReview,
  NewMediaComplianceRule,
  NewMediaPlatform,
} from '@gravitas/shared'
import { appendNewMediaAudit, createNewMediaAuditEntry } from './new-media-audit'

export const COMPLIANCE_DISCLAIMER =
  '本检查只识别常见风险信号并给出修改建议，不构成法律意见，也不能替代平台审核；内容是否合规以人工核验与平台判定为准。'

/** 内置规则库：id 稳定，便于后续按规则统计与维护。 */
export const BUILT_IN_COMPLIANCE_RULES: readonly NewMediaComplianceRule[] = [
  // ===== 广告法：绝对化与疗效承诺 =====
  {
    id: 'adlaw-superlative',
    category: 'advertising-law',
    severity: 'high-risk',
    pattern: '最好|最佳|最优|第一|顶级|国家级|世界级|全网最低|史上最|绝无仅有',
    label: '广告法绝对化用语',
    message: '使用了《广告法》明确禁止的绝对化用语。',
    suggestion: '改为可验证的客观描述（例如「实测数据」「第三方报告」），或删除该表述。',
  },
  {
    id: 'adlaw-efficacy',
    category: 'advertising-law',
    severity: 'high-risk',
    pattern: '根治|治愈|立竿见影|百分百有效|100%有效|无副作用|包治|速效',
    label: '功效与医疗承诺',
    message: '出现疗效或功效承诺类表述，普通商品不得使用。',
    suggestion: '删除功效承诺；如为特殊品类，需按平台要求提供资质并在人工复核后处理。',
  },
  {
    id: 'adlaw-price',
    category: 'advertising-law',
    severity: 'suggest',
    pattern: '降价|清仓|跳楼价|亏本甩卖',
    label: '价格诱导表述',
    message: '价格类表述可能构成虚假优惠。',
    suggestion: '标注真实的价格依据与活动期限，避免使用无法证实的夸张表述。',
  },
  // ===== 平台规则 =====
  {
    id: 'platform-offsite',
    category: 'platform-rule',
    severity: 'high-risk',
    pattern: '加微信|加V|加v|私聊购买|扫码下单|加QQ|VX号|威信',
    label: '站外导流',
    message: '出现站外导流表述，平台通常限流或处罚。',
    suggestion: '移除站外联系方式；交易引导改用平台内允许的方式。',
  },
  {
    id: 'platform-counterfeit',
    category: 'platform-rule',
    severity: 'high-risk',
    pattern: '仿品|A货|高仿|原单|尾单正品|代购小票',
    label: '疑似侵权或仿冒',
    message: '出现疑似仿冒品表述，平台会直接处罚。',
    suggestion: '删除相关表述；商品需为正品并可提供凭证。',
  },
  {
    id: 'platform-medical-claim',
    category: 'platform-rule',
    severity: 'suggest',
    pattern: '美白|祛斑|抗衰|生发|减肥|瘦身',
    label: '特殊品类宣称',
    message: '特殊品类宣称在部分平台需要资质。',
    suggestion: '确认平台对该宣称的资质要求；无资质时改用体验类描述。',
  },
  // ===== 版权 =====
  {
    id: 'copyright-source',
    category: 'copyright',
    severity: 'suggest',
    pattern: '网图|图源网络|侵删|素材来自网络',
    label: '来源不明素材',
    message: '使用了来源不明的素材表述。',
    suggestion: '改用自有素材或在素材 provenance 中登记已获授权的来源（P4-09）；「侵删」不能替代授权。',
  },
  {
    id: 'copyright-brand',
    category: 'copyright',
    severity: 'suggest',
    pattern: '同款|平替|对标大牌',
    label: '攀附他人品牌',
    message: '出现攀附他人品牌的表述，可能构成不正当竞争。',
    suggestion: '删除攀附表述，聚焦自有产品的独立卖点。',
  },
  // ===== 危机升级 =====
  {
    id: 'crisis-complaint',
    category: 'crisis',
    severity: 'high-risk',
    pattern: '投诉|维权|曝光你|315|骗子|退款赔偿|工商投诉',
    label: '危机信号',
    message: '内容涉及客诉升级或危机信号，必须人工介入。',
    suggestion: '不要公开回复对抗性内容；转交人工按客诉流程处理，并保留沟通记录。',
  },
]

export interface ScanNewMediaContentInput {
  platform: NewMediaPlatform
  title?: string
  content: string
  /** 关联的审批动作或草稿 id，用于审计追溯。 */
  subjectId?: string
}

function compileRules(): Array<{ rule: NewMediaComplianceRule; regex: RegExp }> {
  return BUILT_IN_COMPLIANCE_RULES.map((rule) => ({
    rule,
    regex: new RegExp(rule.pattern, 'gi'),
  })).filter((entry) => {
    try {
      // 预验证正则可编译（规则库维护时防呆）。
      new RegExp(entry.rule.pattern, 'gi')
      return true
    } catch {
      return false
    }
  })
}

const COMPILED_RULES = compileRules()

/** 扫描文本，返回全部命中；不阻断、不判定，只提示。 */
export function scanNewMediaContent(input: ScanNewMediaContentInput): NewMediaComplianceReview {
  const text = `${input.title ?? ''}\n${input.content}`
  const findings: NewMediaComplianceFinding[] = []
  const seen = new Set<string>()
  for (const { rule, regex } of COMPILED_RULES) {
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      const matchedText = match[0]
      // 同一规则同一命中文本只报一次，避免长文重复刷屏。
      const dedupeKey = `${rule.id}:${matchedText}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      findings.push({
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        label: rule.label,
        matchedText,
        message: rule.message,
        suggestion: rule.suggestion,
      })
      if (match.index === regex.lastIndex) regex.lastIndex += 1
    }
  }
  findings.sort((left, right) => (left.severity === right.severity ? left.ruleId.localeCompare(right.ruleId) : left.severity === 'high-risk' ? -1 : 1))
  return {
    platform: input.platform,
    findings,
    requiresHumanReview: findings.some((finding) => finding.severity === 'high-risk'),
    reviewedAt: Date.now(),
    disclaimer: COMPLIANCE_DISCLAIMER,
  }
}

export interface EscalateComplianceReviewInput extends ScanNewMediaContentInput {
  accountId: string
  /** 发起升级的执行者（审批人或系统组件）。 */
  actor: string
  review: NewMediaComplianceReview
}

/** 升级人工：把审查结果写入审计（含命中词与建议，不含凭据），供审批人复核。 */
export async function escalateComplianceReview(input: EscalateComplianceReviewInput): Promise<void> {
  const highRisk = input.review.findings.filter((finding) => finding.severity === 'high-risk')
  await appendNewMediaAudit(await createNewMediaAuditEntry({
    domain: 'compliance',
    event: input.review.requiresHumanReview ? 'escalated' : 'review_completed',
    actor: input.actor.trim() || 'local-user',
    subjectId: input.subjectId?.trim() || randomUUID(),
    detail: input.review.requiresHumanReview
      ? `合规检查发现 ${input.review.findings.length} 项风险（高危 ${highRisk.length} 项），已升级人工复核：${highRisk.map((finding) => `${finding.label}「${finding.matchedText}」`).join('；') || '无'}`
      : `合规检查完成，发现 ${input.review.findings.length} 项建议级提示，无需升级。`,
    metadata: {
      platform: input.review.platform,
      findingCount: input.review.findings.length,
      highRiskCount: highRisk.length,
      requiresHumanReview: input.review.requiresHumanReview,
      ruleIds: input.review.findings.map((finding) => finding.ruleId).join(','),
    },
  }))
}

/** 便捷封装：扫描并按结果决定是否升级（审查本身不做任何阻断）。 */
export async function reviewAndEscalateNewMediaContent(input: ScanNewMediaContentInput & { accountId: string; actor: string }): Promise<NewMediaComplianceReview> {
  const review = scanNewMediaContent(input)
  await escalateComplianceReview({ ...input, review })
  return review
}
