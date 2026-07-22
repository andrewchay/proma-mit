/**
 * Goal 本地持久化。
 *
 * 索引使用 JSON 便于快速恢复当前状态；状态变化同步追加 JSONL，便于审计和排障。
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { AgentGoal } from '@proma/shared'
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
    if (!existsSync(path)) return { version: 1, goals: [] }
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      if (!isGoalIndexFile(parsed)) throw new Error('格式无效')
      return { version: 1, goals: parsed.goals.map(cloneGoal) }
    } catch (error) {
      console.error('[Goal] 读取 Goal 索引失败，将使用空索引:', error)
      return { version: 1, goals: [] }
    }
  }

  private writeIndex(index: GoalIndexFile): void {
    const path = getAgentGoalsIndexPath()
    const tempPath = `${path}.tmp`
    writeFileSync(tempPath, JSON.stringify(index, null, 2), 'utf-8')
    renameSync(tempPath, path)
  }

  private appendEvent(event: AgentGoalEvent): void {
    appendFileSync(getAgentGoalEventsPath(event.goalId), `${JSON.stringify(event)}\n`, 'utf-8')
  }
}

function isGoalIndexFile(value: unknown): value is GoalIndexFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.goals)) return false
  return value.goals.every(isRecord)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function cloneGoal(goal: AgentGoal): AgentGoal {
  return JSON.parse(JSON.stringify(goal)) as AgentGoal
}
