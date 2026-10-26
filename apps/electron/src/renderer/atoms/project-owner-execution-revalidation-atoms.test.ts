import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type {
  OwnerExecutionPreparationRecord,
  OwnerExecutionPreparationView,
  OwnerExecutionRevalidationPreview,
  OwnerExecutionRevalidationRecord,
  OwnerExecutionRevalidationSource,
  OwnerExecutionRevalidationView,
  OwnerTaskMaterializationRecord,
  OwnerTaskMaterializationView,
  ProjectOwnerExecutionRevalidationApi,
} from '@gravitas/shared'
import {
  getOwnerExecutionEditor,
  ownerExecutionEditorsAtom,
} from './project-owner-execution-atoms'
import {
  getOwnerTaskEditor,
  ownerTaskEditorsAtom,
} from './project-owner-task-atoms'
import {
  canPreviewOwnerRevalidation,
  canSaveOwnerRevalidation,
  editOwnerRevalidationAtom,
  getOwnerRevalidationEditor,
  loadOwnerRevalidationAtom,
  loadOwnerRevalidationHistoryAtom,
  ownerRevalidationApiAtom,
  ownerRevalidationEditorsAtom,
  ownerRevalidationInput,
  previewOwnerRevalidationAtom,
  revalidateOwnerExecutionAtom,
  saveOwnerRevalidationAtom,
} from './project-owner-execution-revalidation-atoms'

