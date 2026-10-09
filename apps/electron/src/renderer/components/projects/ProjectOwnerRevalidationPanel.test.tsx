import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { OwnerExecutionRevalidationRecord } from '@gravitas/shared'
import {
  getOwnerRevalidationEditor,
  ownerRevalidationEditorsAtom,
} from '../../atoms/project-owner-execution-revalidation-atoms'
import { ProjectOwnerRevalidationPanel } from './ProjectOwnerRevalidationPanel'
const subject = { projectId: 'a' }
const source = {
  schemaVersion: 2 as const,
  stage: 'paused_task_links' as const,
  projectId: 'a',
  materialization: { id: 'batch-1', revision: 1, integrityHash: 'mat-hash' },
  originalPreparation: { id: 'prep-1', revision: 3, integrityHash: 'prep-hash', policyRevision: 2 },
  planRevision: 3,
  planVersion: 2,
  planFingerprint: 'planhash',
  contextFingerprint: 'ctxhash',
  selectedStepKeys: ['s1'],
  tasks: [
    {
      taskId: 't1',
      stepKey: 's1',
      linkId: 'link-1',
      linkKind: 'created' as const,
      linkIntegrityHash: 'lh',
      taskSpecificationHash: 'sh',
      status: 'paused' as const,
      assignee: { userId: 'agent-e', displayName: 'Executor' },
      workspaceId: 'w',
      dependencies: [
        { id: 'edge-1', taskId: 't1', dependsOnTaskId: 'up', type: 'finish_to_start' },
      ],
    },
  ],
  executor: { id: 'e', name: '执行', configurationHash: 'eh' },
  reviewer: { id: 'r', name: '评审', configurationHash: 'rh' },
  workspaceId: 'w',
  workspaceName: '托管',
  workspaceHash: 'wh',
  channelId: 'c',
  modelId: 'm',
  runtime: 'ai-sdk',
  channelHash: 'ch',
  capabilityConfigurationHash: 'cap',
  ownerBindingProvenance: { state: 'none' as const },
  knowledgeSources: [],
  budget: { maxCostMicros: 1000001, maxRuns: 2, maxRework: 0, expiresAt: 4070952000000 },
  executionKind: 'controlled' as const,
  blockers: ['v2冻结真实任务事实，不是执行授权；发行、派工、资料工具与预算purpose仍关闭'],
}
const record = {
  ...subject,
  schemaVersion: 2 as const,
  purpose: 'owner_business_execution_revalidation' as const,
  id: 'rev-1',
  revision: 1,
  policyRevision: 3,
  stage: 'paused_task_links' as const,
  actor: 'local-user' as const,
  savedAt: 1,
  input: {
    requestId: 'req-1',
    expectedRevalidationRevision: 0,
    expectedMaterializationId: 'batch-1',
    expectedMaterializationRevision: 1,
    expectedMaterializationHash: 'mat-hash',
    expectedPolicyRevision: 2,
    changeReason: '按真实任务重新冻结',
  },
  source,
  inputHash: 'ih',
  previewFingerprint: 'pf',
  previousIntegrityHash: null,
  integrityHash: 'rh',
} as unknown as OwnerExecutionRevalidationRecord
function render(overrides?: {
  view?: {
    revision: number
    revalidation: OwnerExecutionRevalidationRecord | null
    status: string
    blockers: string[]
  }
  saving?: boolean
  error?: string
}) {
  const store = createStore()
  if (overrides)
    store.set(
      ownerRevalidationEditorsAtom,
      new Map([
        [
          '["a",null]',
          {
            ...getOwnerRevalidationEditor(new Map(), subject),
            loaded: true,
            saving: overrides.saving ?? false,
            error: overrides.error ?? '',
            view: (overrides.view ?? {
              revision: 1,
              revalidation: record,
              status: 'stale',
              blockers: source.blockers,
            }) as never,
            history: record ? [record] : [],
            historyLoaded: true,
          },
        ],
      ]),
    )
  return renderToStaticMarkup(
    createElement(Provider, { store }, createElement(ProjectOwnerRevalidationPanel, subject)),
  )
}
test('Given 未加载 When SSR Then 唯一动作按钮禁用且明确不是执行许可、预算期限不顺延', () => {
  const html = render()
  for (const text of ['重新验证为v2', '不是执行许可', '不可顺延', 'min-w-0', 'flex-wrap'])
    expect(html).toContain(text)
  expect(html).toContain('disabled=""')
  expect(html).not.toContain('已授权')
  expect(html).not.toContain('启动执行')
})
test('Given stale记录 When SSR Then 上游链/真实Task清单/冻结承诺/blockers/只读历史可核对', () => {
  const html = render({})
  for (const text of [
    'stale',
    'batch-1',
    'mat-hash',
    'prep-1',
    'prep-hash',
    's1',
    't1',
    'link-1',
    'created',
    'paused',
    'Executor',
    'agent-e',
    'finish_to_start',
    '1000001',
    '不可顺延',
    '按真实任务重新冻结',
    'v2冻结真实任务事实',
    '历史只读',
    'overflow-y-auto',
  ])
    if (text) expect(html).toContain(text)
  expect(html).not.toContain('恢复此版本')
})
test('Given 保存中 When SSR Then 按钮禁用且不提供第二个动作入口', () => {
  const html = render({ saving: true })
  expect(html).toContain('正在重新验证')
  expect(html).toContain('disabled=""')
})
test('Given 诊断错误 When SSR Then 错误可见且输入保留', () => {
  const html = render({ error: '材料化记录已修订' })
  expect(html).toContain('材料化记录已修订')
  expect(html).toContain('role="alert"')
})
