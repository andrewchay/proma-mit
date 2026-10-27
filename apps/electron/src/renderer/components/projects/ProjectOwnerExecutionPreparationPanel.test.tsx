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
  OwnerExecutionPreparationView,
} from '@gravitas/shared'
import {
  getOwnerExecutionEditor,
  ownerExecutionEditorsAtom,
  type OwnerExecutionEditor,
} from '../../atoms/project-owner-execution-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from '../../atoms/project-owner-plan-atoms'
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
  roleBudgetCaps: [{ roleKey: 'research', maxCostMicros: 400000 }],
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
  toolRecommendations: [],
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
  store.set(ownerPlanEditorsAtom, new Map([['["a",null]', { ...getOwnerPlanEditor(new Map(), subject), snapshot: preview.plan }]]))
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
    'research ≤ 400000 微美元',
    'Executor 与 Reviewer 费用都计入该任务岗位',
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
test('Given 可选岗位cap编辑已启用 When SSR Then 默认不自动开启且说明未配置岗位仍受共享总额', () => {
  expect(render({})).toContain('<input type="checkbox"/><span>启用按岗位设置上限</span>')
  const html = render({ roleBudgetCapsEnabled: true, roleBudgetCapTexts: { research: '400000' } })
  expect(html).toContain('<input type="checkbox" checked=""/>')
  expect(html).toContain('启用按岗位设置上限')
  expect(html).toContain('未填写的岗位只受共享总额限制')
  expect(html).toContain('Reviewer 费用计入被评审任务的岗位')
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
test('Given 唯一roleTemplate只匹配Owner载体 When 显示候选 Then 文案解释不自动推荐但可显式选择', () => {
  const view: OwnerExecutionPreparationView = {
    workspaceRecommendation: { workspaceId: 'w', source: 'unique_project_workspace' },
    executionConfigurationRecommendation: null,
    executionConfigurationRecommendationState: 'none',
    choices: {
      employees: [{ id: 'carrier', name: 'Owner载体', roleTemplateId: 'research', executionProfile: 'controlled', workspaceIds: ['w'], channelId: 'c', modelId: 'm', runtime: 'ai-sdk', isOwnerCarrier: true }],
      workspaces: [{ id: 'w', name: '明确工作区' }],
      workspaceCapabilities: [],
      knowledgeSources: [],
    },
    revision: 0,
    policyRevision: null,
    preparation: null,
    status: 'none',
    blockers: [],
  }
  const html = render({ view, selectedStepKeys: ['s'], workspaceId: 'w' })
  expect(html).toContain('唯一精确匹配是 Owner 规划载体；请明确选择')
  expect(html).toContain('精确模板仅匹配 Owner 规划载体；不会自动推荐。你仍可显式选择并接受服务端配置核验')
  expect(html).toContain('Owner规划载体（不自动推荐）')
  expect(html).toContain('Owner规划载体（仅显式选择）')
})
test('Given当前项目没有配置有效员工 When 渲染岗位选择 Then 解释员工渠道模型与工作区需恢复有效', () => {
  const view: OwnerExecutionPreparationView = {
    workspaceRecommendation: { workspaceId: 'w', source: 'unique_project_workspace' },
    executionConfigurationRecommendation: null,
    executionConfigurationRecommendationState: 'none',
    choices: { employees: [], workspaces: [{ id: 'w', name: '工作区' }], workspaceCapabilities: [], knowledgeSources: [] },
    revision: 0,
    policyRevision: null,
    preparation: null,
    status: 'none',
    blockers: [],
  }
  const html = render({ view, selectedStepKeys: ['s'], workspaceId: 'w' })
  expect(html).toContain('没有当前可执行的项目员工')
  expect(html).toContain('启用渠道、模型并修复员工工作区配置后，重新读取来源')
})
test('Given Owner绑定失效且项目仅剩一个工作区 When 显示准备面板 Then 不静默预选该工作区', () => {
  const view: OwnerExecutionPreparationView = {
    workspaceRecommendation: { source: 'owner_binding_unavailable' },
    executionConfigurationRecommendation: null,
    executionConfigurationRecommendationState: 'none',
    choices: { employees: [], workspaces: [{ id: 'w', name: '唯一工作区' }], workspaceCapabilities: [], knowledgeSources: [] },
    revision: 0,
    policyRevision: null,
    preparation: null,
    status: 'none',
    blockers: [],
  }
  const html = render({ view, workspaceId: '' })
  expect(html).toContain('Owner绑定工作区或载体配置已失效，须重新核查Owner绑定；不会静默改用其他工作区。')
  expect(html).not.toContain('value="w" selected=""')
})
test('Given多个项目工作区且尚未选择 When 显示岗位 Then 提示先选工作区而非误报无有效员工', () => {
  const view: OwnerExecutionPreparationView = {
    workspaceRecommendation: { source: 'ambiguous' },
    executionConfigurationRecommendation: null,
    executionConfigurationRecommendationState: 'none',
    choices: {
      employees: [{ id: 'e', name: '执行人员', roleTemplateId: 'research', executionProfile: 'controlled', workspaceIds: ['w1'], channelId: 'c', modelId: 'm', runtime: 'ai-sdk' }],
      workspaces: [{ id: 'w1', name: '工作区一' }, { id: 'w2', name: '工作区二' }],
      workspaceCapabilities: [],
      knowledgeSources: [],
    },
    revision: 0,
    policyRevision: null,
    preparation: null,
    status: 'none',
    blockers: [],
  }
  const html = render({ view, selectedStepKeys: ['s'], workspaceId: '' })
  expect(html).toContain('先在下方明确选择项目工作区')
  expect(html).toContain('先在下方明确选择，随后再筛选匹配员工')
  expect(html).not.toContain('启用渠道、模型并修复员工工作区配置后，重新读取来源')
})
test('Given Owner默认工作区和配置与手动选择冲突 When 显示准备面板 Then 分别询问覆盖确认', () => {
  const conflictView: OwnerExecutionPreparationView = {
    choices: {
      employees: [
        { id: 'e', name: '执行人员', roleTemplateId: 'research', executionProfile: 'controlled', workspaceIds: ['w', 'w2'], channelId: 'manual-channel', modelId: 'manual-model', runtime: 'ai-sdk' },
        { id: 'r', name: '评审人员', executionProfile: 'controlled', workspaceIds: ['w', 'w2'], channelId: 'manual-channel', modelId: 'manual-model', runtime: 'ai-sdk' },
      ],
      workspaces: [{ id: 'w', name: 'Owner工作区' }, { id: 'w2', name: '手动工作区' }],
      workspaceCapabilities: [],
      knowledgeSources: [],
    },
    workspaceRecommendation: { workspaceId: 'w', source: 'owner_binding' },
    executionConfigurationRecommendation: { channelId: 'owner-channel', modelId: 'owner-model', runtime: 'ai-sdk', source: 'owner_binding' },
    executionConfigurationRecommendationState: 'current',
    revision: 0,
    policyRevision: null,
    preparation: null,
    status: 'none',
    blockers: [],
  }
  const html = render({
    view: conflictView,
    workspaceId: 'w2',
    selectedStepKeys: ['s'],
    roleAssignments: { research: 'e' },
    executorEmployeeId: 'e',
    reviewerEmployeeId: 'r',
  })
  expect(html).toContain('手动选择的项目工作区与Owner绑定默认工作区不同')
  expect(html).toContain('执行/评审配置与Owner绑定默认配置不同')
  expect(html.match(/type="checkbox"/g)?.length).toBe(4)
})
test('Given 已选执行员工和Reviewer但渠道模型Runtime不一致 When 查看准备面板 Then 明确列出来源并要求选一致人员', () => {
  const conflictView: OwnerExecutionPreparationView = {
    workspaceRecommendation: { workspaceId: 'w', source: 'unique_project_workspace' },
    executionConfigurationRecommendation: null,
    executionConfigurationRecommendationState: 'none',
    choices: {
      employees: [
        { id: 'e', name: 'e', roleTemplateId: 'research', executionProfile: 'controlled', workspaceIds: ['w'], channelId: 'c', modelId: 'm', runtime: 'ai-sdk' },
        { id: 'r', name: 'r', executionProfile: 'controlled', workspaceIds: ['w'], channelId: 'other-channel', modelId: 'other-model', runtime: 'ai-sdk' },
      ],
      workspaces: [{ id: 'w', name: '工作区' }],
      workspaceCapabilities: [],
      knowledgeSources: [],
    },
    revision: 0,
    policyRevision: null,
    preparation: null,
    status: 'none',
    blockers: [],
  }
  const html = render({
    view: conflictView,
    selectedStepKeys: ['s'],
    roleAssignments: { research: 'e' },
    executorEmployeeId: 'e',
    reviewerEmployeeId: 'r',
  })
  expect(html).toContain('执行岗位与 Reviewer 的渠道、模型或 Runtime 来源冲突')
  expect(html).toContain('roleKey research · e：c / m / ai-sdk')
  expect(html).toContain('Reviewer · r：other-channel / other-model / ai-sdk')
  expect(html).toContain('请逐项选择配置一致的员工')
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
