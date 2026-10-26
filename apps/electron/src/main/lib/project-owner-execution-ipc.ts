/** Owner业务准备与显式命令入口；人工模式逐条确认，自主模式仅由主进程Scheduler派发。 */
import { randomUUID } from 'node:crypto'
import { PROJECT_IPC_CHANNELS, type ProjectOwnerGoalResult } from '@gravitas/shared'
import {
  getOwnerExecutionPreparation,
  listOwnerExecutionPreparationHistory,
  previewOwnerExecutionPreparation,
  saveOwnerExecutionPreparation,
} from './project-owner-execution-preparation'
import {
  OwnerExecutionPreparationConflictError,
  ownerExecutionObject,
  parseOwnerExecutionSubject,
} from './project-owner-execution-source'
import { listOwnerExecutionCommands, previewOwnerExecutionCommandAck, reserveAndQueueOwnerCommand } from './project-owner-execution-command'
import { dispatchOwnerCommandExecution } from './project-owner-execution-dispatcher'
import { cancelQueuedOwnerCommand } from './project-owner-execution-stop'
import { confirmOwnerPreflightReconciliation, previewOwnerPreflightReconciliation } from './project-owner-execution-preflight-reconciliation'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { getOwnerAutonomousScheduleStatus } from './project-owner-autonomous-scheduler'
import * as store from './project-sqlite-store'
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
        message: error instanceof Error ? error.message : 'Owner执行准备操作失败',
      },
    }
  }
}
export function registerProjectOwnerExecutionIpcHandlers(ipc: Registrar): void {
  for (const [channel, operation] of [
    [PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_PREPARATION, getOwnerExecutionPreparation],
    [
      PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_PREPARATION_HISTORY,
      listOwnerExecutionPreparationHistory,
    ],
  ] as const) {
    ipc.handle(channel, (_, request) =>
      result(() => operation(parseOwnerExecutionSubject(request))),
    )
  }
  ipc.handle(PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_PREPARATION, (_, request) =>
    result(() => {
      const value = ownerExecutionObject(request, ['projectId', 'taskId', 'input'])
      return previewOwnerExecutionPreparation(
        parseOwnerExecutionSubject({
          projectId: value.projectId,
          ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
        }),
        value.input,
      )
    }),
  )
  ipc.handle(PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_PREPARATION, (_, request) =>
    result(() => {
      const value = ownerExecutionObject(request, [
        'projectId',
        'taskId',
        'input',
        'previewFingerprint',
      ])
      return saveOwnerExecutionPreparation(
        parseOwnerExecutionSubject({
          projectId: value.projectId,
          ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
        }),
        value.input,
        value.previewFingerprint as string,
      )
    }),
  )
  ipc.handle(PROJECT_IPC_CHANNELS.GET_OWNER_AUTONOMOUS_SCHEDULE_STATUS, (_, request) =>
    result(() => getOwnerAutonomousScheduleStatus(parseOwnerExecutionSubject(request).projectId)),
  )
  ipc.handle(PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_COMMAND_ACK, (_, request) =>
    result(() => {
      const value = ownerExecutionObject(request, ['projectId', 'taskId', 'input'])
      return previewOwnerExecutionCommandAck({ projectId: value.projectId, ...(value.taskId === undefined ? {} : { taskId: value.taskId }) }, value.input)
    }),
  )
  ipc.handle(PROJECT_IPC_CHANNELS.QUEUE_OWNER_EXECUTION_COMMAND, (_, request) =>
    result(() => {
      const value = ownerExecutionObject(request, ['projectId', 'taskId', 'input', 'acknowledgement'])
      const input = ownerExecutionObject(value.input, ['requestId', 'grantId', 'taskId', 'role', 'reworkOrdinal', 'expectedRevalidationRevision'])
      if (typeof input.requestId !== 'string' || !input.requestId.trim()) throw new Error('Owner命令requestId无效')
      const grantId = input.grantId
      if (typeof grantId !== 'string' || !grantId.trim()) throw new Error('Owner命令grantId无效')
      const previous = store.getProjectDb().prepare('SELECT id, execution_id FROM project_owner_execution_commands WHERE grant_id=? AND idempotency_key=?').get(grantId, input.requestId) as { id: string; execution_id: string | null } | undefined
      return reserveAndQueueOwnerCommand(
        { projectId: value.projectId, ...(value.taskId === undefined ? {} : { taskId: value.taskId }) },
        { commandId: previous?.id ?? randomUUID(), grantId, taskId: input.taskId, role: input.role, reworkOrdinal: input.reworkOrdinal, expectedRevalidationRevision: input.expectedRevalidationRevision, idempotencyKey: input.requestId },
        value.acknowledgement,
        { executionId: previous?.execution_id ?? randomUUID() },
      )
    }),
  )
  ipc.handle(PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_COMMANDS, (_, request) =>
    result(() => listOwnerExecutionCommands(parseOwnerExecutionSubject(request))),
  )
  ipc.handle(PROJECT_IPC_CHANNELS.DISPATCH_OWNER_EXECUTION_COMMAND, (_, request) =>
    result(() => dispatchOwnerCommandExecution(ownerExecutionObject(request, ['commandId', 'ackFingerprint', 'acknowledgeExecution']))),
  )
  ipc.handle(PROJECT_IPC_CHANNELS.CANCEL_QUEUED_OWNER_EXECUTION_COMMAND, (_, request) => result(() => {
    assertLocalActorEnabled()
    const value = ownerExecutionObject(request, ['commandId'])
    if (typeof value.commandId !== 'string' || !value.commandId.trim()) throw new Error('Owner命令ID无效')
    cancelQueuedOwnerCommand(value.commandId)
    return { commandId: value.commandId }
  }))
  ipc.handle(PROJECT_IPC_CHANNELS.PREVIEW_OWNER_PREFLIGHT_RECONCILIATION, (_, request) => result(() => {
    const value = ownerExecutionObject(request, ['projectId', 'taskId', 'commandId'])
    const subject = parseOwnerExecutionSubject({ projectId: value.projectId, ...(value.taskId === undefined ? {} : { taskId: value.taskId }) })
    return previewOwnerPreflightReconciliation(subject, { commandId: value.commandId })
  }))
  ipc.handle(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_PREFLIGHT_RECONCILIATION, (_, request) => result(() => {
    const value = ownerExecutionObject(request, ['projectId', 'taskId', 'commandId', 'confirmedFingerprint', 'providerConsoleCheckedNoUsage'])
    const subject = parseOwnerExecutionSubject({ projectId: value.projectId, ...(value.taskId === undefined ? {} : { taskId: value.taskId }) })
    return confirmOwnerPreflightReconciliation(subject, {
      commandId: value.commandId,
      confirmedFingerprint: value.confirmedFingerprint,
      providerConsoleCheckedNoUsage: value.providerConsoleCheckedNoUsage,
    })
  }))
}
