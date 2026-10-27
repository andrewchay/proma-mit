/** Owner执行授权账本入口。自主模式只有在主进程原生确认后才可由主进程Scheduler派发。 */
import { PROJECT_IPC_CHANNELS, type OwnerExecutionGrantIssuePreview, type ProjectOwnerGoalResult } from '@gravitas/shared'
import {
  confirmOwnerExecutionGrantIssue,
  confirmOwnerExecutionGrantRevoke,
  getOwnerExecutionGrant,
  listOwnerExecutionGrantHistory,
  previewOwnerExecutionGrantIssue,
  previewOwnerExecutionGrantRevoke,
} from './project-owner-execution-grant-issue'
import {
  OwnerExecutionPreparationConflictError,
  ownerExecutionObject,
  ownerExecutionHash,
  parseOwnerExecutionSubject,
} from './project-owner-execution-source'
import { requestOwnerAutonomousGrantApproval } from './project-owner-autonomous-approval'
import { buildOwnerAutonomousApprovalSummary } from './project-owner-autonomous-approval-summary'
import { getOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { getProjectOwnerPlanDraft, getProjectOwnerPlanningContext } from './project-owner-plan-service'
import { runOwnerAutonomousSchedule } from './project-owner-autonomous-scheduler'
interface Registrar {
  handle: (channel: string, handler: (event: unknown, request: unknown) => unknown) => void
}
async function result<T>(operation: () => T | Promise<T>): Promise<ProjectOwnerGoalResult<Awaited<T>>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof OwnerExecutionPreparationConflictError ? 'conflict' : 'failed',
        message: error instanceof Error ? error.message : 'Owner授权账本操作失败',
      },
    }
  }
}
function subjectOf(value: Record<string, unknown>) {
  return parseOwnerExecutionSubject({
    projectId: value.projectId,
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
  })
}
export function registerProjectOwnerExecutionGrantIpcHandlers(ipc: Registrar): void {
  for (const [channel, operation] of [
    [PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_GRANT, getOwnerExecutionGrant],
    [PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_GRANT_HISTORY, listOwnerExecutionGrantHistory],
  ] as const) {
    ipc.handle(channel, (_, request) => result(() => operation(parseOwnerExecutionSubject(request))))
  }
  ipc.handle(PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_GRANT_ISSUE, (_, request) =>
    result(() => {
      const value = ownerExecutionObject(request, ['projectId', 'taskId', 'input'])
      return previewOwnerExecutionGrantIssue(subjectOf(value), value.input)
    }),
  )
  ipc.handle(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_ISSUE, (_, request) =>
    result(async () => {
      const value = ownerExecutionObject(request, [
        'projectId',
        'taskId',
        'input',
        'preview',
        'confirmedFingerprint',
      ])
      const subject = subjectOf(value)
      if (typeof value.confirmedFingerprint !== 'string') throw new Error('Owner发行确认指纹无效')
      if (typeof value.input !== 'object' || value.input === null || Array.isArray(value.input)) throw new Error('Owner发行输入无效')
      const input = value.input as Record<string, unknown>
      if ((input.dispatchMode ?? 'manual') === 'autonomous') {
        const current = previewOwnerExecutionGrantIssue(subject, input) as OwnerExecutionGrantIssuePreview
        if (typeof value.preview !== 'object' || value.preview === null || Array.isArray(value.preview)
          || ownerExecutionHash(current) !== ownerExecutionHash(value.preview)
          || value.confirmedFingerprint !== current.approvalFingerprint) {
          throw new Error('自主调度授权摘要已变化，请重新预览')
        }
        const summary = buildOwnerAutonomousApprovalSummary(
          subject,
          current,
          getOwnerExecutionRevalidation(subject),
          getProjectOwnerPlanDraft(subject.projectId, subject.taskId),
          getProjectOwnerPlanningContext(subject.projectId, subject.taskId),
        )
        await requestOwnerAutonomousGrantApproval(subject, current, undefined, summary)
        const grant = confirmOwnerExecutionGrantIssue(subject, {
          input,
          preview: current,
          confirmedFingerprint: value.confirmedFingerprint,
        })
        await runOwnerAutonomousSchedule(subject.projectId)
        return grant
      }
      return confirmOwnerExecutionGrantIssue(subject, {
        input: value.input,
        preview: value.preview,
        confirmedFingerprint: value.confirmedFingerprint,
      })
    }),
  )
  ipc.handle(PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_GRANT_REVOKE, (_, request) =>
    result(() => {
      const value = ownerExecutionObject(request, ['projectId', 'taskId', 'grantId'])
      return previewOwnerExecutionGrantRevoke(subjectOf(value), { grantId: value.grantId })
    }),
  )
  ipc.handle(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_REVOKE, (_, request) =>
    result(() => {
      const value = ownerExecutionObject(request, [
        'projectId',
        'taskId',
        'grantId',
        'confirmedFingerprint',
      ])
      return confirmOwnerExecutionGrantRevoke(subjectOf(value), {
        grantId: value.grantId,
        confirmedFingerprint: value.confirmedFingerprint,
      })
    }),
  )
}
