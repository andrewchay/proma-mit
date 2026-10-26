import { expect, mock, test } from 'bun:test'
import { PROJECT_IPC_CHANNELS } from '@gravitas/shared'

const preview = { approvalFingerprint: 'approved-fingerprint', blockers: [] }
const revalidation = { status: 'current', revalidation: { id: 'revalidation-1' } }
const plan = { state: 'confirmed', planVersion: 2 }
const context = { sources: { project: { title: '项目标题' } } }
const summary = { projectTitle: '项目标题', deliverables: ['交付成果'], knowledgeNames: [], allowedPaths: [] }
let approvalSummary: unknown
let scheduledProjectId = ''
const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()

mock.module('./project-owner-execution-grant-issue', () => ({
  confirmOwnerExecutionGrantIssue: () => ({ grantId: 'grant-1' }),
  confirmOwnerExecutionGrantRevoke: () => ({}),
  getOwnerExecutionGrant: () => null,
  listOwnerExecutionGrantHistory: () => [],
  previewOwnerExecutionGrantIssue: () => preview,
  previewOwnerExecutionGrantRevoke: () => ({}),
}))
mock.module('./project-owner-execution-source', () => ({
  OwnerExecutionPreparationConflictError: class extends Error {},
  ownerExecutionObject: (input: unknown) => input as Record<string, unknown>,
  ownerExecutionHash: () => 'same-hash',
  parseOwnerExecutionSubject: (input: unknown) => input,
}))
mock.module('./project-owner-autonomous-approval', () => ({
  requestOwnerAutonomousGrantApproval: async (_subject: unknown, _preview: unknown, _dependencies: unknown, value: unknown) => { approvalSummary = value },
}))
mock.module('./project-owner-autonomous-approval-summary', () => ({
  buildOwnerAutonomousApprovalSummary: (...args: unknown[]) => {
    expect(args[2]).toBe(revalidation)
    expect(args[3]).toBe(plan)
    expect(args[4]).toBe(context)
    return summary
  },
}))
mock.module('./project-owner-execution-revalidation', () => ({ getOwnerExecutionRevalidation: () => revalidation }))
mock.module('./project-owner-plan-service', () => ({
  getProjectOwnerPlanDraft: () => plan,
  getProjectOwnerPlanningContext: () => context,
}))
mock.module('./project-owner-autonomous-scheduler', () => ({
  runOwnerAutonomousSchedule: async (projectId: string) => { scheduledProjectId = projectId },
}))

const { registerProjectOwnerExecutionGrantIpcHandlers } = await import('./project-owner-execution-grant-ipc')
registerProjectOwnerExecutionGrantIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } })

test('Given Owner已确认的结果范围 When确认执行 Then主进程用冻结来源摘要确认后才签发并启动', async () => {
  const result = await handlers.get(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_ISSUE)!(undefined, {
    projectId: 'project-1',
    input: { dispatchMode: 'autonomous' },
    preview,
    confirmedFingerprint: 'approved-fingerprint',
  })
  expect(result).toEqual({ ok: true, value: { grantId: 'grant-1' } })
  expect(approvalSummary).toBe(summary)
  expect(scheduledProjectId).toBe('project-1')
})
