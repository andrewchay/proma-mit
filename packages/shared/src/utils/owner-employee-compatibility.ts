/** 候选适配说明，不是执行许可；后端仍重验真实配置、冻结来源与活动授权。 */
export function supportsOwnerExecutionKind(employee: { executionProfile: string; ownerControlledCompatible?: boolean }, kind: string): boolean {
  return employee.executionProfile === kind || kind === 'controlled' && ['general', 'development'].includes(employee.executionProfile) && employee.ownerControlledCompatible === true
}

/** 仅采用服务端审核过的运行/价格能力，不能凭模型名或默认配置放行。 */
export function supportsOwnerMixedTeam(employees: ReadonlyArray<{ ownerMixedRuntimeCompatible?: boolean } | undefined>): boolean {
  return employees.length > 0 && employees.every(item => item?.ownerMixedRuntimeCompatible === true)
}

export function ownerExecutionModelSummary(source: { modelId: string; employeeRuntimes?: ReadonlyArray<{ employeeName: string; modelId: string }> }): string {
  return source.employeeRuntimes?.length ? source.employeeRuntimes.map(item => `${item.employeeName}：${item.modelId}`).join('；') : source.modelId
}
