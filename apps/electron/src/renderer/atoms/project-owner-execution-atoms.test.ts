import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  editOwnerExecutionAtom,
  getOwnerExecutionEditor,
  ownerExecutionEditorsAtom,
  parseOwnerExecutionInteger,
} from './project-owner-execution-atoms'
test('Given 金额微美元 When 严格解析 Then 不接受小数、指数、超安全整数', () => {
  expect(parseOwnerExecutionInteger('1000001')).toBe(1000001)
  for (const value of ['1.2', '1e6', '-1', '9007199254740992', ' 1', ''])
    expect(parseOwnerExecutionInteger(value)).toBeNull()
})
test('Given 两个主体 When 编辑 Then 隔离输入并更换requestId、不继承员工', () => {
  const store = createStore()
  const subject = { projectId: 'a' }
  const before = getOwnerExecutionEditor(store.get(ownerExecutionEditorsAtom), subject)
  store.set(editOwnerExecutionAtom, { subject, patch: { maxCostMicrosText: '5' } })
  const after = getOwnerExecutionEditor(store.get(ownerExecutionEditorsAtom), subject)
  expect(after.maxCostMicrosText).toBe('5')
  expect(after.requestId).not.toBe(before.requestId)
  expect(after.executorEmployeeId).toBe('')
  expect(after.reviewerEmployeeId).toBe('')
  expect(
    getOwnerExecutionEditor(store.get(ownerExecutionEditorsAtom), { projectId: 'b' })
      .maxCostMicrosText,
  ).toBe('')
})

