import { expect, test } from 'bun:test'
import type {
  OwnerExecutionGrantIssuePreview,
  OwnerExecutionRevalidationRecord,
  OwnerExecutionRevalidationView,
  ProjectOwnerPlanDraft,
  ProjectOwnerPlanningContext,
} from '@gravitas/shared'
import { ownerExecutionHash } from './project-owner-execution-source'
import { buildOwnerAutonomousApprovalSummary } from './project-owner-autonomous-approval-summary'

function fixture() {
  const subject = { projectId: 'project-1' }
  const plan = {
    projectId: 'project-1',
    state: 'confirmed',
    planVersion: 3,
    goalRevision: 2,
    planFingerprint: 'plan-hash',
    contextFingerprint: 'context-hash',
    proposal: { steps: [
      { key: 'spec', title: '产品规则', outcome: '形成规则说明', acceptanceCriteria: ['规则覆盖主要场景'] },
      { key: 'build', title: '实现页面', outcome: '交付可运行页面', acceptanceCriteria: ['可按说明完成体验'] },
    ] },
  } as ProjectOwnerPlanDraft
  const context = {
    goal: { revision: 2 },
    fingerprint: 'context-hash',
    sources: { project: { id: 'project-1', title: '产品改进', description: '' } },
  } as ProjectOwnerPlanningContext
  const source = {
    schemaVersion: 2,
    stage: 'paused_task_links',
    projectId: 'project-1',
    materialization: { id: 'materialization-1', revision: 1, integrityHash: 'materialization-hash' },
    originalPreparation: { id: 'preparation-1', revision: 1, integrityHash: 'preparation-hash', policyRevision: 1 },
    planRevision: 4,
    planVersion: 3,
    planFingerprint: 'plan-hash',
    contextFingerprint: 'context-hash',
    selectedStepKeys: ['build'],
    tasks: [{ taskId: 'task-1', stepKey: 'build', linkId: 'link-1', linkKind: 'created', linkIntegrityHash: 'link-hash', taskSpecificationHash: 'task-hash', status: 'paused', assignee: { userId: 'user-1', displayName: 'User' }, workspaceId: 'workspace-1', developmentScope: { workspaceId: 'workspace-1', targetPaths: ['src/app.ts'], allowedPaths: ['src/app.ts'] }, dependencies: [] }],
    executor: { id: 'employee-1', name: '员工', configurationHash: 'executor-hash' },
    reviewer: { id: 'reviewer-1', name: '评审', configurationHash: 'reviewer-hash' },
    workspaceId: 'workspace-1',
    workspaceName: '工作区',
    workspaceHash: 'workspace-hash',
    channelId: 'channel-1',
    modelId: 'model-1',
    runtime: 'ai-sdk',
    channelHash: 'channel-hash',
    capabilityConfigurationHash: 'capability-hash',
    ownerBindingProvenance: { state: 'none' },
    knowledgeSources: [{ id: 'kb-1', name: '产品规范', knowledgeBaseIds: ['kb-1'], metadataHash: 'metadata-hash', contentHash: null }],
    budget: { maxCostMicros: 2_000_000, maxRuns: 5, maxRework: 1, expiresAt: 1_800_000_000_000 },
    executionKind: 'development',
    blockers: [],
  } as OwnerExecutionRevalidationRecord['source']
  const record = { id: 'revalidation-1', projectId: 'project-1', revision: 5, source, integrityHash: 'integrity-hash' } as OwnerExecutionRevalidationRecord
  const preview = {
    projectId: 'project-1',
    revalidationId: record.id,
    revalidationRevision: record.revision,
    revalidationIntegrityHash: record.integrityHash,
    sourceHash: ownerExecutionHash(source),
  } as OwnerExecutionGrantIssuePreview
  const view: OwnerExecutionRevalidationView = { revision: 5, status: 'current', revalidation: record, blockers: [] }
  return { subject, plan, context, source, record, preview, view }
}

test('授权确认摘要只显示冻结范围内的交付、资料和代码路径', () => {
  const f = fixture()
  expect(buildOwnerAutonomousApprovalSummary(f.subject, f.preview, f.view, f.plan, f.context)).toEqual({
    projectTitle: '产品改进',
    deliverables: ['实现页面：交付可运行页面；验收标准：可按说明完成体验'],
    knowledgeNames: ['产品规范'],
    allowedPaths: ['src/app.ts'],
  })
})

test('授权或结果来源过期时拒绝构造确认摘要', () => {
  const f = fixture()
  expect(() => buildOwnerAutonomousApprovalSummary(f.subject, f.preview, { ...f.view, status: 'stale' }, f.plan, f.context)).toThrow('无法生成开始确认摘要')
  expect(() => buildOwnerAutonomousApprovalSummary(f.subject, { ...f.preview, sourceHash: '0'.repeat(64) }, f.view, f.plan, f.context)).toThrow('无法生成开始确认摘要')
  expect(() => buildOwnerAutonomousApprovalSummary(f.subject, f.preview, f.view, { ...f.plan, planFingerprint: 'changed' }, f.context)).toThrow('无法生成开始确认摘要')
})
