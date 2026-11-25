/**
 * 目标硬要求的逐项追溯（第 2 步）。
 *
 * 目标原文里的「一页」「45 分钟」「两人」这类硬要求，过去只存在于自由文本数组中，
 * 没有任何环节能确认它被计划承接、由哪一步负责、用什么方式验证。
 *
 * 本模块只做两件事：
 * 1. 把模型提出的追溯记录解析成受控结构，并核对其来源原文确实存在于目标中；
 * 2. 检查覆盖情况——哪些硬要求没有被任何步骤承接。
 *
 * 不判定验收结果，不授予执行权限，也不阻断旧计划读取。
 */

import type { ProjectOwnerCriterionTrace, ProjectOwnerGoalBrief, ProjectOwnerPlanStep } from '@gravitas/shared'

const MAX_TRACE_ITEMS = 64
const MAX_SOURCE_TEXT = 2000
const MAX_ASSUMPTIONS = 8
export const OWNER_REVIEW_CRITERION_MAX_LENGTH = 1000

const CRITICALITIES = ['critical', 'advisory'] as const
const VERIFICATIONS = ['automated', 'manual_review', 'user_decision', 'unverified'] as const
const PER_OUTPUT_WORDING = /各自|每份|\b(?:each|every)\b/i
const JOINT_OUTPUT_WORDING = /合计|加总|总和|总计|合并|汇总|另一份|其他(?:文本|成果|交付物)|跨(?:文本|成果|交付物)|相互|一致|比对|对比|\b(?:combined|sum|sum total|compared|consistent|match(?:es)?|other deliverables?)\b/i
const SOLE_TEXT_DELIVERY = /(?:^|[。！？；\n])\s*(?:只|仅)交付(?:通知|短信|邮件|文案|短讯)?正文\s*(?=$|[。！？；\n]|[，,]\s*(?:省去|不含|不附|不要附))/
const MULTIPLE_DELIVERIES = /[两二三四五六七八九多2-9]\s*(?:段|份|项|个)[^，。；！？\n]{0,12}(?:正文|文本|文案|通知|材料|成果|交付物)|(?:分别|同时|另需|额外)交付|另附|\b(?:two|multiple|several)\s+(?:texts|documents|deliverables)\b/i

export interface CriteriaCoverage {
  /** 来源中存在但没有任何步骤承接的硬要求。 */
  uncovered: ProjectOwnerCriterionTrace[]
  /** 被承接但验证方式仍为 unverified 的条目。 */
  unverified: ProjectOwnerCriterionTrace[]
  /** 关键项中未被覆盖的数量；>0 时不得标记可交付。 */
  criticalUncovered: number
}

function record(input: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new Error(`${label} 必须是 JSON 对象`)
  }
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) throw new Error(`${label} 存在未知字段：${key}`)
  }
  return input as Record<string, unknown>
}

function text(input: unknown, label: string, maxLength = MAX_SOURCE_TEXT): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maxLength) throw new Error(`${label} 无效`)
  return input
}

/** 把目标正文/约束/验收标准摊平为可核对的来源集合。 */
function collectSources(goal: ProjectOwnerGoalBrief): Array<{ source: ProjectOwnerCriterionTrace['source']; sourceIndex: number; sourceText: string }> {
  return [
    { source: 'objective' as const, sourceIndex: 0, sourceText: goal.objective },
    ...goal.constraints.map((sourceText, sourceIndex) => ({ source: 'constraint' as const, sourceIndex, sourceText })),
    ...goal.acceptanceCriteria.map((sourceText, sourceIndex) => ({ source: 'acceptance' as const, sourceIndex, sourceText })),
  ]
}

export function projectOwnerStepCriterion(item: Pick<ProjectOwnerCriterionTrace, 'sourceText' | 'verificationScope'>): string {
  const text = item.sourceText.trim()
  return item.verificationScope === 'own_text' ? `只核验本步骤自己的交付文本是否满足逐份要求（原文：${text}）` : text
}

