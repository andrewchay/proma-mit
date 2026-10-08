import type { SDKResultMessage } from '@gravitas/shared'
/** 仅Owner失败留证，不转换成成功，不请求下一次模型。 */
export class OwnerPlanningRuntimeError extends Error {
  constructor(public readonly runtimeResult: SDKResultMessage, cause: unknown) { super(cause instanceof Error ? cause.message : 'Owner规划Runtime异常', { cause }); this.name = 'OwnerPlanningRuntimeError' }
}
