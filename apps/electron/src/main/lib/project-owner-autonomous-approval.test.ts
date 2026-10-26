import { expect, test } from 'bun:test'
import type { OwnerExecutionGrantIssuePreview } from '@gravitas/shared'
import { requestOwnerAutonomousGrantApproval } from './project-owner-autonomous-approval'

const preview: OwnerExecutionGrantIssuePreview = {
  projectId: 'project-1',
  dispatchMode: 'autonomous',
  policyRevision: 2,
  revalidationId: 'revalidation-1',
  revalidationRevision: 3,
  revalidationIntegrityHash: 'r'.repeat(64),
  materializationId: 'materialization-1',
  materializationRevision: 4,
  materializationIntegrityHash: 'm'.repeat(64),
  sourceHash: 's'.repeat(64),
  executorEmployeeId: 'executor-1',
  reviewerEmployeeId: 'reviewer-1',
  workspaceId: 'workspace-1',
  channelId: 'channel-1',
  modelId: 'model-1',
  runtime: 'ai-sdk',
  budget: { maxCostMicros: 500000, maxRuns: 4, maxRework: 1, expiresAt: 4070952000000 },
  blockers: [],
  approvalFingerprint: 'a'.repeat(64),
}
const window = { isDestroyed: () => false, isVisible: () => true }
test('Given autonomous grant When native dialog is accepted Then scope and limits are explicitly presented', async () => {
  let shown: { detail: string; buttons: string[]; defaultId: number; cancelId: number } | null = null
  await requestOwnerAutonomousGrantApproval({ projectId: 'project-1' }, preview, {
    getParent: () => window,
    showMessageBox: async (_parent, options) => {
      shown = options
      return { response: 1 }
    },
  })
  expect(shown).not.toBeNull()
  expect(shown!.detail).toContain('materialization-1')
  expect(shown!.detail).toContain('executor-1')
  expect(shown!.detail).toContain('500000 微美元')
  expect(shown!.detail).toContain('不是 Provider 端的硬性费用上限')
  expect(shown!.buttons).toEqual(['取消', '启用自主调度'])
  expect(shown!.defaultId).toBe(0)
  expect(shown!.cancelId).toBe(0)
})
test('Given no visible parent or native cancel When autonomous approval is requested Then reject', async () => {
  await expect(requestOwnerAutonomousGrantApproval({ projectId: 'project-1' }, preview, {
    getParent: () => null,
    showMessageBox: async () => ({ response: 1 }),
  })).rejects.toThrow('无可见主窗口')
  await expect(requestOwnerAutonomousGrantApproval({ projectId: 'project-1' }, preview, {
    getParent: () => window,
    showMessageBox: async () => ({ response: 0 }),
  })).rejects.toThrow('已取消自主调度授权')
})
