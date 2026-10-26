/** v2重新验证四个只读/暂存入口；不注册任何active发行、派工或命令类通道。 */
import { PROJECT_IPC_CHANNELS, type ProjectOwnerGoalResult } from '@gravitas/shared'
import {
  getOwnerExecutionRevalidation,
  listOwnerExecutionRevalidationHistory,
  previewOwnerExecutionRevalidation,
  saveOwnerExecutionRevalidation,
} from './project-owner-execution-revalidation'
import {
  OwnerExecutionPreparationConflictError,
  ownerExecutionObject,
  parseOwnerExecutionSubject,
} from './project-owner-execution-source'
interface Registrar {
  handle: (channel: string, handler: (event: unknown, request: unknown) => unknown) => void
}
function result<T>(operation: () => T): ProjectOwnerGoalResult<T> {
  try {
    return { ok: true, value: operation() }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof OwnerExecutionPreparationConflictError ? 'conflict' : 'failed',
        message: error instanceof Error ? error.message : 'Owner重验证操作失败',
      },
    }
  }
}
export function registerProjectOwnerExecutionRevalidationIpcHandlers(ipc: Registrar): void {
  for (const [channel, operation] of [
    [PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_REVALIDATION, getOwnerExecutionRevalidation],
    [
      PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_REVALIDATION_HISTORY,
      listOwnerExecutionRevalidationHistory,
    ],
  ] as const) {
    ipc.handle(channel, (_, request) =>
      result(() => operation(parseOwnerExecutionSubject(request))),
    )
  }
  ipc.handle(PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_REVALIDATION, (_, request) =>
    result(() => {
      const value = ownerExecutionObject(request, ['projectId', 'taskId', 'input'])
      return previewOwnerExecutionRevalidation(
        parseOwnerExecutionSubject({
          projectId: value.projectId,
          ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
        }),
        value.input,
      )
    }),
  )
  ipc.handle(PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_REVALIDATION, (_, request) =>
    result(() => {
      const value = ownerExecutionObject(request, [
        'projectId',
        'taskId',
        'input',
        'previewFingerprint',
      ])
      return saveOwnerExecutionRevalidation(
        parseOwnerExecutionSubject({
          projectId: value.projectId,
          ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
        }),
        value.input,
        value.previewFingerprint as string,
      )
    }),
  )
}
