/**
 * 把外部变化观察投递进项目对话。
 *
 * 只投递需要人看的两类判定（attention / decision_required）：record_only、duplicate
 * 与 insufficient_evidence 只留在项目页的观察账本里，不占用户注意力。
 * 观察消息是系统来源，不伪装用户消息，也不构成任何执行授权。
 */
import type { ProjectWebChangeObservation } from '@gravitas/shared'
import { getProjectOwnerGoalDraft } from './project-owner-goal-service'
import { getOwnerManager, recordOwnerConversationMessage } from './project-owner-management-store'
import { getAuthorizedProjectWebChangeObservation } from './project-web-change-observations'

const JUDGMENT_LABEL: Record<string, string> = {
  attention: '值得你了解',
  decision_required: '需要你做一个决定',
}

/** 投递摘要：只叙述事实与待决项，不声称已执行或已验收。 */
export function describeWebChangeObservation(observation: ProjectWebChangeObservation): string {
  const facts = observation.facts.filter((fact) => !fact.isInference).slice(0, 5)
  const lines = [`外部信息观察：${JUDGMENT_LABEL[observation.judgment] ?? observation.judgment}`]
  if (facts.length) {
    lines.push('观察到的变化：')
    for (const fact of facts) {
      const when = fact.publishedAt ? `（${fact.publishedAt}）` : '（发布时间未确认）'
      lines.push(`- ${fact.title}${when}：${fact.quote}`)
    }
  }
  if (observation.impact) lines.push(`可能的影响：${observation.impact}`)
  if (observation.suggestion) lines.push(`建议（待你确认）：${observation.suggestion}`)
  if (observation.question) lines.push(`需要你决定：${observation.question}`)
  if (observation.uncertainty) lines.push(`不确定之处：${observation.uncertainty}`)
  lines.push('以上来自公开网页，只作材料；没有为此修改项目、任务或授权。')
  return lines.join('\n')
}

/**
 * 投递一条观察。返回是否真的写入了对话。
 * 目标版本已经变过时不套用旧观察：改为提示一条 attention，不静默丢弃。
 */
export function enqueueWebChangeObservation(observation: ProjectWebChangeObservation): boolean {
  if (observation.judgment !== 'attention' && observation.judgment !== 'decision_required') return false
  const current = getAuthorizedProjectWebChangeObservation(observation.projectId, observation.id)
  if (!current) return false
  const manager = getOwnerManager(observation.projectId)
  if (!manager || manager.status !== 'active') return false
  const goal = getProjectOwnerGoalDraft(observation.projectId)
  if (!goal) return false

  const staleGoal = current.binding.goalRevision !== null && current.binding.goalRevision !== goal.revision
  if (staleGoal) {
    recordOwnerConversationMessage({
      projectId: current.projectId,
      eventId: `web-change-stale:${current.id}`,
      role: 'assistant',
      kind: 'attention',
      goalRevision: goal.revision,
      content: '有一条外部信息观察是在旧目标下做出的，目标已经更新，我不会把它套用到当前目标。需要时可在项目页「外网扫描」查看那条记录。',
    })
    return false
  }

  recordOwnerConversationMessage({
    projectId: current.projectId,
    eventId: `web-change:${current.id}`,
    role: 'assistant',
    kind: 'web_change_observation',
    webChangeObservationId: current.id,
    goalRevision: goal.revision,
    content: describeWebChangeObservation(current),
  })
  return true
}