/** 绑定成果的修订中，有时模型把目标正文误标为不存在的验收条目。只恢复唯一的逐字来源。 */
export function resolveOwnerRevisionCriteriaSources(input: unknown, goal: ProjectOwnerGoalBrief): unknown {
  if (!Array.isArray(input) || input.length > MAX_TRACE_ITEMS) return input
  const sources = collectSources(goal)
  return input.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const value = item as Record<string, unknown>
    const { sourceIndex, sourceText } = value
    if (value.source !== 'acceptance' || typeof sourceIndex !== 'number' || !Number.isSafeInteger(sourceIndex)
      || sourceIndex < goal.acceptanceCriteria.length || typeof sourceText !== 'string' || !sourceText.trim()) return item
    const matched = sources.filter(candidate => candidate.sourceText.includes(sourceText))
    return matched.length === 1 ? { ...value, source: matched[0]!.source, sourceIndex: matched[0]!.sourceIndex } : item
  })
}

/**
 * 解析模型提出的追溯记录。
 *
 * 逐项核对来源原文：`source` 与 `sourceIndex` 必须指向真实存在的条目，且 `sourceText`
 * 必须是该条目的子串。这样模型无法凭空发明一条目标里没有的「硬要求」。
 */
export function parseCriteriaTrace(input: unknown, goal: ProjectOwnerGoalBrief, steps: readonly ProjectOwnerPlanStep[]): ProjectOwnerCriterionTrace[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_TRACE_ITEMS) throw new Error('目标追溯记录数量无效')
  const sources = collectSources(goal)
  const soleTextDelivery = steps.length === 1 && steps[0]?.deliveryKind === 'text'
    && sources.some(item => SOLE_TEXT_DELIVERY.test(item.sourceText))
    && sources.every(item => !PER_OUTPUT_WORDING.test(item.sourceText) && !MULTIPLE_DELIVERIES.test(item.sourceText))
  const stepKeys = new Set(steps.map((step) => step.key))
  const seen = new Set<string>()
  const trace: ProjectOwnerCriterionTrace[] = input.map((raw) => {
    const value = record(raw, ['key', 'source', 'sourceIndex', 'sourceText', 'criticality', 'stepKey', 'verification', 'verificationScope', 'assumptions'], '目标追溯项')
    const key = text(value.key, '追溯键', 200)
    if (seen.has(key)) throw new Error(`目标追溯键重复：${key}`)
    seen.add(key)
    if (value.source !== 'objective' && value.source !== 'constraint' && value.source !== 'acceptance') throw new Error('目标追溯来源类型无效')
    const source = value.source
    if (!Number.isSafeInteger(value.sourceIndex) || (value.sourceIndex as number) < 0) throw new Error('目标追溯来源下标无效')
    const sourceIndex = value.sourceIndex as number
    if (source === 'objective' && sourceIndex !== 0) throw new Error('目标正文只允许下标 0')
    const matched = sources.find((item) => item.source === source && item.sourceIndex === sourceIndex)
    if (!matched) throw new Error(`目标追溯来源不存在：${source}[${sourceIndex}]`)
    const sourceText = text(value.sourceText, '追溯来源原文')
    if (!matched.sourceText.includes(sourceText)) throw new Error(`目标追溯来源原文与目标不符：${key}`)
    if (!CRITICALITIES.includes(value.criticality as typeof CRITICALITIES[number])) throw new Error('目标追溯关键性无效')
    const stepKey = text(value.stepKey, '承接步骤', 200)
    if (!stepKeys.has(stepKey)) throw new Error(`目标追溯指向的计划步骤不存在：${stepKey}`)
    if (!VERIFICATIONS.includes(value.verification as typeof VERIFICATIONS[number])) throw new Error('目标追溯检验方式无效')
    // 用户明确只要一份正文时，逐份元数据多余，保留同一条完整正文验收原文。
    const verificationScope = soleTextDelivery && value.verificationScope === 'own_text' && value.criticality === 'critical'
      ? undefined : value.verificationScope
    if (verificationScope !== undefined && (verificationScope !== 'own_text' || value.criticality !== 'critical'
      || !PER_OUTPUT_WORDING.test(sourceText) || JOINT_OUTPUT_WORDING.test(sourceText))) throw new Error('逐份文本核验必须引用可独立核验的明确逐份要求')
    if (verificationScope === 'own_text' && projectOwnerStepCriterion({ sourceText, verificationScope }).length > OWNER_REVIEW_CRITERION_MAX_LENGTH) {
      throw new Error('逐份文本核验标准过长，请把独立要求分段登记并保留每段原文')
    }
    // 没有默认条件时模型会省略该字段，与空数组等价，不视为错误。
    const assumptions = value.assumptions === undefined ? [] : value.assumptions
    if (!Array.isArray(assumptions) || assumptions.length > MAX_ASSUMPTIONS
      || assumptions.some((item) => typeof item !== 'string' || !item.trim() || item.length > 500)) throw new Error('目标追溯默认条件无效')
    return {
      key, source, sourceIndex, sourceText,
      criticality: value.criticality as ProjectOwnerCriterionTrace['criticality'],
      stepKey,
      verification: value.verification as ProjectOwnerCriterionTrace['verification'],
      ...(verificationScope === 'own_text' ? { verificationScope } : {}),
      assumptions: [...assumptions] as string[],
    }
  })
  const textSteps = steps.filter(step => step.deliveryKind === 'text')
  // 同一逐份要求须在每个文本交付步骤里核验，不能只核对最早的产物就通过。
  for (const item of trace.filter(item => item.verificationScope === 'own_text')) {
    const siblings = trace.filter(other => other.source === item.source
      && other.sourceIndex === item.sourceIndex && other.sourceText === item.sourceText)
    if (textSteps.length < 2 || siblings.length !== textSteps.length
      || textSteps.some(step => !siblings.some(other => other.stepKey === step.key && other.verificationScope === 'own_text'))) {
      throw new Error('逐份文本核验必须由每个文本交付步骤分别承接')
    }
  }
  // 目标正文是整个任务的根。它若无任何步骤承接，说明计划没有对准用户真正要的东西，
  // 即便约束与验收标准都登记齐全也不算完整，退回让模型重提。
  if (goal.objective.trim() && !trace.some((item) => item.source === 'objective')) {
    throw new Error('目标正文未被任何步骤承接：criteriaTrace 必须包含 source 为 objective 的条目')
  }
  return trace
}

