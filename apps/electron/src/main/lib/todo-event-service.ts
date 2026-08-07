/**
 * Todo 事件流服务 — Todo Event Stream Service（PH2-A）
 *
 * 把 Todo（项目管理任务）沉淀为「团队可订阅的语义流」：
 * - 订阅 project-service.onTaskChange，把任务生命周期（创建/更新/删除/完成/改派）记为事件；
 * - 携带执行者成员归属（assignee.userId 本身即是 memberId：paa-<name>/agent-<id>）；
 * - 单独 JSONL（todo-events），供团队 Tab「Todo 动态」/ Agent 解压缩读取。
 */

import { mkdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

export type TodoEventAction = 'created' | 'updated' | 'completed' | 'deleted' | 'assigned'

export interface TodoEvent {
  id: string
  at: number
  /** 来源：project(项目管理) / goal */
  source: 'project' | 'goal'
  /** 事件动作 */
  action: TodoEventAction
  /** Todo 实体 ID */
  todoId: string
  /** Todo 标题 */
  title: string
  /** 状态（pending/in_progress/completed/…） */
  status?: string
  /** 执行者成员归属 */
  memberId?: string
  /** 责任人展示名 */
  assigneeName?: string
  /** 所属项目 */
  projectId?: string
  /** 截止时间 */
  dueAt?: number
}

export interface TodoEventQuery {
  memberId?: string
  action?: TodoEventAction
  source?: 'project' | 'goal'
  limit?: number
}

const MAX_TODO_EVENTS = 2000

function eventFile(): string {
  const dir = join(getConfigDir(), 'todo-events')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'events.jsonl')
}

/** 记录一条 Todo 事件。失败静默（不阻塞任务保存）。 */
export function recordTodoEvent(input: Omit<TodoEvent, 'id' | 'at'>): void {
  try {
    const event: TodoEvent = {
      id: `tevt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      ...input,
    }
    appendFileSync(eventFile(), `${JSON.stringify(event)}\n`, 'utf-8')
  } catch (error) {
    console.debug('[TodoEvent] 记录失败:', error)
  }
}

/** 读取 Todo 事件（按时间倒序）。 */
export function listTodoEvents(query: TodoEventQuery = {}): TodoEvent[] {
  try {
    const path = eventFile()
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf-8')
    const events: TodoEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as TodoEvent)
      } catch {
        // 跳过损坏行
      }
    }
    return events
      .sort((a, b) => b.at - a.at)
      .filter((e) =>
        (!query.memberId || e.memberId === query.memberId) &&
        (!query.action || e.action === query.action) &&
        (!query.source || e.source === query.source)
      )
      .slice(0, query.limit ?? 200)
  } catch {
    return []
  }
}
