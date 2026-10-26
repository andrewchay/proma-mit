/** GLM v6 零工具请求按实际可发送字节设上界；超出时拒绝发送，不截断成果。 */
export const OWNER_PLANNING_V6_MAX_REQUEST_BYTES = 65_536
// UTF-8 字节数作为保守 token 上界，另留协议分隔开销；不是实际费用结算。
export const OWNER_PLANNING_V6_INPUT_TOKEN_CEILING = OWNER_PLANNING_V6_MAX_REQUEST_BYTES + 1024

export function usesBoundedOwnerPlanningEnvelope(modelId: string, provider: string): boolean {
  return provider === 'zhipu' && /^glm-5\.3(?:-flash|-flashx)?$/i.test(modelId)
}

export function assertOwnerPlanningRequestEnvelope(body: string, modelId: string, provider: string): void {
  if (usesBoundedOwnerPlanningEnvelope(modelId, provider) && Buffer.byteLength(body, 'utf8') > OWNER_PLANNING_V6_MAX_REQUEST_BYTES) {
    throw new Error('Owner v6 请求超过已冻结的64KiB输入包络；保留完整成果，未截断或发送')
  }
}
