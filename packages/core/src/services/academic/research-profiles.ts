/**
 * 领域方法 profile（G1，方案 §5）
 *
 * 七领域 × 四方法路径的配置化定义：研究设计需要哪些字段、
 * 有哪些强制检查项、默认方法路径是什么。纯数据 + 纯函数，
 * 不含 IO；UI 与协议服务都从这里取，避免规则散落。
 *
 * 设计原则（对应方案 §5 与 §11）：
 * - 不同学科不共用一套检查清单（听力学要单位/校准，本体的要能力问题）
 * - 质性研究不强制假设与随机种子（§4.1）
 * - 检查项是「提醒与必填约束」，不是对研究质量的自动判定
 */

import type { ResearchDomain, ResearchMethodPath } from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'

/** 协议字段类型 */
export type ProfileFieldType = 'text' | 'longtext' | 'number' | 'list' | 'select'

export interface ProfileField {
  key: string
  label: string
  type: ProfileFieldType
  required: boolean
  /** 缺省时的提示（不是默认值填充，避免推断补造） */
  hint?: string
  options?: string[]
}

/** 领域检查项：用于提交协议时的提醒，不做质量评分 */
export interface ProfileCheck {
  id: string
  description: string
  /** 仅当方法路径命中时启用 */
  appliesTo?: ResearchMethodPath[]
}

export interface DomainProfile {
  domain: ResearchDomain
  label: string
  /** 该领域默认方法路径（用户可改） */
  defaultMethodPath: ResearchMethodPath
  /** 该领域允许的方法路径 */
  allowedMethodPaths: ResearchMethodPath[]
  /** 协议必填/可选字段 */
  protocolFields: ProfileField[]
  /** 领域检查项 */
  checks: ProfileCheck[]
  /** 该领域常用数据源（仅提示，不代表已接入） */
  suggestedDatabases: string[]
}

const QUANT_STATS_FIELDS: ProfileField[] = [
  { key: 'estimand', label: '估计目标', type: 'longtext', required: true, hint: '明确要估计什么量（效应、均值、风险比等）' },
  { key: 'samplingUnit', label: '独立采样单位', type: 'text', required: true, hint: '如「受试者」；重复测量/双耳/双眼不能当作独立单位' },
  { key: 'sampleSizeRationale', label: '样本量依据', type: 'longtext', required: true, hint: '功效分析或精度论证；不能只写「参考前人」' },
  { key: 'missingDataPlan', label: '缺失数据方案', type: 'longtext', required: false },
]

const QUALITATIVE_FIELDS: ProfileField[] = [
  { key: 'positionality', label: '研究者立场', type: 'longtext', required: true, hint: '研究者自身经验与预设如何影响资料收集与解释' },
  { key: 'materialSelection', label: '材料/参与者选择', type: 'longtext', required: true, hint: '招募或档案选择标准与理由' },
  { key: 'codingStrategy', label: '编码/分析方法', type: 'longtext', required: true, hint: '如主题分析、叙事分析、扎根理论；如适用' },
  { key: 'negativeCases', label: '反例处理', type: 'longtext', required: false },
]

const FORMAL_FIELDS: ProfileField[] = [
  { key: 'competencyQuestions', label: '能力问题', type: 'list', required: true, hint: '本体必须能回答的问题清单；无能力问题不称为可用本体' },
  { key: 'scopeTerms', label: '术语范围', type: 'longtext', required: true, hint: '收录术语的边界与命名空间/版本映射' },
  { key: 'validationPlan', label: '验证方案', type: 'longtext', required: true, hint: '语法、一致性、约束、专家语义审查分层说明' },
]

const MIXED_FIELDS: ProfileField[] = [
  { key: 'practiceGoal', label: '实践目标', type: 'longtext', required: true, hint: '部署/改进目标，与研究问题分开陈述' },
  { key: 'studyDesign', label: '研究设计', type: 'select', required: true, options: ['randomized', 'cluster-randomized', 'stepped-wedge', 'difference-in-differences', 'interrupted-time-series', 'case-study', 'mixed'] },
  { key: 'counterfactual', label: '对照/反事实安排', type: 'longtext', required: true, hint: '无对照的前后对比不得默认解释为因果' },
  { key: 'confounders', label: '同期变化与混杂', type: 'longtext', required: false },
]

