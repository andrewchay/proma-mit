import { expect, test } from 'bun:test'
import type { OwnerExecutionGrantIssuePreview } from '@gravitas/shared'
import { requestOwnerAutonomousGrantApproval } from './project-owner-autonomous-approval'

const preview: OwnerExecutionGrantIssuePreview = {
  projectId: 'project-1',
  dispatchMode: 'autonomous',
  executionKind: 'controlled',
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
test('Given项目Owner执行确认 When显示结果导向授权摘要 Then保留结果和范围但隐藏员工与内部次数', async () => {
  let detail = ''
  const dialogs: Array<{ title: string; message: string; buttons: string[] }> = []
  await requestOwnerAutonomousGrantApproval({ projectId: 'project-1' }, preview, {
    getParent: () => window,
    showMessageBox: async (_parent, options) => {
      detail = options.detail
      dialogs.push(options)
      return { response: 1 }
    },
  }, {
    projectTitle: '季度研究交付',
    deliverables: ['完成需求与风险报告'],
    knowledgeNames: ['已授权资料'],
    allowedPaths: ['docs/report.md'],
  })
  expect(detail).toContain('预期成果：完成需求与风险报告')
  expect(detail).toContain('补充资料：已授权资料')
  expect(detail).toContain('允许修改：docs/report.md')
  expect(detail).toContain('项目共享预算上限：0.5 美元')
  expect(detail).not.toContain('最多 4 次运行')
  expect(detail).not.toContain('1 次返工')
  expect(detail).not.toContain('executor-1')
  expect(detail).not.toContain('reviewer-1')
  expect(detail).not.toContain('workspace-1')
  expect(detail).not.toContain('model-1')
  expect(dialogs).toHaveLength(1)
  expect(dialogs[0]!.title).toBe('确认开始项目执行')
  expect(dialogs[0]!.message).toContain('季度研究交付')
  expect(dialogs[0]!.buttons).toEqual(['取消', '确认并开始'])
})
test('Given授权摘要长于系统确认单行限制 When展示 Then明确标注内容已截短', async () => {
  let detail = ''
  await expect(requestOwnerAutonomousGrantApproval({ projectId: 'project-1' }, preview, {
    getParent: () => window,
    showMessageBox: async (_parent, options) => { detail = options.detail; return { response: 0 } },
  }, {
    projectTitle: '项目',
    deliverables: ['成果'.repeat(160)],
    knowledgeNames: [],
    allowedPaths: [],
  })).rejects.toThrow('已取消自主调度授权')
  expect(detail).toContain('…（已截短）')
  const deliverable = detail.split('\n').find(line => line.startsWith('预期成果：'))?.slice('预期成果：'.length)
  expect(deliverable?.length).toBe(300)
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
