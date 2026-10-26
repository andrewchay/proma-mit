/** 四个暂停Task关联入口，没有费用、发行、自动派工或外部同步。 */
import { PROJECT_IPC_CHANNELS, type ProjectOwnerGoalResult } from '@gravitas/shared'
import {
  getOwnerTaskMaterialization,
  listOwnerTaskMaterializationHistory,
  previewOwnerTaskMaterialization,
  materializeOwnerTasks,
} from './project-owner-task-materialization'
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
        message: error instanceof Error ? error.message : 'Owner暂停任务关联操作失败',
      },
    }
  }
}
export function registerProjectOwnerTaskIpcHandlers(ipc: Registrar): void {
  for (const [channel, operation] of [
    [PROJECT_IPC_CHANNELS.GET_OWNER_TASK_MATERIALIZATION, getOwnerTaskMaterialization],
    [
      PROJECT_IPC_CHANNELS.LIST_OWNER_TASK_MATERIALIZATION_HISTORY,
      listOwnerTaskMaterializationHistory,
    ],
  ] as const) {
    ipc.handle(channel, (_, request) =>
      result(() => operation(parseOwnerExecutionSubject(request))),
    )
  }
  ipc.handle(PROJECT_IPC_CHANNELS.PREVIEW_OWNER_TASK_MATERIALIZATION, (_, request) =>
    result(() => {
      const value = ownerExecutionObject(request, ['projectId', 'taskId', 'input'])
      return previewOwnerTaskMaterialization(
        parseOwnerExecutionSubject({
          projectId: value.projectId,
          ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
        }),
        value.input,
      )
    }),
  )
  ipc.handle(PROJECT_IPC_CHANNELS.MATERIALIZE_OWNER_TASKS, (_, request) =>
    result(() => {
      const value = ownerExecutionObject(request, [
        'projectId',
        'taskId',
        'input',
        'previewFingerprint',
      ])
      return materializeOwnerTasks(
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