export const DOMAIN_PROFILES: Record<ResearchDomain, DomainProfile> = {
  audiology: {
    domain: 'audiology',
    label: '听力学',
    defaultMethodPath: 'quantitative',
    allowedMethodPaths: ['quantitative', 'qualitative', 'mixed-practice'],
    protocolFields: [
      { key: 'population', label: '人群', type: 'longtext', required: true, hint: '听损类型与程度、年龄范围' },
      { key: 'intervention', label: '干预/设备', type: 'longtext', required: true },
      { key: 'comparator', label: '比较条件', type: 'longtext', required: true },
      { key: 'outcomes', label: '结局指标', type: 'list', required: true, hint: '语音识别、聆听负荷等；注明测量工具' },
      { key: 'acousticCalibration', label: '声学校准依据', type: 'longtext', required: true, hint: 'dB HL / dB SPL / dB SNR 的口径与校准记录；缺失将标记未核验' },
      { key: 'stimuliVersion', label: '刺激材料版本', type: 'text', required: false },
      ...QUANT_STATS_FIELDS,
    ],
    checks: [
      { id: 'ears-not-independent', description: '双耳/重复测量数据不得按独立个体建模（需说明随机效应或聚合方式）' },
      { id: 'unit-consistency', description: 'dB HL / dB SPL / dB SNR 不得混用未标注' },
      { id: 'calibration-evidence', description: '无校准依据时结论需标注「设备校准未核验」' },
      { id: 'ceiling-floor', description: '需说明天花板/地板效应与学习效应控制' },
    ],
    suggestedDatabases: ['pubmed', 'europepmc', 'openalex'],
  },

  'medical-humanities': {
    domain: 'medical-humanities',
    label: '医学人文',
    defaultMethodPath: 'qualitative',
    allowedMethodPaths: ['qualitative', 'mixed-practice', 'quantitative'],
    protocolFields: [
      ...QUALITATIVE_FIELDS,
      { key: 'ethicsBasis', label: '伦理依据', type: 'longtext', required: true, hint: '批件或豁免说明；系统不裁决其法律有效性' },
      { key: 'dataRetention', label: '材料保存与脱敏', type: 'longtext', required: true },
    ],
    checks: [
      { id: 'no-fabricated-quotes', description: '访谈引语必须来自真实材料片段，记录不得由模型生成' },
      { id: 'identity-separation', description: '身份映射与材料分离保存' },
      { id: 'positionality-stated', description: '需说明研究者立场对解释的影响' },
    ],
    suggestedDatabases: ['europepmc', 'pubmed', 'openalex'],
  },

  statistics: {
    domain: 'statistics',
    label: '统计学',
    defaultMethodPath: 'quantitative',
    allowedMethodPaths: ['quantitative', 'formal'],
    protocolFields: [
      ...QUANT_STATS_FIELDS,
      { key: 'dataGeneratingMechanism', label: '数据生成机制', type: 'longtext', required: true, hint: '模拟研究需明确 DGP 与参数网格' },
      { key: 'replicates', label: '重复次数（replicate）', type: 'number', required: true, hint: '需报告 Monte Carlo 误差，不能以 3 次 seed 声称稳定' },
      { key: 'failureDefinition', label: '失败定义', type: 'longtext', required: false },
    ],
    checks: [
      { id: 'mc-error', description: '需报告 Monte Carlo 标准误或区间' },
      { id: 'seed-not-stability', description: '少量 seed 重复不得作为方法稳定性证据' },
      { id: 'prespecify-primary', description: '主要指标需预先指定，测试集反复调参需披露' },
    ],
    suggestedDatabases: ['arxiv', 'openalex'],
  },

  ai: {
    domain: 'ai',
    label: '人工智能',
    defaultMethodPath: 'quantitative',
    allowedMethodPaths: ['quantitative', 'formal'],
    protocolFields: [
      ...QUANT_STATS_FIELDS,
      { key: 'dataSplit', label: '数据划分', type: 'longtext', required: true, hint: '含污染检查（训练/评测重叠）' },
      { key: 'baselines', label: '基线方法', type: 'list', required: true },
      { key: 'computeBudget', label: '算力与费用预算', type: 'text', required: true },
      { key: 'externalDependency', label: '外部模型/服务依赖', type: 'longtext', required: false, hint: '不可固定的外部 API 需标注复现等级受限' },
    ],
    checks: [
      { id: 'contamination-check', description: '需检查训练/评测数据污染' },
      { id: 'budget-stop', description: '需设定预算到限停止条件' },
      { id: 'negative-runs-visible', description: '负面/失败运行需保留可见' },
    ],
    suggestedDatabases: ['arxiv', 'openalex'],
  },

  ontology: {
    domain: 'ontology',
    label: '本体',
    defaultMethodPath: 'formal',
    allowedMethodPaths: ['formal', 'qualitative'],
    protocolFields: [
      ...FORMAL_FIELDS,
      { key: 'format', label: '目标格式', type: 'select', required: true, options: ['RDF/OWL', 'SHACL', 'SPARQL', '其他（说明）'] },
      { key: 'reuseSources', label: '复用来源与许可', type: 'longtext', required: false, hint: '如 OLS 等术语来源；记录许可' },
    ],
    checks: [
      { id: 'competency-first', description: '能力问题须先于术语建模确定' },
      { id: 'layered-validation', description: '语法/一致性/约束/专家审查分层报告，不得互相替代' },
      { id: 'version-mapping', description: '术语修订需触发映射复审' },
    ],
    suggestedDatabases: ['openalex'],
  },

  'enterprise-ai': {
    domain: 'enterprise-ai',
    label: '企业 AI 改造',
    defaultMethodPath: 'mixed-practice',
    allowedMethodPaths: ['mixed-practice', 'qualitative', 'quantitative'],
    protocolFields: [
      ...MIXED_FIELDS,
      { key: 'baselineMetrics', label: '基线指标与口径', type: 'longtext', required: true },
      { key: 'implementationFidelity', label: '实施忠实度', type: 'longtext', required: false, hint: '实际使用率、培训覆盖等' },
      { key: 'employeePrivacy', label: '员工数据与隐私安排', type: 'longtext', required: true },
    ],
    checks: [
      { id: 'no-causal-without-comparison', description: '无对照的前后对比不得表述为因果' },
      { id: 'roi-traceable', description: 'ROI 假设与成本口径需可追溯' },
      { id: 'sensitive-channel-check', description: '员工敏感数据不得送未批准渠道' },
    ],
    suggestedDatabases: ['openalex', 'arxiv'],
  },

  'data-science': {
    domain: 'data-science',
    label: '数据分析与数据科学',
    defaultMethodPath: 'quantitative',
    allowedMethodPaths: ['quantitative', 'mixed-practice'],
    protocolFields: [
      { key: 'dataDictionary', label: '数据字典', type: 'longtext', required: true, hint: '来源、单位、缺失、异常、转换历史' },
      { key: 'validationStrategy', label: '切分与验证策略', type: 'longtext', required: true, hint: '时间序列需说明如何避免未来信息泄露' },
      { key: 'claimType', label: '结论类型', type: 'select', required: true, options: ['descriptive', 'predictive', 'causal'] },
      { key: 'baselineModel', label: '基线模型', type: 'text', required: false },
    ],
    checks: [
      { id: 'leakage-check', description: '需检查未来信息泄露与目标泄漏' },
      { id: 'importance-not-causal', description: '预测重要性不得表述为因果贡献' },
      { id: 'reproducible-pipeline', description: '重跑需在指定容差内一致' },
    ],
    suggestedDatabases: ['openalex', 'arxiv'],
  },
}

