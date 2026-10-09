import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type {
  OwnerExecutionPreparationRecord,
  OwnerTaskMaterializationRecord,
} from '@gravitas/shared'
import { getOwnerTaskEditor, ownerTaskEditorsAtom } from '../../atoms/project-owner-task-atoms'
import { ProjectOwnerTaskMaterializationPanel } from './ProjectOwnerTaskMaterializationPanel'
const subject = { projectId: 'a', taskId: 'target' }
function render(record?: OwnerTaskMaterializationRecord) {
  const store = createStore()
  if (record)
    store.set(
      ownerTaskEditorsAtom,
      new Map([
        [
          '["a","target"]',
          {
            ...getOwnerTaskEditor(new Map(), subject),
            loaded: true,
            view: { revision: 5, materialization: record, status: 'stale', blockers: ['源已漂移'] },
            history: [record],
            historyLoaded: true,
            error: '需比较最新版本',
            refreshError: '任务列表刷新失败，保存未回滚',
          },
        ],
      ]),
    )
  return renderToStaticMarkup(
    createElement(
      Provider,
      { store },
      createElement(ProjectOwnerTaskMaterializationPanel, subject),
    ),
  )
}
test('Given 未加载准备 When SSR Then 唯一暂停命令禁用且零许可/费用、不提供自动派工', () => {
  const html = render()
  for (const text of [
    '只读预览暂停任务落地',
    '落为暂停任务',
    '授权 0',
    '费用预留 0',
    '技术Reviewer不是业务验收人',
    '不会派工',
    'min-w-0',
    'flex-wrap',
  ])
    expect(html).toContain(text)
  expect(html).toContain('disabled=""')
  expect(html).not.toContain('已授权')
})
test('Given singleTask历史 When 展示 Then 精确Task/step/edge/hash、before/after和只读历史可核对', () => {
  const prepInput = {
    requestId: 'prep',
    expectedPreparationRevision: 0,
    expectedPolicyRevision: null,
    expectedGoalRevision: 1,
    expectedPlanRevision: 3,
    selectedStepKeys: ['s1'],
    executionKind: 'controlled' as const,
    executorEmployeeId: 'e',
    reviewerEmployeeId: 'r',
    workspaceId: 'w',
    knowledgeSourceIds: [],
    maxCostMicros: 10,
    maxRuns: 1,
    maxRework: 0,
    expiresAt: 4070952000000,
    changeReason: '原因',
  }
  const preparation: OwnerExecutionPreparationRecord = {
    ...subject,
    schemaVersion: 1,
    stage: 'pending_task_links',
    actor: 'local-user',
    savedAt: 1,
    id: 'prep-id',
    revision: 4,
    policyRevision: 2,
    integrityHash: 'prep-hash',
    input: prepInput,
    inputHash: 'prep-input-hash',
    previousIntegrityHash: null,
    source: {
      ...subject,
      schemaVersion: 1,
      stage: 'pending_task_links',
      ownerBindingProvenance: { state: 'none' },
      goalRevision: 1,
      goalVersion: 1,
      planRevision: 3,
      planVersion: 2,
      planFingerprint: 'planhash',
      contextFingerprint: 'ctxhash',
      selectedStepKeys: ['s1'],
      executor: { id: 'e', name: 'Executor', configurationHash: 'eh' },
      reviewer: { id: 'r', name: 'Reviewer', configurationHash: 'rh' },
      workspaceId: 'w',
      workspaceName: '工作区',
      workspaceHash: 'wh',
      channelId: 'c',
      modelId: 'm',
      runtime: 'ai-sdk',
      channelHash: 'ch',
      capabilityConfigurationHash: 'cap',
      knowledgeSources: [],
      blockers: [],
      plan: {
        ...subject,
        schemaVersion: 1,
        revision: 3,
        planVersion: 2,
        goalRevision: 1,
        goalVersion: 1,
        state: 'confirmed',
        actor: 'local-user',
        origin: 'manual',
        savedAt: 1,
        changeReason: '原因',
        contextFingerprint: 'ctxhash',
        planFingerprint: 'planhash',
        sources: { project: { id: 'a', title: '项目', description: '' }, roles: [] },
        proposal: {
          ...subject,
          goalVersion: 1,
          mode: 'proposal_only',
          summary: '计划',
          assumptions: [],
          risks: [],
          steps: [],
        },
      },
    },
  }
  const input = {
    requestId: 'req',
    expectedMaterializationRevision: 0,
    expectedPreparationId: 'prep-id',
    expectedPreparationRevision: 4,
    expectedPreparationHash: 'prep-hash',
    expectedPolicyRevision: 2,
  }
  const projection = {
    stepKey: 's1',
    targetTaskId: 'target',
    title: '保留原任务标题',
    description: '保留原说明',
    roleKey: 'research',
    outcome: '成果',
    acceptanceCriteria: ['标准'],
    dependencies: ['upstream'],
    assignee: { userId: 'agent-e', displayName: 'Executor' },
    workspaceId: 'w',
    previous: {
      status: 'pending',
      assignee: { userId: 'old', displayName: '旧人员' },
      workspaceId: 'old-w',
    },
  }
  const record: OwnerTaskMaterializationRecord = {
    ...subject,
    schemaVersion: 1,
    purpose: 'owner_business_task_materialization',
    id: 'batch',
    revision: 5,
    actor: 'local-user',
    savedAt: 1,
    stage: 'paused_materialized_needs_revalidation',
    input,
    inputHash: 'ih',
    previousIntegrityHash: null,
    integrityHash: 'recordhash',
    preview: {
      ...subject,
      input,
      preparation,
      projections: [projection],
      targetTaskHash: 'before-target-hash',
      targetDependenciesHash: 'target-edge-hash',
      previewFingerprint: 'previewhash',
    },
    links: [
      {
        id: 'link-id',
        materializationId: 'batch',
        projectId: 'a',
        subjectKey: 'task:target',
        planFingerprint: 'planhash',
        stepKey: 's1',
        taskId: 'target',
        kind: 'existing_target',
        projection,
        taskSpecificationHash: 'after-spec-hash',
        dependencies: [
          {
            id: 'edge-id',
            taskId: 'target',
            dependsOnTaskId: 'upstream-task',
            type: 'finish_to_start',
          },
        ],
        integrityHash: 'linkhash',
      },
    ],
  }
  const html = render(record)
  for (const text of [
    's1',
    'target',
    'edge-id',
    'upstream-task',
    'finish_to_start',
    'before-target-hash',
    'after-spec-hash',
    'prep-hash',
    'planhash',
    'ctxhash',
    '岗位建议',
    'Executor',
    'Reviewer',
    '旧人员',
    'old-w',
    '变更前',
    '变更后',
    'paused',
    '标题与说明保留',
    '需要重新验证',
    '源已漂移',
    '未回滚',
    '历史只读',
    'overflow-y-auto',
  ])
    expect(html).toContain(text)
  expect(html).not.toContain('恢复历史')
  expect(html).not.toContain('启动执行')
})
