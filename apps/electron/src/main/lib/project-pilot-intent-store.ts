import { createHash } from 'node:crypto'
import type { PilotIntent, PilotObservation, PilotOverviewSnapshot } from '@gravitas/shared'
import { getProjectDb } from './project-sqlite-store'
import { observeProjectPilot } from './project-pilot-reconcile'

type IntentKey = Pick<PilotIntent, 'projectId' | 'sourceType' | 'sourceId' | 'sourceVersion' | 'kind'>

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function candidates(observation: PilotObservation): IntentKey[] {
  const projectId = observation.projectId
  const result: IntentKey[] = []
  for (const task of observation.tasks) {
    const kind = task.state === 'waiting_dependency' ? 'dependency_wait'
      : task.state === 'ready' ? 'ready_candidate'
      : task.state === 'awaiting_review' ? 'review_candidate'
      : task.state === 'needs_attention' ? 'attention_candidate' : null
    if (!kind) continue
    result.push({ projectId, sourceType: 'task', sourceId: task.taskId,
      // 依赖与交付可能在 Task.updatedAt 不变时变化，故以事实投影而非时间戳为版本。
      sourceVersion: digest([task.status, task.updatedAt, task.state, task.blockerTaskIds, task.executionId, task.reason]), kind })
  }
  for (const attention of observation.attention) {
    result.push({ projectId, sourceType: attention.sourceType, sourceId: attention.sourceId,
      sourceVersion: String(attention.sourceVersion), kind: attention.sourceType === 'delivery' ? 'review_candidate'
        : attention.sourceType === 'approval' ? 'approval_request' : 'attention_candidate' })
  }
  return result
}

/** 历史记录接口，仅供诊断；open 表示上次对账结果，并不证明当前事实仍有效。 */
export function listPilotIntentHistory(projectId: string): PilotIntent[] {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('缺少项目 ID')
  const rows = getProjectDb().prepare(`SELECT id, project_id AS projectId, source_type AS sourceType,
    source_id AS sourceId, source_version AS sourceVersion, kind, status, created_at AS createdAt
    FROM pilot_intents WHERE project_id = ? ORDER BY created_at ASC, id ASC`).all(projectId)
  return rows as PilotIntent[]
}

function listOpenPilotIntents(projectId: string): PilotIntent[] {
  return getProjectDb().prepare(`SELECT id, project_id AS projectId, source_type AS sourceType,
    source_id AS sourceId, source_version AS sourceVersion, kind, status, created_at AS createdAt
    FROM pilot_intents WHERE project_id = ? AND status = 'open' ORDER BY created_at ASC, id ASC`).all(projectId) as PilotIntent[]
}

const queues = new Map<string, Promise<void>>()

/** 只接受项目 ID；同项目串行重读权威事实，旧观察不能在新观察之后提交。 */
export function reconcilePilotOverview(projectId: string, signal?: AbortSignal): Promise<PilotOverviewSnapshot> {
  if (typeof projectId !== 'string' || !projectId.trim()) return Promise.reject(new Error('缺少项目 ID'))
  const previous = queues.get(projectId) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(() => reconcileCurrent(projectId, signal))
  const tail = result.then(() => undefined, () => undefined)
  queues.set(projectId, tail)
  void tail.then(() => { if (queues.get(projectId) === tail) queues.delete(projectId) })
  return result
}

export function reconcilePilotIntents(projectId: string, signal?: AbortSignal): Promise<PilotIntent[]> {
  return reconcilePilotOverview(projectId, signal).then((snapshot) => snapshot.intents)
}

async function reconcileCurrent(projectId: string, signal?: AbortSignal): Promise<PilotOverviewSnapshot> {
  if (signal?.aborted) throw new Error('Pilot 对账已停止')
  const observation = await observeProjectPilot(projectId)
  if (signal?.aborted) throw new Error('Pilot 对账已停止')
  const database = getProjectDb()
  // 本层仅记账；若事务前事实变化，读取方必须重新对账，不把 open 视为实时有效授权。
  const next = candidates(observation)
  const ids = new Set(next.map((item) => digest(item)))
  const now = Date.now()
  database.transaction(() => {
    const project = database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
    if (!project) throw new Error('项目不存在')
    const existing = database.prepare('SELECT id FROM pilot_intents WHERE project_id = ? AND status = ?').all(projectId, 'open') as Array<{ id: string }>
    for (const row of existing) {
      if (!ids.has(row.id)) database.prepare('UPDATE pilot_intents SET status = ? WHERE id = ?').run('stale', row.id)
    }
    for (const item of next) {
      const id = digest(item)
      // 旧版重现可重新开放同一身份，不产生重复记录；不据此执行命令。
      database.prepare(`INSERT INTO pilot_intents (id, project_id, source_type, source_id, source_version, kind, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?) ON CONFLICT(id) DO UPDATE SET status = 'open' WHERE status <> 'open'`)
        .run(id, item.projectId, item.sourceType, item.sourceId, item.sourceVersion, item.kind, now)
    }
  })()
  return { observation, intents: listOpenPilotIntents(projectId) }
}

/** 获取供展示的建议前必重新采集项目事实；历史账本不得作为执行来源。 */
export async function getCurrentPilotIntents(projectId: string): Promise<PilotIntent[]> {
  return reconcilePilotIntents(projectId)
}
