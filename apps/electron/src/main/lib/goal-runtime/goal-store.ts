/**
 * Goal 本地持久化。
 *
 * 索引使用 JSON 便于快速恢复当前状态；状态变化同步追加 JSONL，便于审计和排障。
 */

import { appendFileSync, closeSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { AgentGoal } from '@gravitas/shared'
import { getAgentGoalEventsPath, getAgentGoalsIndexPath } from '../config-paths'

export interface AgentGoalEvent {
  type: 'created' | 'updated' | 'deleted'
  goalId: string
  at: number
  goal?: AgentGoal
}

interface GoalIndexFile {
  version: 1
  goals: AgentGoal[]
}

export class ElectronGoalStore {
  list(): AgentGoal[] {
    return this.readIndex().goals.map(cloneGoal)
  }

  get(goalId: string): AgentGoal | undefined {
    const goal = this.readIndex().goals.find((item) => item.id === goalId)
    return goal ? cloneGoal(goal) : undefined
  }

  getBySession(sessionId: string): AgentGoal[] {
    return this.list().filter((goal) => goal.sessionId === sessionId)
  }

  save(goal: AgentGoal, eventType: AgentGoalEvent['type'] = 'updated'): AgentGoal {
    const index = this.readIndex()
    const next = cloneGoal(goal)
    if (!isGoalId(next.id)) throw new Error('Goal ID 无效，拒绝写入')
    const existingIndex = index.goals.findIndex((item) => item.id === next.id)
    if (existingIndex >= 0) index.goals[existingIndex] = next
    else index.goals.push(next)
    this.writeIndex(index)
    this.appendEvent({ type: eventType, goalId: next.id, at: Date.now(), goal: next })
    return cloneGoal(next)
  }

  delete(goalId: string): boolean {
    const index = this.readIndex()
    const nextGoals = index.goals.filter((goal) => goal.id !== goalId)
    if (nextGoals.length === index.goals.length) return false
    this.writeIndex({ version: 1, goals: nextGoals })
    this.appendEvent({ type: 'deleted', goalId, at: Date.now() })
    return true
  }

  private readIndex(): GoalIndexFile {
    const path = getAgentGoalsIndexPath()
    try {
      if (!lstatSync(path).isFile()) throw new Error('索引不是普通文件')
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      if (!isGoalIndexFile(parsed)) throw new Error('格式无效')
      return { version: 1, goals: parsed.goals.map(cloneGoal) }
    } catch (error) {
      if (isMissingFile(error)) {
        try { lstatSync(path) } catch (statError) { if (isMissingFile(statError)) return { version: 1, goals: [] }; throw statError }
      }
      throw new Error('Goal 索引无法读取或格式无效；已保留原文件并停止操作', { cause: error })
    }
  }

  private writeIndex(index: GoalIndexFile): void {
    const path = getAgentGoalsIndexPath()
    const tempPath = `${path}.${randomUUID()}.tmp`
    let created = false
    try {
      const descriptor = openSync(tempPath, 'wx', 0o600)
      created = true
      try { writeFileSync(descriptor, JSON.stringify(index, null, 2), 'utf-8') } finally { closeSync(descriptor) }
      renameSync(tempPath, path)
      created = false
    } finally {
      if (created) { try { unlinkSync(tempPath) } catch (error) { if (!isMissingFile(error)) throw error } }
    }
  }

  private appendEvent(event: AgentGoalEvent): void {
    appendFileSync(getAgentGoalEventsPath(event.goalId), `${JSON.stringify(event)}\n`, 'utf-8')
  }
}

function isGoalIndexFile(value: unknown): value is GoalIndexFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.goals)) return false
  const ids = new Set<string>()
  return value.goals.every((goal) => {
    if (!isRecord(goal) || typeof goal.id !== 'string' || !isGoalId(goal.id) || typeof goal.sessionId !== 'string' || !goal.sessionId.trim() || ids.has(goal.id)) return false
    ids.add(goal.id)
    return true
  })
}

function isGoalId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function cloneGoal(goal: AgentGoal): AgentGoal {
  return JSON.parse(JSON.stringify(goal)) as AgentGoal
}
