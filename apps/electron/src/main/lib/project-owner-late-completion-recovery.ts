/** 自动恢复只复用本机可核验的迟到终态；不重发员工模型请求。 */
import { previewOwnerLateCompletion } from './project-owner-late-completion-preview'
import { readOwnerLateCompletionReconciliation, reconcileOwnerLateCompletion } from './project-owner-late-completion-reconcile'
import { resumeOwnerLateCompletion } from './project-owner-late-completion-resume'
import * as store from './project-sqlite-store'

const attempts = new Set<string>()

/** 每次进程启动对同一条命令最多尝试一次；失败保留原状态，不形成热循环。 */
export async function recoverOwnerLateCompletions(projectId: string, isSessionActive: (sessionId: string) => boolean): Promise<boolean> {
  const db = store.getProjectDb()
  const rows = db.prepare(`SELECT c.id FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    WHERE c.project_id=? AND c.role='executor' AND g.dispatch_mode='autonomous' AND g.state='paused'
      AND (c.state='needs_reconcile' OR (c.state='settled' AND EXISTS (SELECT 1 FROM project_owner_late_completion_reconciliations r WHERE r.command_id=c.id)
        AND NOT EXISTS (SELECT 1 FROM project_owner_late_completion_resumptions s WHERE s.command_id=c.id)))
    ORDER BY c.created_at`).all(projectId) as Array<{ id: string }>
  let recovered = false
  for (const row of rows) {
    if (attempts.has(row.id)) continue
    try {
      if (!readOwnerLateCompletionReconciliation(row.id)) {
        const preview = await previewOwnerLateCompletion(row.id, isSessionActive)
        if (!preview) continue
        attempts.add(row.id)
        await reconcileOwnerLateCompletion(row.id, preview.fingerprint, isSessionActive)
      } else attempts.add(row.id)
      await resumeOwnerLateCompletion(row.id, isSessionActive)
      recovered = true
    } catch (cause) {
      attempts.add(row.id)
      console.warn('[Owner恢复] 迟到终态未能安全续接，保留账本与暂停状态:', cause instanceof Error ? cause.message : '未知错误')
    }
  }
  return recovered
}
