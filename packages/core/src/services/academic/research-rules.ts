/**
 * 研究项目状态机与输入校验规则（M1）
 *
 * 纯函数、无 IO。方案 v1 §4：门禁限制的是「批准、执行、验证、
 * 发布就绪」等状态，而不是限制思考——所以这里只约束合法的状态
 * 迁移与必填字段，不判断研究内容质量。
 */

import {
  RESEARCH_ERROR_CODES,
  ResearchError,
  type CreateResearchProjectInput,
  type ResearchBrief,
  type ResearchDomain,
  type ResearchMethodPath,
  type ResearchProjectStatus,
  type ResearchSensitivity,
} from '@gravitas/shared'

/** 合法状态迁移表（单向主干 + 完成后归档；回流由显式事件处理） */
const VALID_STATUS_TRANSITIONS: Record<ResearchProjectStatus, ResearchProjectStatus[]> = {
  defining: ['literature', 'designing', 'archived'],
  literature: ['designing', 'archived'],
  designing: ['executing', 'literature', 'archived'],
  executing: ['analyzing', 'designing', 'archived'],
  analyzing: ['writing', 'executing', 'archived'],
  writing: ['reviewing', 'analyzing', 'archived'],
  reviewing: ['writing', 'completed', 'archived'],
  completed: ['archived'],
  archived: [],
}

export const RESEARCH_DOMAINS: readonly ResearchDomain[] = [
  'audiology',
  'medical-humanities',
  'statistics',
  'ai',
  'ontology',
  'enterprise-ai',
  'data-science',
]

export const RESEARCH_METHOD_PATHS: readonly ResearchMethodPath[] = [
  'quantitative',
  'qualitative',
  'formal',
  'mixed-practice',
]

const SENSITIVITIES: readonly ResearchSensitivity[] = ['public', 'internal', 'sensitive', 'restricted']

// 重导出供消费方（测试/服务）使用，避免从 shared 直接拉第二套导入路径
export { RESEARCH_ERROR_CODES, ResearchError }

/** 校验创建输入，失败抛 ResearchError(INVALID_INPUT) */
export function validateCreateResearchProject(input: CreateResearchProjectInput): void {
  const title = input.title?.trim()
  if (!title) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '研究项目标题不能为空')
  }
  if (title.length > 200) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '研究项目标题过长（≤200 字符）')
  }
  if (!RESEARCH_DOMAINS.includes(input.domain)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `未知研究领域: ${String(input.domain)}`)
  }
  if (!RESEARCH_METHOD_PATHS.includes(input.methodPath)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `未知方法路径: ${String(input.methodPath)}`)
  }
  if (input.sensitivity !== undefined && !SENSITIVITIES.includes(input.sensitivity)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `未知敏感级别: ${String(input.sensitivity)}`)
  }
  if (input.brief !== undefined) {
    validateResearchBrief(input.brief)
  }
}

/** Brief 内部字段校验：question/goals/scope 必填 */
export function validateResearchBrief(brief: ResearchBrief): void {
  if (!brief.question?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '研究问题（brief.question）不能为空')
  }
  if (!brief.goals?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '研究目标（brief.goals）不能为空')
  }
  if (!brief.scope?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '范围边界（brief.scope）不能为空')
  }
}

/** 校验状态迁移，失败抛 ResearchError(INVALID_TRANSITION) */
export function assertStatusTransition(
  from: ResearchProjectStatus,
  to: ResearchProjectStatus,
): void {
  const allowed = VALID_STATUS_TRANSITIONS[from]
  if (!allowed || !allowed.includes(to)) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_TRANSITION,
      `非法研究状态迁移: ${from} → ${to}`,
    )
  }
}

/** 查询某状态的合法下一状态（供 UI 展示） */
export function nextStatusesOf(status: ResearchProjectStatus): readonly ResearchProjectStatus[] {
  return VALID_STATUS_TRANSITIONS[status] ?? []
}
