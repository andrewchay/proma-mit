import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { ProjectOwnerExecutionPreparationPanel } from './ProjectOwnerExecutionPreparationPanel'
test('Given 无confirmed计划 When 展示 Then 无自动选人且预览保存禁用、不是授权', () => {
  const html = renderToStaticMarkup(
    createElement(
      Provider,
      { store: createStore() },
      createElement(ProjectOwnerExecutionPreparationPanel, { projectId: 'a' }),
    ),
  )
  for (const text of [
    '保存暂停执行准备',
    '不会调用模型',
    '不是实际预留',
    '先选择',
    '微美元',
    '已保存且已确认',
  ])
    expect(html).toContain(text)
  expect(html).toContain('disabled=""')
  expect(html).not.toContain('已授权')
})

import type {
  OwnerExecutionPreparationInput,
  OwnerExecutionPreparationPreview,
  OwnerExecutionPreparationRecord,
} from '@gravitas/shared'
import {
  getOwnerExecutionEditor,
  ownerExecutionEditorsAtom,
  type OwnerExecutionEditor,
} from '../../atoms/project-owner-execution-atoms'
const subject = { projectId: 'a' }
const input: OwnerExecutionPreparationInput = {
  requestId: 'r',
  expectedPreparationRevision: 0,
  expectedPolicyRevision: null,
  expectedGoalRevision: 1,
  expectedPlanRevision: 3,
  selectedStepKeys: ['s'],
  executionKind: 'controlled',
  executorEmployeeId: 'e',
  reviewerEmployeeId: 'r',
  workspaceId: 'w',
  knowledgeSourceIds: ['k'],
  maxCostMicros: 1000001,
  maxRuns: 2,
  maxRework: 1,
  expiresAt: 4070952000000,
  changeReason: '明确暂停',
}
const preview: OwnerExecutionPreparationPreview = {
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
  selectedStepKeys: ['s'],
  executor: { id: 'e', name: '实际执行', configurationHash: 'employeehash' },
  reviewer: { id: 'r', name: '实际评审', configurationHash: 'reviewhash' },
  workspaceId: 'w',
  workspaceName: '托管',
  workspaceHash: 'workspacehash',
  channelId: 'c',
  modelId: 'explicit-model',
  runtime: 'ai-sdk',
  channelHash: 'channelhash',
  capabilityConfigurationHash: 'caphash',
  knowledgeSources: [
    {
      id: 'k',
      name: '显式资料',
      knowledgeBaseIds: ['kb'],
      metadataHash: 'metadatahash',
      contentHash: null,
    },
  ],
  blockers: ['资料执行fence未接通'],
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
    changeReason: '计划修订',
    contextFingerprint: 'ctxhash',
    planFingerprint: 'planhash',
    sources: { project: { id: 'a', title: '项目', description: '' }, roles: [] },
    proposal: {
      ...subject,
      goalVersion: 1,
      mode: 'proposal_only',
      summary: '冻结计划',
      assumptions: [],
      risks: [],
      steps: [
        {
          key: 's',
          title: '步骤标题',
          outcome: '冻结成果',
          acceptanceCriteria: ['冻结标准'],
          dependencies: ['dep'],
          roleKey: 'research',
        },
      ],
    },
  },
  input,
  previewFingerprint: 'previewhash',
}
const record: OwnerExecutionPreparationRecord = {
  ...subject,
  schemaVersion: 1,
  id: 'history-record',
  revision: 1,
  policyRevision: 2,
  stage: 'pending_task_links',
  actor: 'local-user',
  savedAt: 1,
  input,
  source: preview,
  inputHash: 'ih',
  previousIntegrityHash: null,
  integrityHash: 'integrityhash',
}
function render(patch: Partial<OwnerExecutionEditor>) {
  const store = createStore()
  store.set(
    ownerExecutionEditorsAtom,
    new Map([['["a",null]', { ...getOwnerExecutionEditor(new Map(), subject), ...patch }]]),
  )
  return renderToStaticMarkup(
    createElement(
      Provider,
      { store },
      createElement(ProjectOwnerExecutionPreparationPanel, subject),
    ),
  )
}
test('Given 冻结预览 When SSR Then 全事实与未知contentHash清楚可核对且窄屏可滚', () => {
  const html = render({ preview })
  for (const text of [
    'revision 3 / v2',
    'planhash',
    'ctxhash',
    '冻结成果',
    '冻结标准',
    'dep',
    '实际执行',
    '实际评审',
    'explicit-model',
    'ai-sdk',
    'workspacehash',
    'employeehash',
    'channelhash',
    'caphash',
    'metadatahash',
    'contentHash 未知',
    '1000001',
    '次数：2',
    '返工：1',
    '期限',
    '资料执行fence未接通',
    'previewhash',
    'overflow-y-auto',
    'min-w-0',
  ])
    expect(html).toContain(text)
  expect(html).not.toContain('已授权')
})
test('Given 历史与来源冲突 When SSR Then 历史无恢复按钮且诊断/输入保留', () => {
  const html = render({
    history: [record],
    historyLoaded: true,
    requiresReview: true,
    error: 'policy版本冲突',
    changeReason: '我的未保存输入',
  })
  for (const text of [
    '历史只读，不可恢复',
    'integrityhash',
    'policy版本冲突',
    '我的未保存输入',
    '不会自动重试',
    '新增知识来源不会自动勾选',
    '已比较最新来源',
  ])
    expect(html).toContain(text)
  expect(html).not.toContain('恢复此版本')
  expect(html).not.toContain('发行授权')
})
test('Given 非研发模式 When SSR Then 无研发scope编辑或自动模型选项', () => {
  const html = render({ executionKind: 'controlled' })
  expect(html).not.toContain('目标路径（每行一条')
  expect(html).not.toContain('允许路径（每行一条')
  expect(html).not.toContain('选择模型')
  expect(html).toContain('不自动选择或修改')
  const development = render({ executionKind: 'development' })
  expect(development).toContain('目标路径（每行一条')
  expect(development).toContain('后台须核验Git')
})
test('Given 嵌入计划与任务弹窗 When 呈现准备 Then 字段语义唯一且滚动分区具名、不冒充弹窗滚动div', () => {
  const html = render({ preview, history: [record], historyLoaded: true })
  expect(html).toContain('执行准备修订原因（必填）')
  expect(html).not.toContain('>修订原因（必填）<')
  expect(html).toMatch(/<fieldset[^>]*overflow-y-auto[^>]*aria-label="暂停准备范围编辑"/)
  expect(html).toMatch(/<section[^>]*overflow-y-auto[^>]*aria-label="执行准备冻结预览区域"/)
  expect(html).toMatch(/<section[^>]*overflow-y-auto[^>]*aria-label="暂停准备历史"/)
  expect(html).not.toMatch(/<div[^>]*class="[^"]*overflow-y-auto/)
})