/** 取领域 profile */
export function getDomainProfile(domain: ResearchDomain): DomainProfile {
  const profile = DOMAIN_PROFILES[domain]
  if (!profile) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `未知研究领域: ${domain}`)
  }
  return profile
}

/** 校验方法路径与领域是否匹配 */
export function assertMethodPathAllowed(
  domain: ResearchDomain,
  methodPath: ResearchMethodPath,
): void {
  const profile = getDomainProfile(domain)
  if (!profile.allowedMethodPaths.includes(methodPath)) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `领域「${profile.label}」不支持方法路径「${methodPath}」；可选：${profile.allowedMethodPaths.join(', ')}`,
    )
  }
}

/** 该领域在该方法路径下启用的检查项 */
export function checksFor(
  domain: ResearchDomain,
  methodPath: ResearchMethodPath,
): ProfileCheck[] {
  const profile = getDomainProfile(domain)
  return profile.checks.filter((c) => !c.appliesTo || c.appliesTo.includes(methodPath))
}

/** 该领域的必填协议字段 */
export function requiredFieldsFor(domain: ResearchDomain): ProfileField[] {
  return getDomainProfile(domain).protocolFields.filter((f) => f.required)
}

/** 全部领域 profile 列表（UI 展示顺序） */
export function listDomainProfiles(): DomainProfile[] {
  return Object.values(DOMAIN_PROFILES)
}
