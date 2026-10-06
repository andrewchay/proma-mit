/**
 * project-user-language — 用户层状态语言映射（R-P1-02）
 *
 * 职责：把 Project Pilot 的内部状态（任务观察、候选意图）翻译成
 * 「发生了什么、为什么、下一步做什么」的用户语言，并聚合出优先下一步行动。
 * 边界：纯函数投影层，不判断权限、不触发执行；内部状态名只允许出现在高级详情。
 */
import type { PilotIntent, PilotObservation } from '@gravitas/shared'

export type NextStepActionKind = 'open_task' | 'open_chain' | 'open_inbox' | 'none'

export interface TaskStateLanguage {
  /** 状态的中文短标签 */
  label: string
  /** 用户视角的下一步 */
  nextAction: string
  actionKind: NextStepActionKind
}

/** 任务观察状态 → 用户语言（R-P1-02 核心映射） */
export function describeTaskState(state: PilotObservation['tasks'][number]['state']): TaskStateLanguage {
  switch (state) {
    case 'waiting_dependency':
      return { label: '等待前置任务', nextAction: '先完成它依赖的任务，完成后会自动解锁', actionKind: 'open_task' }
    case 'awaiting_review':
      return { label: '成果已提交，等你验收', nextAction: '打开任务详情审阅交付差异并验收', actionKind: 'open_task' }
    case 'needs_attention':
      return { label: '需要你处理', nextAction: '查看任务详情，按提示补充信息或调整配置', actionKind: 'open_task' }
    case 'ready':
      return { label: '已准备好，可以开始', nextAction: '打开任务详情确认后开始执行', actionKind: 'open_task' }
    case 'running':
      return { label: '执行中', nextAction: '可打开任务详情查看进度；完成后会通知你验收', actionKind: 'open_task' }
    case 'done':
      return { label: '已完成', nextAction: '无需处理；业务验收以交付链记录为准', actionKind: 'open_task' }
    case 'inactive':
      return { label: '不参与推进', nextAction: '如需纳入推进，请在任务详情中调整负责人或状态', actionKind: 'open_task' }
  }
}

/** 候选意图类型 → 用户语言 */
export function describeIntentKind(kind: PilotIntent['kind']): TaskStateLanguage {
  switch (kind) {
    case 'dependency_wait':
      return { label: '等待前置任务完成', nextAction: '先完成它依赖的任务', actionKind: 'open_task' }
    case 'ready_candidate':
      return { label: '已准备好，等待开始', nextAction: '打开任务确认后即可安排执行', actionKind: 'open_task' }
    case 'review_candidate':
      return { label: '成果已提交，等待你验收', nextAction: '前往任务审阅交付并给出结论', actionKind: 'open_task' }
    case 'attention_candidate':
      return { label: '需要你处理', nextAction: '查看对应事项，按提示处理', actionKind: 'open_chain' }
    case 'approval_request':
      return { label: '等待你答复', nextAction: '在上方的待办收件箱中答复', actionKind: 'open_inbox' }
  }
}

/** 下一步行动优先级：需要人的动作优先于等待类 */
const INTENT_PRIORITY: Record<PilotIntent['kind'], number> = {
  approval_request: 0,
  attention_candidate: 1,
  review_candidate: 2,
  ready_candidate: 3,
  dependency_wait: 4,
}

export interface NextStepItem {
  /** 稳定 key：intent id */
  id: string
  title: string
  reason: string
  actionKind: NextStepActionKind
  intent: PilotIntent
  /** 关联的任务观察（仅任务来源存在） */
  task?: PilotObservation['tasks'][number]
}

/**
 * 从观察与开放意图聚合「下一步行动」：按优先级排序、去重（同任务多条意图取最优先）、
 * 截取前 limit 条（默认 5）。纯投影，不改变权威事实。
 */
export function buildNextStepItems(
  observation: Pick<PilotObservation, 'tasks' | 'attention'>,
  intents: PilotIntent[],
  limit = 5,
): NextStepItem[] {
  const seenSources = new Set<string>()
  const items: NextStepItem[] = []
  for (const intent of [...intents].filter((item) => item.status === 'open')
    .sort((a, b) => INTENT_PRIORITY[a.kind] - INTENT_PRIORITY[b.kind])) {
    const key = `${intent.sourceType}:${intent.sourceId}`
    if (seenSources.has(key)) continue
    seenSources.add(key)
    const language = describeIntentKind(intent.kind)
    const task = intent.sourceType === 'task'
      ? observation.tasks.find((item) => item.taskId === intent.sourceId)
      : undefined
    const attention = observation.attention.find(
      (item) => item.sourceType === intent.sourceType && item.sourceId === intent.sourceId,
    )
    items.push({
      id: intent.id,
      title: task?.title ?? attention?.reason ?? intent.sourceId,
      reason: language.nextAction,
      actionKind: language.actionKind,
      intent,
      task,
    })
    if (items.length >= limit) break
  }
  return items
}
