/**
 * Context Hub / Work Graph 服务（PH2-D）
 *
 * 把分散的上下文（Agent 会话/Run、Todo/任务、日程、文件事件）关联为一张可查询的事实图，
 * 让成员/Agent 能从任意起点沿关联发现其他上下文（本地数据复利）。
 *
 * 关联（by 字段）：
 *   Run  ↔  sessionId / workspaceId / memberId / goalId
 *   FileEvent ↔ sessionId / memberId
 *   TodoEvent  ↔ todoId / memberId
 *   Task        ↔ projectId / assignee
 *   日程        ↔ 时间
 *
 * 设计：单入口 getEntityGraph(entityType, entityId)，返回「该实体 + 它的相关上下文」。
 * 数据源懒加载（避免无 electron 单测崩溃）。
 */

export type ContextEntityType = 'run' | 'session' | 'task' | 'file_event' | 'todo_event' | 'calendar' | 'member'

export interface ContextNode {
  type: ContextEntityType
  id: string
  title: string
  /** 附加信息（如 run 状态、file 路径、member 名） */
  detail?: string
}

export interface ContextGraph {
  entity: ContextNode
  related: ContextNode[]
}

/** 统一的多数据源查询入口（lazy，避免引入 electron 依赖链）。 */
export function getEntityGraph(entityType: ContextEntityType, entityId: string): ContextGraph | null {
  try {
    // lazy 加载各 store（部分依赖 electron，仅运行时取用）
    const { getRunStore } = require('./run-store') as { getRunStore: () => { query: (q: object) => Array<{ runId: string; sessionId?: string; workspaceId?: string; memberId?: string; goalId?: string; source: string; status: string; title: string }> } }
    const listTodoEvents = (require('./todo-event-service') as { listTodoEvents: (q: object) => Array<{ todoId: string; memberId?: string; title: string; action: string; status?: string }> }).listTodoEvents
    const listFileEvents = (require('./workspace-file-event-service') as { listFileEvents: (q: object) => Array<{ id: string; sessionId: string; memberId?: string; filePath: string; action: string }> }).listFileEvents

    const entity: ContextNode = { type: entityType, id: entityId, title: entityTitle(entityType, entityId) }
    const related: ContextNode[] = []

    const runs = getRunStore().query({ limit: 1000 })
    const todoEvents = listTodoEvents({ limit: 500 })
    const fileEvents = listFileEvents({ limit: 500 })

    // 从「目标实体」价值：找出与其关联的其他实体
    switch (entityType) {
      case 'run': {
        const run = runs.find((r) => r.runId === entityId || r.sessionId === entityId)
        if (run) {
          if (run.sessionId) related.push({ type: 'session', id: run.sessionId, title: `会话 ${run.sessionId.slice(0, 12)}` })
          if (run.memberId) related.push({ type: 'member', id: run.memberId, title: memberTitle(run.memberId) })
          if (run.goalId) related.push({ type: 'calendar', id: run.goalId, title: `Goal ${run.goalId.slice(0, 8)}` })
          // 该会话改过的文件
          for (const fe of fileEvents.filter((f) => run.sessionId && f.sessionId === run.sessionId)) {
            related.push({ type: 'file_event', id: fe.id, title: fe.filePath, detail: `动作 ${fe.action}` })
          }
          // 该会话的 Todo 事件
          for (const te of todoEvents.filter((t) => run.sessionId && t.memberId === run.memberId)) {
            related.push({ type: 'todo_event', id: te.todoId, title: te.title, detail: te.action })
          }
        }
        break
      }
      case 'member': {
        // 该成员的运行 / 文件改动 / Todo
        for (const r of runs.filter((r) => r.memberId === entityId)) related.push({ type: 'run', id: r.runId, title: r.title, detail: r.status })
        for (const fe of fileEvents.filter((f) => f.memberId === entityId)) related.push({ type: 'file_event', id: fe.id, title: fe.filePath, detail: fe.action })
        for (const te of todoEvents.filter((t) => t.memberId === entityId)) related.push({ type: 'todo_event', id: te.todoId, title: te.title, detail: te.action })
        break
      }
      case 'session': {
        const runsOf = runs.filter((r) => r.sessionId === entityId || r.runId === entityId)
        for (const r of runsOf) related.push({ type: 'run', id: r.runId, title: r.title, detail: r.status })
        for (const fe of fileEvents.filter((f) => f.sessionId === entityId)) related.push({ type: 'file_event', id: fe.id, title: fe.filePath, detail: fe.action })
        break
      }
      case 'file_event': {
        const fe = fileEvents.find((f) => f.id === entityId)
        if (fe) {
          related.push({ type: 'session', id: fe.sessionId, title: `会话 ${fe.sessionId.slice(0, 12)}` })
          if (fe.memberId) related.push({ type: 'member', id: fe.memberId, title: memberTitle(fe.memberId) })
        }
        break
      }
      case 'todo_event': {
        const te = todoEvents.find((t) => t.todoId === entityId)
        if (te?.memberId) related.push({ type: 'member', id: te.memberId, title: memberTitle(te.memberId) })
        break
      }
      default:
        break
    }

    // 去重
    const seen = new Set<string>()
    const unique = related.filter((n) => {
      const k = `${n.type}:${n.id}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    }).slice(0, 40)

    console.log(`[Diag][context-hub] ${entityType}:${entityId} → 相关 ${unique.length} 条`)
    return { entity, related: unique }
  } catch (error) {
    console.debug('[ContextHub] 查询失败:', error)
    return null
  }
}

function entityTitle(type: ContextEntityType, id: string): string {
  switch (type) {
    case 'member': return memberTitle(id)
    case 'session': return `会话 ${id.slice(0, 12)}`
    case 'run': return `运行 ${id.slice(0, 12)}`
    case 'file_event': return `文件事件 ${id.slice(0, 12)}`
    case 'todo_event': return `待办 ${id.slice(0, 12)}`
    default: return id
  }
}

function memberTitle(memberId: string): string {
  if (memberId.startsWith('agent-')) return `AI 员工 ${memberId.slice(6).slice(0, 12)}`
  if (memberId.startsWith('paa-')) return memberId.slice(4)
  return memberId
}

/** 生成可读的关联图摘要（给 Agent/UI 用）。 */
export function graphToText(graph: ContextGraph): string {
  const lines = [`【${graph.entity.type}】${graph.entity.title}`]
  if (graph.related.length === 0) {
    lines.push('（暂无关联上下文）')
  } else {
    lines.push('关联上下文：')
    for (const n of graph.related) {
      lines.push(`- [${n.type}] ${n.title}${n.detail ? `（${n.detail}）` : ''}`)
    }
  }
  return lines.join('\n')
}