/**
 * 检查覆盖情况。
 *
 * 只把「来源条目本身」当作必须覆盖的单位：一条来源可以有多条追溯（例如一条约束拆成两个检查），
 * 但只要该来源没有任何追溯承接，就算未覆盖。目标正文非空时同样要求至少一条追溯。
 */
export function assessCriteriaCoverage(goal: ProjectOwnerGoalBrief, trace: readonly ProjectOwnerCriterionTrace[]): CriteriaCoverage {
  const covered = new Set(trace.map((item) => `${item.source}:${item.sourceIndex}`))
  const uncovered = collectSources(goal)
    .filter((item) => {
      // 空白来源不构成硬要求，不计入覆盖基数。
      if (!item.sourceText.trim()) return false
      return !covered.has(`${item.source}:${item.sourceIndex}`)
    })
    .map((item) => ({
      key: `missing:${item.source}:${item.sourceIndex}`,
      source: item.source, sourceIndex: item.sourceIndex, sourceText: item.sourceText,
      criticality: 'critical' as const, stepKey: '', verification: 'unverified' as const, assumptions: [],
    }))
  return {
    uncovered,
    unverified: trace.filter((item) => item.verification === 'unverified'),
    criticalUncovered: uncovered.filter((item) => item.criticality === 'critical').length,
  }
}
