import type { ProjectOwnerGoalBrief } from '@gravitas/shared'

const SOURCE_FACTS_ONLY = /(?:只|仅)(?:能|可)?(?:使用|用|依据|基于)(?:以上|上述|用户)?(?:明确)?(?:给定|提供)?(?:的)?事实|\b(?:use only|only use) (?:the )?(?:given|provided) facts\b/i

function goalSources(goal: ProjectOwnerGoalBrief): string[] {
  return [goal.objective, ...goal.constraints, ...goal.acceptanceCriteria]
}

export function ownerRequiresSourceFactsOnly(goal: ProjectOwnerGoalBrief): boolean {
  return goalSources(goal).some(isOwnerSourceFactsCriterion)
}

export function isOwnerSourceFactsCriterion(text: string): boolean {
  return SOURCE_FACTS_ONLY.test(text)
}

/** 用原目标核对日期旁新增的星期，日期的星期不能从月日单独确定。 */
export function findOwnerUnstatedWeekday(goal: ProjectOwnerGoalBrief, content: string): string | null {
  if (!ownerRequiresSourceFactsOnly(goal)) return null
  const weekdaysWithDate = (text: string) => Array.from(text.replace(/[*_`]/g, '')
    .matchAll(/(?<!\d)(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)\s*[（(，,]?\s*(?:星期|周|礼拜)([一二三四五六日天])/g))
  const weekdayKey = ([, , month, day, weekday]: RegExpMatchArray) =>
    `${Number(month)}-${Number(day)}-${weekday === '天' ? '日' : weekday}`
  const sourceDates = goalSources(goal).flatMap(weekdaysWithDate)
  const extra = weekdaysWithDate(content).find(match => !sourceDates.some(source =>
    weekdayKey(source) === weekdayKey(match) && (!match[1] || source[1] === match[1])))
  return extra ? `正文中的「${extra[0]}」补入了原目标未明确给出的星期。请保留给定日期并删除补入的星期。` : null
}
