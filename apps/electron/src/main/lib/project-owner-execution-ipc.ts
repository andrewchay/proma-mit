/** 四个业务准备入口，全部无收费/授权发行/任务派发副作用。 */
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
}
