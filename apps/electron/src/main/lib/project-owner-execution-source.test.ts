import { expect, test } from 'bun:test'
import { parseOwnerExecutionInput } from './project-owner-execution-source'

function input(executionKind: 'development' | 'controlled', extra: Record<string, unknown> = {}) {
  return { requestId: 'prepare-1', expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2,
    selectedStepKeys: ['fix'], executionKind, ...(executionKind === 'development' ? { developmentScope: { workspaceId: 'workspace-1', targetPaths: ['src/app.ts'], allowedPaths: ['src/'], verificationCommands: ['bun test'] } } : {}),
    executorEmployeeId: 'executor-1', reviewerEmployeeId: 'reviewer-1', roleAssignments: [{ roleKey: 'developer', employeeId: 'executor-1' }],
    workspaceId: 'workspace-1', knowledgeSourceIds: [], maxCostMicros: 1000, maxRuns: 2, maxRework: 1, expiresAt: Date.now() + 60_000, changeReason: 'Owner质量管理', ...extra }
}

test('Given代码执行准备明确委托质量决定 When解析冻结输入 Then允许代码成果契约且不伪造文本交付', () => {
  expect(parseOwnerExecutionInput(input('development', { qualityManagementVersion: 1 }))).toMatchObject({ executionKind: 'development', qualityManagementVersion: 1 })
  expect(() => parseOwnerExecutionInput(input('controlled', { qualityManagementVersion: 1 }))).toThrow('完整成果')
})
