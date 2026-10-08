/** 配置/暂停准备/本地Run读取；无start/Caller/receipt写入IPC。 */
import { PROJECT_IPC_CHANNELS, type ProjectOwnerGoalResult, type ProjectOwnerRunView } from '@gravitas/shared'
import { getOwnerRuntimeBinding, prepareOwnerPlanning, saveOwnerRuntimeBinding } from './project-owner-runtime-binding'
import { getOwnerPlanningRunOutcome, getOwnerPlanningRunReceipt } from './project-owner-planning-run-service'
import { readOwnerPlanningSnapshot } from './project-owner-planning-source'
import * as store from './project-sqlite-store'
interface Registrar { handle: (channel: string, handler: (event: unknown, request: unknown) => unknown) => void }
function fields(input: unknown, allowed: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Owner配置请求含无效或未知字段')
  const value = input as Record<string, unknown>
  if (typeof value.projectId !== 'string' || !value.projectId.trim() || value.projectId.length > 128 || (value.taskId !== undefined && (typeof value.taskId !== 'string' || !value.taskId.trim() || value.taskId.length > 128))) throw new Error('Owner配置项目或任务身份无效')
  return value
}
function result<T>(operation: () => T): ProjectOwnerGoalResult<T> {
  try { return { ok: true, value: operation() } } catch (cause) { return { ok: false, error: { code: 'failed', message: cause instanceof Error ? cause.message : 'Owner配置操作失败' } } }
}
export function listOwnerPlanningRuns(projectId: string, taskId?: string): ProjectOwnerRunView[] {
  const project = store.getProject(projectId), task = taskId === undefined ? undefined : store.getTask(taskId)
  if (!project || (taskId !== undefined && (!task || task.projectId !== projectId))) throw new Error('Owner规划记录主体不存在或跨项目')
  const rows = store.getProjectDb().prepare("SELECT planning_task_id FROM project_owner_planning_links WHERE project_id = ? AND json_extract(payload, '$.targetTaskId') IS ? ORDER BY rowid DESC LIMIT 50").all(projectId, taskId ?? null) as { planning_task_id: string }[]
  return rows.flatMap(row => {
    const snapshot = readOwnerPlanningSnapshot(row.planning_task_id)
    if (!snapshot || snapshot.link.projectId !== projectId) throw new Error('Owner规划读取来源损坏')
    if (snapshot.link.targetTaskId !== taskId) return []
    const executions = store.listAgentExecutionsByEntity('task', row.planning_task_id)
    const receipts = executions.flatMap(execution => {
      if (execution.projectId !== projectId) throw new Error('Owner Run身份越界')
      const records = store.getProjectDb().prepare('SELECT id FROM project_owner_planning_run_receipts WHERE execution_id = ? ORDER BY rowid').all(execution.id) as { id: string }[]
      return records.map(record => {
        const receipt = getOwnerPlanningRunReceipt(record.id)
        if (!receipt || receipt.linkId !== snapshot.link.id || receipt.projectId !== projectId || receipt.executionId !== execution.id) throw new Error('Owner Run证据关联无效')
        // 仅明确的展示DTO，不把SDK原始元数据或载体配置凭据带往渲染进程。
        const { id, executionId, capturedAt, responseText, responseHash, validTerminal, stopped, error, usage, cost } = receipt
        return { id, executionId, capturedAt, responseText, responseHash, validTerminal, stopped, error, usage, cost }
      })
    })
    return [{ link: snapshot.link, executions: executions.map(item => ({ id: item.id, sessionId: item.sessionId, status: item.status, summary: item.resultSummary ?? null })), receipts, outcomes: executions.flatMap(item => { const outcome = getOwnerPlanningRunOutcome(item.id); return outcome ? [outcome] : [] }) }]
  })
}
export function registerProjectOwnerRuntimeIpcHandlers(ipc: Registrar): void {
  ipc.handle(PROJECT_IPC_CHANNELS.GET_OWNER_RUNTIME_BINDING, (_, request) => result(() => { const value = fields(request, ['projectId']); return getOwnerRuntimeBinding(value.projectId as string) }))
  ipc.handle(PROJECT_IPC_CHANNELS.SAVE_OWNER_RUNTIME_BINDING, (_, request) => result(() => { const value = fields(request, ['projectId', 'expectedRevision', 'input']); if (typeof value.expectedRevision !== 'number') throw new Error('Owner绑定版本无效'); return saveOwnerRuntimeBinding(value.projectId as string, value.expectedRevision, value.input) }))
  ipc.handle(PROJECT_IPC_CHANNELS.PREPARE_OWNER_PLANNING, (_, request) => result(() => { const value = fields(request, ['projectId', 'input']); return prepareOwnerPlanning(value.projectId as string, value.input) }))
  ipc.handle(PROJECT_IPC_CHANNELS.LIST_OWNER_PLANNING_RUNS, (_, request) => result(() => { const value = fields(request, ['projectId', 'taskId']); return listOwnerPlanningRuns(value.projectId as string, value.taskId as string | undefined) }))
}
