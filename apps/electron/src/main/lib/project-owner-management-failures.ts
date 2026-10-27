/**
 * Owner管理循环失败退避的持久记录。
 *
 * 只记录"同一失败键连续出现"的次数和下次允许重试时间；不保存错误正文、
 * 模型输出或任何授权，因此重启后可继续退避，也不能被当作执行许可。
 */
import { getProjectDb } from './project-sqlite-store'

export interface OwnerManagementFailure {
  failureKey: string
  attemptCount: number
  retryUntil: number
  notified: boolean
  updatedAt: number
}

interface FailureRow {
  failure_key: string
  attempt_count: number
  retry_until: number
  notified: number
  updated_at: number
}

function fromRow(row: FailureRow): OwnerManagementFailure {
  return { failureKey: row.failure_key, attemptCount: row.attempt_count, retryUntil: row.retry_until, notified: row.notified === 1, updatedAt: row.updated_at }
}

export function readOwnerManagementFailure(projectId: string): OwnerManagementFailure | null {
  const row = getProjectDb().prepare('SELECT * FROM project_owner_management_failures WHERE project_id = ?').get(projectId) as FailureRow | undefined
  return row ? fromRow(row) : null
}

/** 同一失败键累加次数并按指数退避；不同失败键视为新的连续故障。 */
export function recordOwnerManagementFailure(projectId: string, failureKey: string, now = Date.now()): OwnerManagementFailure {
  if (!projectId.trim() || !failureKey.trim()) throw new Error('Owner失败退避身份无效')
  const database = getProjectDb()
  let result: OwnerManagementFailure | undefined
  database.transaction(() => {
    const previous = readOwnerManagementFailure(projectId)
    const attemptCount = previous && previous.failureKey === failureKey ? previous.attemptCount + 1 : 1
    // 2s、8s、30s…上限 5 分钟，与既有内存策略一致。
    const retryUntil = now + Math.min(2_000 * 4 ** (attemptCount - 1), 300_000)
    // 只有真正写入提示后才置位；这里只沿用同键的既有权值。
    const notified = previous && previous.failureKey === failureKey ? previous.notified : false
    database.prepare(`INSERT INTO project_owner_management_failures(project_id, failure_key, attempt_count, retry_until, notified, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET failure_key=excluded.failure_key, attempt_count=excluded.attempt_count,
        retry_until=excluded.retry_until, notified=excluded.notified, updated_at=excluded.updated_at`)
      .run(projectId, failureKey, attemptCount, retryUntil, notified ? 1 : 0, now)
    const stored = readOwnerManagementFailure(projectId)
    if (!stored) throw new Error('Owner失败退避未落库')
    result = stored
  })()
  if (!result) throw new Error('Owner失败退避事务未产生结果')
  return result
}

/** 只在第 3 次及以后提示一次；重启后不会重复刷同一条提示。 */
export function markOwnerManagementFailureNotified(projectId: string, failureKey: string, now = Date.now()): boolean {
  const changed = getProjectDb().prepare(`UPDATE project_owner_management_failures SET notified = 1, updated_at = ?
    WHERE project_id = ? AND failure_key = ? AND notified = 0`).run(now, projectId, failureKey)
  return changed.changes === 1
}

export function clearOwnerManagementFailure(projectId: string): void {
  getProjectDb().prepare('DELETE FROM project_owner_management_failures WHERE project_id = ?').run(projectId)
}