const subject = { projectId: 'a' }
const key = '["a",null]'
const minimalPreparation = {
  id: 'prep-1',
  revision: 3,
  policyRevision: 2,
  integrityHash: 'prep-hash',
} as unknown as OwnerExecutionPreparationRecord
const preparationView: OwnerExecutionPreparationView = {
  choices: { employees: [], workspaces: [], knowledgeSources: [] },
  revision: 3,
  policyRevision: 2,
  preparation: minimalPreparation,
  status: 'stale',
  blockers: [],
}
const materializationRecord = {
  id: 'batch-1',
  revision: 1,
  integrityHash: 'mat-hash',
} as unknown as OwnerTaskMaterializationRecord
const materializationView: OwnerTaskMaterializationView = {
  revision: 1,
  materialization: materializationRecord,
  status: 'needs_revalidation',
  blockers: [],
}
const source: OwnerExecutionRevalidationSource = {
  schemaVersion: 2,
  stage: 'paused_task_links',
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
      linkKind: 'created',
      linkIntegrityHash: 'lh',
      taskSpecificationHash: 'sh',
      status: 'paused',
      assignee: { userId: 'agent-e', displayName: 'Executor' },
      workspaceId: 'w',
      dependencies: [{ id: 'edge-1', taskId: 't1', dependsOnTaskId: 'up', type: 'finish_to_start' }],
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
  ownerBindingProvenance: { state: 'none' },
  knowledgeSources: [],
  budget: { maxCostMicros: 1000001, maxRuns: 2, maxRework: 0, expiresAt: 4070952000000 },
  executionKind: 'controlled',
  blockers: ['v2冻结真实任务事实，不是执行授权'],
}
const input = {
  requestId: 'req-1',
  expectedRevalidationRevision: 0,
  expectedMaterializationId: 'batch-1',
  expectedMaterializationRevision: 1,
  expectedMaterializationHash: 'mat-hash',
  expectedPolicyRevision: 2,
  changeReason: '按真实任务重新冻结',
}
const preview: OwnerExecutionRevalidationPreview = {
  ...subject,
  input,
  source,
  previewFingerprint: 'previewhash',
}
const record: OwnerExecutionRevalidationRecord = {
  ...subject,
  schemaVersion: 2,
  purpose: 'owner_business_execution_revalidation',
  id: 'rev-1',
  revision: 1,
  policyRevision: 3,
  stage: 'paused_task_links',
  actor: 'local-user',
  savedAt: 1,
  input,
  source,
  inputHash: 'ih',
  previewFingerprint: 'previewhash',
  previousIntegrityHash: null,
  integrityHash: 'rh',
}
const view: OwnerExecutionRevalidationView = {
  revision: 0,
  revalidation: null,
  status: 'none',
  blockers: [],
}
const currentView: OwnerExecutionRevalidationView = {
  revision: 1,
  revalidation: record,
  status: 'current',
  blockers: source.blockers,
}
function seedUpstream(store: ReturnType<typeof createStore>) {
  store.set(
    ownerExecutionEditorsAtom,
    new Map([
      [
        key,
        {
          ...getOwnerExecutionEditor(new Map(), subject),
          loaded: true,
          view: preparationView,
        },
      ],
    ]),
  )
  store.set(
    ownerTaskEditorsAtom,
    new Map([
      [
        key,
        {
          ...getOwnerTaskEditor(new Map(), subject),
          loaded: true,
          view: materializationView,
        },
      ],
    ]),
  )
}
function setup() {
  const store = createStore()
  seedUpstream(store)
  const api: ProjectOwnerExecutionRevalidationApi = {
    getOwnerExecutionRevalidation: async () => ({ ok: true, value: view }),
    listOwnerExecutionRevalidationHistory: async () => ({ ok: true, value: [record] }),
    previewOwnerExecutionRevalidation: async (request) => ({
      ok: true,
      value: { ...preview, input: request.input },
    }),
    saveOwnerExecutionRevalidation: async (request) => ({
      ok: true,
      value: { ...record, input: request.input },
    }),
  }
  store.set(ownerRevalidationApiAtom, api)
  return { store, api }
}
function editor(store: ReturnType<typeof createStore>) {
  return getOwnerRevalidationEditor(store.get(ownerRevalidationEditorsAtom), subject)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
test('Given 空状态 When 编辑changeReason Then 仅该字段更新并更换requestId、废preview', () => {
  const { store } = setup()
  const before = editor(store)
  store.set(editOwnerRevalidationAtom, { subject, patch: { changeReason: '重新冻结' } })
  const after = editor(store)
  expect(after.changeReason).toBe('重新冻结')
  expect(after.requestId).not.toBe(before.requestId)
  expect(after.dirty).toBe(true)
  expect(
    getOwnerRevalidationEditor(store.get(ownerRevalidationEditorsAtom), { projectId: 'b' })
      .changeReason,
  ).toBe('')
})
test('Given 材料化needs_revalidation+准备已登记 When 构造输入 Then 精确携带上游三元组与policy revision', () => {
  const { store } = setup()
  store.set(editOwnerRevalidationAtom, { subject, patch: { changeReason: '重新冻结' } })
  store.set(ownerRevalidationEditorsAtom, new Map([[key, { ...editor(store), loaded: true, view }]]))
  const value = ownerRevalidationInput(store.get, subject)
  expect(value).toEqual({ ...input, changeReason: '重新冻结', requestId: editor(store).requestId })
  expect(canPreviewOwnerRevalidation(store.get, subject)).toBe(true)
})
test('Given 材料化非needs_revalidation/无准备/无原因 When 构造输入 Then 均不可预览', () => {
  const { store } = setup()
  store.set(editOwnerRevalidationAtom, { subject, patch: { changeReason: '重新冻结' } })
  store.set(ownerRevalidationEditorsAtom, new Map([[key, { ...editor(store), loaded: true, view }]]))
  expect(ownerRevalidationInput(store.get, subject)).not.toBeNull()
  store.set(
    ownerTaskEditorsAtom,
    new Map([
      [
        key,
        {
          ...getOwnerTaskEditor(new Map(), subject),
          loaded: true,
          view: { ...materializationView, status: 'stale' },
        },
      ],
    ]),
  )
  expect(ownerRevalidationInput(store.get, subject)).toBeNull()
  const { store: noReason } = setup()
  noReason.set(
    ownerRevalidationEditorsAtom,
    new Map([[key, { ...editor(noReason), loaded: true, view }]]),
  )
  expect(ownerRevalidationInput(noReason.get, subject)).toBeNull()
  const { store: noPolicy } = setup()
  noPolicy.set(
    ownerExecutionEditorsAtom,
    new Map([
      [key, { ...getOwnerExecutionEditor(new Map(), subject), loaded: true, view: { ...preparationView, policyRevision: null } }],
    ]),
  )
  noPolicy.set(editOwnerRevalidationAtom, { subject, patch: { changeReason: '重新冻结' } })
  noPolicy.set(
    ownerRevalidationEditorsAtom,
    new Map([[key, { ...editor(noPolicy), loaded: true, view }]]),
  )
  expect(ownerRevalidationInput(noPolicy.get, subject)).toBeNull()
})
test('Given 预览在途 When 编辑changeReason Then 晚到预览被丢弃', async () => {
  const { store, api } = setup()
  store.set(editOwnerRevalidationAtom, { subject, patch: { changeReason: '重新冻结' } })
  store.set(ownerRevalidationEditorsAtom, new Map([[key, { ...editor(store), loaded: true, view }]]))
  const wait = deferred<Awaited<ReturnType<typeof api.previewOwnerExecutionRevalidation>>>()
  store.set(ownerRevalidationApiAtom, { ...api, previewOwnerExecutionRevalidation: () => wait.promise })
  const pending = store.set(previewOwnerRevalidationAtom, subject)
  store.set(editOwnerRevalidationAtom, { subject, patch: { changeReason: '新原因' } })
  wait.resolve({ ok: true, value: preview })
  await pending
  expect(editor(store).preview).toBeNull()
  expect(editor(store).previewing).toBe(false)
})
test('Given 预览成功 When 保存 Then 记录落视图、预览清除、需重读历史', async () => {
  const { store } = setup()
  store.set(editOwnerRevalidationAtom, { subject, patch: { changeReason: '重新冻结' } })
  store.set(ownerRevalidationEditorsAtom, new Map([[key, { ...editor(store), loaded: true, view }]]))
  await store.set(previewOwnerRevalidationAtom, subject)
  expect(editor(store).preview).not.toBeNull()
  expect(canSaveOwnerRevalidation(store.get, subject)).toBe(true)
  await store.set(saveOwnerRevalidationAtom, subject)
  const after = editor(store)
  expect(after.preview).toBeNull()
  expect(after.view?.status).toBe('current')
  expect(after.view?.revalidation?.id).toBe('rev-1')
  expect(after.historyLoaded).toBe(false)
  expect(after.saving).toBe(false)
})
test('Given 保存冲突 When 失败 Then 保留诊断与输入、清预览，不自动重试', async () => {
  const { store, api } = setup()
  store.set(editOwnerRevalidationAtom, { subject, patch: { changeReason: '重新冻结' } })
  store.set(ownerRevalidationEditorsAtom, new Map([[key, { ...editor(store), loaded: true, view }]]))
  await store.set(previewOwnerRevalidationAtom, subject)
  store.set(ownerRevalidationApiAtom, {
    ...api,
    saveOwnerExecutionRevalidation: async () => ({
      ok: false,
      error: { code: 'conflict', message: '材料化记录已修订' },
    }),
  })
  await store.set(saveOwnerRevalidationAtom, subject)
  const after = editor(store)
  expect(after.error).toBe('材料化记录已修订')
  expect(after.preview).toBeNull()
  expect(after.changeReason).toBe('重新冻结')
  expect(after.saving).toBe(false)
})
test('Given 来源/材料化/preparation变化 When 派生读取 Then 废preview并标记需比较', async () => {
  const { store } = setup()
  store.set(editOwnerRevalidationAtom, { subject, patch: { changeReason: '重新冻结' } })
  store.set(ownerRevalidationEditorsAtom, new Map([[key, { ...editor(store), loaded: true, view }]]))
  await store.set(previewOwnerRevalidationAtom, subject)
  expect(editor(store).preview).not.toBeNull()
  // 派生stamp基于材料化与准备编辑器：材料化view变化必须立即废preview
  store.set(
    ownerTaskEditorsAtom,
    new Map([
      [
        key,
        {
          ...getOwnerTaskEditor(new Map(), subject),
          loaded: true,
          view: { ...materializationView, revision: 2 },
        },
      ],
    ]),
  )
  const after = getOwnerRevalidationEditor(store.get(ownerRevalidationEditorsAtom), subject)
  expect(after.preview).toBeNull()
  expect(after.requiresReview).toBe(true)
})
test('Given 一键重验证 When 预览+保存链路 Then 成功后视图为current且按钮状态复位', async () => {
  const { store } = setup()
  store.set(editOwnerRevalidationAtom, { subject, patch: { changeReason: '重新冻结' } })
  store.set(ownerRevalidationEditorsAtom, new Map([[key, { ...editor(store), loaded: true, view }]]))
  await store.set(revalidateOwnerExecutionAtom, subject)
  const after = editor(store)
  expect(after.view?.status).toBe('current')
  expect(after.preview).toBeNull()
  expect(after.saving).toBe(false)
  expect(after.previewing).toBe(false)
})
test('Given 历史读取 When 完成 Then 只读累积、不清当前编辑', async () => {
  const { store } = setup()
  store.set(editOwnerRevalidationAtom, { subject, patch: { changeReason: '保留原因' } })
  await store.set(loadOwnerRevalidationHistoryAtom, subject)
  const after = editor(store)
  expect(after.history).toHaveLength(1)
  expect(after.historyLoaded).toBe(true)
  expect(after.changeReason).toBe('保留原因')
})
test('Given 重验证view已current When 读取 Then blockers来自重放重建并保留', async () => {
  const { store, api } = setup()
  store.set(ownerRevalidationApiAtom, {
    ...api,
    getOwnerExecutionRevalidation: async () => ({ ok: true, value: currentView }),
  })
  await store.set(loadOwnerRevalidationAtom, subject)
  const after = editor(store)
  expect(after.view?.status).toBe('current')
  expect(after.view?.blockers).toContain('v2冻结真实任务事实，不是执行授权')
  expect(after.loaded).toBe(true)
})
