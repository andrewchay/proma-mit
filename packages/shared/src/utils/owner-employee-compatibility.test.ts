import { expect, test } from 'bun:test'
import { supportsOwnerExecutionKind, supportsOwnerMixedTeam, ownerExecutionModelSummary } from './owner-employee-compatibility'

test('Given员工现有档案 When判断Owner候选 Then普通员工须后端明确适配且不能冒充研发配置', () => {
  expect(supportsOwnerExecutionKind({ executionProfile: 'controlled' }, 'controlled')).toBe(true)
  expect(supportsOwnerExecutionKind({ executionProfile: 'general' }, 'controlled')).toBe(false)
  expect(supportsOwnerExecutionKind({ executionProfile: 'general', ownerControlledCompatible: true }, 'controlled')).toBe(true)
  expect(supportsOwnerExecutionKind({ executionProfile: 'development', ownerControlledCompatible: true }, 'controlled')).toBe(true)
  expect(supportsOwnerExecutionKind({ executionProfile: 'development' }, 'controlled')).toBe(false)
  expect(supportsOwnerExecutionKind({ executionProfile: 'general', ownerControlledCompatible: true }, 'development')).toBe(false)
})


test('Given逐员工审核状态与模型 When展示与判断 Then不把主执行模型冒充全队模型', () => {
  expect(supportsOwnerMixedTeam([{ ownerMixedRuntimeCompatible: true }, { ownerMixedRuntimeCompatible: true }])).toBe(true)
  expect(supportsOwnerMixedTeam([{ ownerMixedRuntimeCompatible: true }, undefined])).toBe(false)
  expect(supportsOwnerMixedTeam([])).toBe(false)
  expect(ownerExecutionModelSummary({ modelId: 'legacy' })).toBe('legacy')
  expect(ownerExecutionModelSummary({ modelId: 'primary', employeeRuntimes: [{ employeeName: '调研', modelId: 'glm' }, { employeeName: '独立检查', modelId: 'deepseek' }] })).toBe('调研：glm；独立检查：deepseek')
})