import type {
  OwnerExecutionPreparationPreview,
  OwnerExecutionPreparationRecord,
  OwnerExecutionPreparationView,
  ProjectOwnerExecutionPreparationApi,
  ProjectOwnerPlanDraft,
} from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
import {
  editOwnerPlanAtom,
  getOwnerPlanEditor,
  ownerPlanEditorsAtom,
} from './project-owner-plan-atoms'
import {
  canPreviewOwnerExecution,
  canSaveOwnerExecution,
  compareOwnerExecutionAtom,
  loadOwnerExecutionAtom,
  loadOwnerExecutionHistoryAtom,
  ownerExecutionApiAtom,
  ownerExecutionInput,
  previewOwnerExecutionAtom,
  saveOwnerExecutionAtom,
} from './project-owner-execution-atoms'
const subject = { projectId: 'a' }
const plan: ProjectOwnerPlanDraft = {
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
  changeReason: 'r',
  contextFingerprint: 'ctx',
  planFingerprint: 'planhash',
  sources: { project: { id: 'a', title: '项目', description: '' }, roles: [] },
  proposal: {
    ...subject,
    goalVersion: 1,
    mode: 'proposal_only',
    summary: '计划',
    assumptions: [],
    risks: [],
    steps: [
      {
        key: 's1',
        title: '第一步',
        outcome: '报告',
        acceptanceCriteria: ['通过'],
        dependencies: [],
        roleKey: 'research',
      },
      {
        key: 's2',
        title: '第二步',
        outcome: '评审',
        acceptanceCriteria: ['通过'],
        dependencies: ['s1'],
        roleKey: 'review',
      },
    ],
  },
}
const view: OwnerExecutionPreparationView = {
  revision: 0,
  policyRevision: null,
  preparation: null,
  status: 'none',
  blockers: ['资料执行fence未接通'],
  choices: {
    employees: ['e', 'r'].map((id) => ({
      id,
      name: id,
      executionProfile: 'controlled',
      workspaceIds: ['w'],
      channelId: 'c',
      modelId: 'm',
      runtime: 'ai-sdk',
    })),
    workspaces: [{ id: 'w', name: '托管非Git' }],
    knowledgeSources: [{ id: 'k', name: '来源' }],
  },
}
function setup() {
  const store = createStore()
  const goal = {
    schemaVersion: 1 as const,
    revision: 1,
    state: 'draft' as const,
    actor: 'local-user' as const,
    savedAt: 1,
    goal: {
      ...subject,
      goalVersion: 1,
      objective: '目标',
      constraints: [],
      acceptanceCriteria: ['标准'],
    },
  }
  store.set(
    ownerGoalEditorsAtom,
    new Map([
      ['["a",null]', { ...getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: goal }],
    ]),
  )
  store.set(
    ownerPlanEditorsAtom,
    new Map([
      [
        '["a",null]',
        {
          ...getOwnerPlanEditor(new Map(), subject),
          loaded: true,
          snapshot: plan,
          context: { goal, sources: plan.sources, fingerprint: 'ctx' },
        },
      ],
    ]),
  )
  store.set(
    ownerExecutionEditorsAtom,
    new Map([
      ['["a",null]', { ...getOwnerExecutionEditor(new Map(), subject), loaded: true, view }],
    ]),
  )
  store.set(editOwnerExecutionAtom, {
    subject,
    patch: {
      selectedStepKeys: ['s1', 's2'],
      executorEmployeeId: 'e',
      reviewerEmployeeId: 'r',
      workspaceId: 'w',
      maxCostMicrosText: '1000001',
      maxRunsText: '2',
      maxReworkText: '0',
      expiresAtText: '2099-01-01T12:00',
      changeReason: '明确暂停准备',
    },
  })
  const input = ownerExecutionInput(store.get, subject)
  if (!input) throw new Error('fixture input invalid')
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
    contextFingerprint: 'ctx',
    plan,
    selectedStepKeys: input.selectedStepKeys,
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
    knowledgeSources: [],
    blockers: ['pending_task_links'],
    input,
    previewFingerprint: 'previewhash',
  }
  const record: OwnerExecutionPreparationRecord = {
    ...subject,
    schemaVersion: 1,
    id: 'record',
    revision: 1,
    policyRevision: 1,
    stage: 'pending_task_links',
    actor: 'local-user',
    savedAt: 1,
    input,
    source: preview,
    inputHash: 'ih',
    previousIntegrityHash: null,
    integrityHash: 'rh',
  }
  const api: ProjectOwnerExecutionPreparationApi = {
    getOwnerExecutionPreparation: async () => ({ ok: true, value: view }),
    listOwnerExecutionPreparationHistory: async () => ({ ok: true, value: [record] }),
    previewOwnerExecutionPreparation: async () => ({ ok: true, value: preview }),
    saveOwnerExecutionPreparation: async () => ({ ok: true, value: record }),
  }
  store.set(ownerExecutionApiAtom, api)
  return { store, api, preview, record }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function editor(store: ReturnType<typeof createStore>) {
  return getOwnerExecutionEditor(store.get(ownerExecutionEditorsAtom), subject)
}
test('Given controlled托管工作区 When 准备 Then 不附研发scope且知识来源明确none', () => {
  const { store } = setup()
  const input = ownerExecutionInput(store.get, subject)
  expect(input?.developmentScope).toBeUndefined()
  expect(input?.knowledgeSourceIds).toEqual([])
  expect(input?.maxCostMicros).toBe(1000001)
  expect(canPreviewOwnerExecution(store.get, subject)).toBe(true)
})
test('Given 缺依赖/同人员/未知知识/不同模型/非confirmed When 校验 Then 均不能预览', () => {
  for (const patch of [
    { selectedStepKeys: ['s2'] },
    { selectedStepKeys: ['s1', 's1'] },
    { reviewerEmployeeId: 'e' },
    { executorEmployeeId: 'carrier' },
    { knowledgeSourceIds: ['unlinked'] },
    { executionKind: 'development' as const },
  ]) {
    const { store } = setup()
    store.set(editOwnerExecutionAtom, { subject, patch })
    expect(canPreviewOwnerExecution(store.get, subject)).toBe(false)
  }
  const { store } = setup()
  const entries = new Map(store.get(ownerExecutionEditorsAtom))
  entries.set('["a",null]', {
    ...editor(store),
    view: {
      ...view,
      choices: {
        ...view.choices,
        employees: view.choices.employees.map((v) =>
          v.id === 'r' ? { ...v, modelId: 'other' } : v,
        ),
      },
    },
  })
  store.set(ownerExecutionEditorsAtom, entries)
  expect(canPreviewOwnerExecution(store.get, subject)).toBe(false)
  const { store: proposed } = setup()
  proposed.set(
    ownerPlanEditorsAtom,
    new Map([
      [
        '["a",null]',
        {
          ...getOwnerPlanEditor(proposed.get(ownerPlanEditorsAtom), subject),
          snapshot: { ...plan, state: 'proposed' },
        },
      ],
    ]),
  )
  expect(canPreviewOwnerExecution(proposed.get, subject)).toBe(false)
})
test('Given development When 明确选择范围 Then controlled切换不会携带旧scope', () => {
  const { store } = setup()
  const developmentView = {
    ...view,
    choices: {
      ...view.choices,
      employees: view.choices.employees.map((v) => ({ ...v, executionProfile: 'development' })),
    },
  }
  store.set(
    ownerExecutionEditorsAtom,
    new Map([['["a",null]', { ...editor(store), view: developmentView }]]),
  )
  store.set(editOwnerExecutionAtom, {
    subject,
    patch: {
      executionKind: 'development',
      targetPathsText: 'src/a.ts',
      allowedPathsText: 'src/',
      verificationCommandsText: 'bun test',
    },
  })
  expect(ownerExecutionInput(store.get, subject)?.developmentScope).toEqual({
    workspaceId: 'w',
    targetPaths: ['src/a.ts'],
    allowedPaths: ['src/'],
    verificationCommands: ['bun test'],
  })
  store.set(ownerExecutionEditorsAtom, new Map([['["a",null]', { ...editor(store), view }]]))
  store.set(editOwnerExecutionAtom, { subject, patch: { executionKind: 'controlled' } })
  expect(ownerExecutionInput(store.get, subject)?.developmentScope).toBeUndefined()
})
test('Given 预览在途 When 编辑+重复点击 Then 晚到结果丢弃且只发送一次', async () => {
  const { store, api, preview } = setup()
  const wait = deferred<Awaited<ReturnType<typeof api.previewOwnerExecutionPreparation>>>()
  let calls = 0
  store.set(ownerExecutionApiAtom, {
    ...api,
    previewOwnerExecutionPreparation: () => {
      calls++
      return wait.promise
    },
  })
  const pending = store.set(previewOwnerExecutionAtom, subject)
  await store.set(previewOwnerExecutionAtom, subject)
  store.set(editOwnerExecutionAtom, { subject, patch: { changeReason: '新输入' } })
  wait.resolve({ ok: true, value: preview })
  await pending
  expect(calls).toBe(1)
  expect(editor(store).preview).toBeNull()
  expect(editor(store).changeReason).toBe('新输入')
  expect(editor(store).previewing).toBe(false)
})
test('Given 预览在途 When 目标/计划变脏 Then 不接受预览且禁用保存', async () => {
  const { store, api, preview } = setup()
  const wait = deferred<Awaited<ReturnType<typeof api.previewOwnerExecutionPreparation>>>()
  store.set(ownerExecutionApiAtom, { ...api, previewOwnerExecutionPreparation: () => wait.promise })
  const pending = store.set(previewOwnerExecutionAtom, subject)
  store.set(editOwnerPlanAtom, { subject, patch: { summary: '脏计划' } })
  wait.resolve({ ok: true, value: preview })
  await pending
  expect(editor(store).preview).toBeNull()
  expect(canPreviewOwnerExecution(store.get, subject)).toBe(false)
  expect(canSaveOwnerExecution(store.get, subject)).toBe(false)
})
test('Given 预览成功 When 编辑 Then 立即清预览并更换幂等ID', async () => {
  const { store } = setup()
  await store.set(previewOwnerExecutionAtom, subject)
  expect(canSaveOwnerExecution(store.get, subject)).toBe(true)
  const requestId = editor(store).requestId
  store.set(editOwnerExecutionAtom, { subject, patch: { maxRunsText: '3' } })
  expect(editor(store).preview).toBeNull()
  expect(editor(store).requestId).not.toBe(requestId)
  expect(canSaveOwnerExecution(store.get, subject)).toBe(false)
})
test('Given 保存在途 When 编辑/切主体/重复点击 Then 保输入与隔离，零自动重试', async () => {
  const { store, api, record } = setup()
  await store.set(previewOwnerExecutionAtom, subject)
  const wait = deferred<Awaited<ReturnType<typeof api.saveOwnerExecutionPreparation>>>()
  let calls = 0
  store.set(ownerExecutionApiAtom, {
    ...api,
    saveOwnerExecutionPreparation: () => {
      calls++
      return wait.promise
    },
  })
  const pending = store.set(saveOwnerExecutionAtom, subject)
  await store.set(saveOwnerExecutionAtom, subject)
  store.set(editOwnerExecutionAtom, { subject, patch: { changeReason: '保存时新编辑' } })
  store.set(editOwnerExecutionAtom, {
    subject: { projectId: 'b', taskId: 't' },
    patch: { changeReason: '另一主体' },
  })
  wait.resolve({ ok: true, value: record })
  await pending
  expect(calls).toBe(1)
  expect(editor(store).changeReason).toBe('保存时新编辑')
  expect(editor(store).dirty).toBe(true)
  expect(editor(store).preview).toBeNull()
  expect(editor(store).requiresReview).toBe(true)
  expect(
    getOwnerExecutionEditor(store.get(ownerExecutionEditorsAtom), { projectId: 'b', taskId: 't' })
      .changeReason,
  ).toBe('另一主体')
})
test('Given 保存冲突 When 失败/比较 Then 输入和诊断保留，须先重读不能直接重试', async () => {
  const { store, api } = setup()
  await store.set(previewOwnerExecutionAtom, subject)
  store.set(ownerExecutionApiAtom, {
    ...api,
    saveOwnerExecutionPreparation: async () => ({
      ok: false,
      error: { code: 'conflict', message: 'policy发生变化' },
    }),
  })
  await store.set(saveOwnerExecutionAtom, subject)
  store.set(compareOwnerExecutionAtom, subject)
  expect(editor(store).changeReason).toBe('明确暂停准备')
  expect(editor(store).error).toBe('policy发生变化')
  expect(editor(store).requiresReview).toBe(true)
  expect(canPreviewOwnerExecution(store.get, subject)).toBe(false)
  await store.set(loadOwnerExecutionAtom, subject)
  expect(editor(store).error).toBe('policy发生变化')
  store.set(compareOwnerExecutionAtom, subject)
  expect(editor(store).requiresReview).toBe(false)
  expect(editor(store).error).toBe('')
})
test('Given 来源读取在途 When 编辑且新增知识 Then 不吞输入、不自动扩清单、需要比较', async () => {
  const { store, api } = setup()
  const wait = deferred<Awaited<ReturnType<typeof api.getOwnerExecutionPreparation>>>()
  store.set(ownerExecutionApiAtom, { ...api, getOwnerExecutionPreparation: () => wait.promise })
  const pending = store.set(loadOwnerExecutionAtom, subject)
  store.set(editOwnerExecutionAtom, { subject, patch: { maxCostMicrosText: '6' } })
  wait.resolve({
    ok: true,
    value: {
      ...view,
      choices: {
        ...view.choices,
        knowledgeSources: [...view.choices.knowledgeSources, { id: 'new', name: '新资料' }],
      },
    },
  })
  await pending
  expect(editor(store).maxCostMicrosText).toBe('6')
  expect(editor(store).knowledgeSourceIds).toEqual([])
  expect(editor(store).requiresReview).toBe(true)
  expect(canPreviewOwnerExecution(store.get, subject)).toBe(false)
})
test('Given 源读取失败/跨主体预览 When 返回 Then 保诊断输入并拒绝不匹配', async () => {
  const { store, api, preview } = setup()
  store.set(ownerExecutionApiAtom, {
    ...api,
    previewOwnerExecutionPreparation: async () => ({
      ok: true,
      value: { ...preview, projectId: 'b' },
    }),
  })
  await store.set(previewOwnerExecutionAtom, subject)
  expect(editor(store).error).toContain('主体不匹配')
  expect(editor(store).preview).toBeNull()
  store.set(ownerExecutionApiAtom, {
    ...api,
    getOwnerExecutionPreparation: async () => ({
      ok: false,
      error: { code: 'failed', message: '读取失败' },
    }),
  })
  await store.set(loadOwnerExecutionAtom, subject)
  expect(editor(store).error).toBe('读取失败')
  expect(editor(store).executorEmployeeId).toBe('e')
  expect(editor(store).loaded).toBe(false)
})
test('Given 历史 When 读取 Then 不恢复人员/范围、不清当前编辑', async () => {
  const { store } = setup()
  const requestId = editor(store).requestId
  await store.set(loadOwnerExecutionHistoryAtom, subject)
  expect(editor(store).history).toHaveLength(1)
  expect(editor(store).requestId).toBe(requestId)
  expect(editor(store).maxCostMicrosText).toBe('1000001')
  expect(editor(store).preview).toBeNull()
})
test('Given 非明确/非法/过期期限或非法金额次数 When 校验 Then 不发送预览', () => {
  for (const patch of [
    { expiresAtText: '2099' },
    { expiresAtText: '2099-02-31T12:00' },
    { expiresAtText: '2020-01-01T12:00' },
    { maxCostMicrosText: '0' },
    { maxRunsText: '0' },
    { maxReworkText: '-1' },
    { changeReason: ' ' },
  ]) {
    const { store } = setup()
    store.set(editOwnerExecutionAtom, { subject, patch })
    expect(canPreviewOwnerExecution(store.get, subject)).toBe(false)
  }
})
test('Given 目标脏态/已移除知识 When 请求 Then 不允许沿用旧预览', async () => {
  const { store } = setup()
  await store.set(previewOwnerExecutionAtom, subject)
  const goal = getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), subject)
  store.set(ownerGoalEditorsAtom, new Map([['["a",null]', { ...goal, dirty: true }]]))
  expect(canSaveOwnerExecution(store.get, subject)).toBe(false)
  expect(canPreviewOwnerExecution(store.get, subject)).toBe(false)
  const { store: removed } = setup()
  removed.set(editOwnerExecutionAtom, { subject, patch: { knowledgeSourceIds: ['k'] } })
  removed.set(
    ownerExecutionEditorsAtom,
    new Map([
      [
        '["a",null]',
        {
          ...editor(removed),
          view: { ...view, choices: { ...view.choices, knowledgeSources: [] } },
        },
      ],
    ]),
  )
  expect(canPreviewOwnerExecution(removed.get, subject)).toBe(false)
})
test('Given 逆序勾选与修订空白 When IPC返回规范输入 Then 不因排序/对象键序误拒绝', async () => {
  const { store, api, preview } = setup()
  store.set(editOwnerExecutionAtom, {
    subject,
    patch: { selectedStepKeys: ['s2', 's1'], changeReason: '  修订  ' },
  })
  const input = ownerExecutionInput(store.get, subject)
  if (!input) throw new Error('input missing')
  expect(input.selectedStepKeys).toEqual(['s1', 's2'])
  expect(input.changeReason).toBe('修订')
  const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as typeof input
  store.set(ownerExecutionApiAtom, {
    ...api,
    previewOwnerExecutionPreparation: async () => ({
      ok: true,
      value: { ...preview, input: reordered },
    }),
  })
  await store.set(previewOwnerExecutionAtom, subject)
  expect(canSaveOwnerExecution(store.get, subject)).toBe(true)
  expect(editor(store).error).toBe('')
})
