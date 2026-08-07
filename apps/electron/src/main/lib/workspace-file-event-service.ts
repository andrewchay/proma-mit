/**
 * 工作区文件共享事件流 — Workspace File Event Service（PH2-A）
 *
 * 记录「哪个成员/Agent 改动了哪个文件」，形成团队可见的文件活动流。
 * - 挂在 Agent 的 Write / Edit 工具成功后（此时持有 sessionId，可归因到 member）。
 * - 单独 JSONL（file-events.jsonl），不污染运行记录(RunRecord)。
 * - 提供按成员/工作区/动作过滤的查询，支撑「谁改了什么」的团队可见性。
 */

import { mkdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'

export type FileEventAction = 'write' | 'edit' | 'delete'

export interface WorkspaceFileEvent {
  /** 事件 ID */
  id: string
  at: number
  sessionId: string
  /** 执行者成员归属（memberId=agent-<id>/paa-<name>） */
  memberId?: string
  action: FileEventAction
  filePath: string
  workspaceSlug?: string
}

export interface FileEventQuery {
  memberId?: string
  action?: FileEventAction
  limit?: number
}

const MAX_FILE_EVENTS = 2000

function eventFile(): string {
  const dir = join(getConfigDir(), 'file-events')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'events.jsonl')
}

/**
 * 记录一条文件事件。memberId 由 resolveMemberForSession 解析（sessionId→agent-<id>）。
 * 失败静默（不能因记录事件阻塞 Agent 写文件）。
 */
export function recordFileEvent(
  sessionId: string,
  action: FileEventAction,
  filePath: string,
  workspaceSlug?: string,
): void {
  try {
    let memberId: string | undefined
    try {
      const { resolveMemberForSession } = require('./app-event-bus') as { resolveMemberForSession: (s: string) => string | undefined }
      memberId = resolveMemberForSession(sessionId)
    } catch {
      memberId = undefined
    }
    const event: WorkspaceFileEvent = {
      id: `fevt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      sessionId,
      ...(memberId ? { memberId } : {}),
      action,
      filePath,
      ...(workspaceSlug ? { workspaceSlug } : {}),
    }
    appendFileSync(eventFile(), `${JSON.stringify(event)}\n`, 'utf-8')
  } catch (error) {
    console.debug('[FileEvent] 记录文件事件失败:', error)
  }
}

/** 读取文件事件（按时间倒序）。实现进度：内存无缓存，直接读 + 截断到 limit。 */
export function listFileEvents(query: FileEventQuery = {}): WorkspaceFileEvent[] {
  try {
    const path = eventFile()
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf-8')
    const events: WorkspaceFileEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as WorkspaceFileEvent)
      } catch {
        // 跳过损坏行
      }
    }
    return events
      .sort((a, b) => b.at - a.at)
      .filter((e) => (!query.memberId || e.memberId === query.memberId) && (!query.action || e.action === query.action))
      .slice(0, query.limit ?? 200)
  } catch {
    return []
  }
}
