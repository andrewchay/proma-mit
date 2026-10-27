import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type {
  OwnerExecutionGrant,
  OwnerExecutionGrantIssuePreview,
  OwnerExecutionGrantRevokePreview,
  ProjectOwnerExecutionGrantApi,
} from '@gravitas/shared'
import {
  confirmOwnerGrantIssueAtom,
  confirmOwnerGrantRevokeAtom,
  getOwnerGrantEditor,
  loadOwnerGrantAtom,
  loadOwnerGrantHistoryAtom,
  ownerGrantApiAtom,
  ownerGrantEditorsAtom,
  previewOwnerGrantIssueAtom,
  previewOwnerGrantRevokeAtom,
} from './project-owner-execution-grant-atoms'

const subject = { projectId: 'a' }
const otherSubject = { projectId: 'b' }
const key = '["a",null]'
const budget = { maxCostMicros: 1000001, maxRuns: 2, maxRework: 0, expiresAt: 4070952000000 }
const preview: OwnerExecutionGrantIssuePreview = {
  ...subject,
  dispatchMode: 'manual',
  executionKind: 'controlled',
  policyRevision: 2,
  revalidationId: 'rev-1',
  revalidationRevision: 1,
  revalidationIntegrityHash: 'rev-hash',
  materializationId: 'batch-1',
  materializationRevision: 1,
  materializationIntegrityHash: 'mat-hash',
  sourceHash: 'src-hash',
  executorEmployeeId: 'e',
  reviewerEmployeeId: 'r',
  workspaceId: 'w',
  channelId: 'c',
  modelId: 'm',
  runtime: 'ai-sdk',
  budget,
  blockers: [],
  approvalFingerprint: 'a'.repeat(64),
}
const grant: OwnerExecutionGrant = {
  ...preview,
  grantId: `owner-grant-${'a'.repeat(32)}`,
  state: 'active',
  issuedAt: 1,
}
const pausedGrant: OwnerExecutionGrant = { ...grant, state: 'paused' }
const revokePreview: OwnerExecutionGrantRevokePreview = {
  grantId: grant.grantId,
  projectId: 'a',
  fingerprint: 'f'.repeat(64),
  impact: { commandCount: 0, runningCount: 0, pendingRequestCount: 0 },
  blockers: [],
}
const input = { requestId: 'req-1', expectedRevalidationRevision: 1, expectedPolicyRevision: 2 }
function setup(overrides?: Partial<ProjectOwnerExecutionGrantApi>) {
  const store = createStore()
  const api: ProjectOwnerExecutionGrantApi = {
    getOwnerExecutionGrant: async () => ({ ok: true, value: grant }),
    listOwnerExecutionGrantHistory: async () => ({ ok: true, value: [grant] }),
    previewOwnerExecutionGrantIssue: async () => ({ ok: true, value: preview }),
    confirmOwnerExecutionGrantIssue: async () => ({ ok: true, value: grant }),
    previewOwnerExecutionGrantRevoke: async () => ({ ok: true, value: revokePreview }),
    confirmOwnerExecutionGrantRevoke: async () => ({ ok: true, value: pausedGrant }),
    ...overrides,
  }
  store.set(ownerGrantApiAtom, api)
  return { store, api }
}
function editor(store: ReturnType<typeof setup>['store']) {
  return getOwnerGrantEditor(store.get(ownerGrantEditorsAtom), subject)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
test('Given 空状态 When 读取授权 Then grant落视图、loaded置位且主体隔离', async () => {
  const { store } = setup()
  await store.set(loadOwnerGrantAtom, subject)
  const after = editor(store)
  expect(after.grant?.grantId).toBe(grant.grantId)
  expect(after.grant?.state).toBe('active')
  expect(after.loaded).toBe(true)
  expect(after.loading).toBe(false)
  expect(getOwnerGrantEditor(store.get(ownerGrantEditorsAtom), otherSubject).grant).toBeNull()
})
test('Given 读取失败 When 落地 Then 错误保留且不误标loaded', async () => {
  const { store } = setup({
    getOwnerExecutionGrant: async () => ({ ok: false, error: { code: 'failed', message: '账本不可读' } }),
  })
  await store.set(loadOwnerGrantAtom, subject)
  expect(editor(store).error).toBe('账本不可读')
  expect(editor(store).loaded).toBe(false)
})
test('Given 发行preview成功 When 确认 Then grant更新、预览清除且历史需重读', async () => {
  const { store } = setup()
  await store.set(previewOwnerGrantIssueAtom, { subject, input })
  expect(editor(store).preview?.approvalFingerprint).toBe(preview.approvalFingerprint)
  await store.set(confirmOwnerGrantIssueAtom, {
    subject,
    input,
    confirmedFingerprint: preview.approvalFingerprint,
  })
  const after = editor(store)
  expect(after.grant?.state).toBe('active')
  expect(after.preview).toBeNull()
  expect(after.historyLoaded).toBe(false)
  expect(after.confirming).toBe(false)
})
test('Given 确认指纹与预览不符 When confirm Then 客户端直接拒绝不调用API', async () => {
  let called = 0
  const { store } = setup({
    confirmOwnerExecutionGrantIssue: async () => {
      called += 1
      return { ok: true, value: grant }
    },
  })
  await store.set(previewOwnerGrantIssueAtom, { subject, input })
  await store.set(confirmOwnerGrantIssueAtom, { subject, input, confirmedFingerprint: 'b'.repeat(64) })
  const after = editor(store)
  expect(called).toBe(0)
  expect(after.error).toContain('指纹')
  expect(after.preview).not.toBeNull()
})
test('Given 服务端conflict When confirm Then 保留诊断、清预览且不自动重试', async () => {
  const { store } = setup({
    confirmOwnerExecutionGrantIssue: async () => ({
      ok: false,
      error: { code: 'conflict', message: '策略已更新，请重新预览' },
    }),
  })
  await store.set(previewOwnerGrantIssueAtom, { subject, input })
  await store.set(confirmOwnerGrantIssueAtom, {
    subject,
    input,
    confirmedFingerprint: preview.approvalFingerprint,
  })
  const after = editor(store)
  expect(after.error).toBe('策略已更新，请重新预览')
  expect(after.preview).toBeNull()
  expect(after.grant).toBeNull()
  expect(after.confirming).toBe(false)
})
test('Given 撤权两阶段 When preview→confirm Then state转paused、影响面清空且历史需重读', async () => {
  const { store } = setup()
  store.set(ownerGrantEditorsAtom, new Map([[key, { ...editor(store), grant: grant }]]))
  await store.set(previewOwnerGrantRevokeAtom, { subject, grantId: grant.grantId })
  expect(editor(store).revokePreview?.fingerprint).toBe(revokePreview.fingerprint)
  await store.set(confirmOwnerGrantRevokeAtom, {
    subject,
    grantId: grant.grantId,
    confirmedFingerprint: revokePreview.fingerprint,
  })
  const after = editor(store)
  expect(after.grant?.state).toBe('paused')
  expect(after.revokePreview).toBeNull()
  expect(after.historyLoaded).toBe(false)
  expect(after.revoking).toBe(false)
})
test('Given 撤权指纹不符 When confirm Then 拒绝且零副作用', async () => {
  let called = 0
  const { store } = setup({
    confirmOwnerExecutionGrantRevoke: async () => {
      called += 1
      return { ok: true, value: pausedGrant }
    },
  })
  store.set(ownerGrantEditorsAtom, new Map([[key, { ...editor(store), grant }]]))
  await store.set(previewOwnerGrantRevokeAtom, { subject, grantId: grant.grantId })
  await store.set(confirmOwnerGrantRevokeAtom, {
    subject,
    grantId: grant.grantId,
    confirmedFingerprint: 'e'.repeat(64),
  })
  expect(called).toBe(0)
  expect(editor(store).error).toContain('指纹')
  expect(editor(store).grant?.state).toBe('active')
})
test('Given preview在途 When 新preview/confirm并发 Then 互斥不再发起', async () => {
  const { store, api } = setup()
  const wait = deferred<Awaited<ReturnType<typeof api.previewOwnerExecutionGrantIssue>>>()
  store.set(ownerGrantApiAtom, { ...api, previewOwnerExecutionGrantIssue: () => wait.promise })
  const pending = store.set(previewOwnerGrantIssueAtom, { subject, input })
  await store.set(previewOwnerGrantIssueAtom, { subject, input })
  wait.resolve({ ok: true, value: preview })
  await pending
  expect(editor(store).preview).not.toBeNull()
  expect(editor(store).previewing).toBe(false)
})
test('Given 历史读取 When 完成 Then 只读累积且不改变授权当前值', async () => {
  const { store } = setup()
  await store.set(loadOwnerGrantHistoryAtom, subject)
  const after = editor(store)
  expect(after.history).toHaveLength(1)
  expect(after.historyLoaded).toBe(true)
  expect(after.historyError).toBe('')
})
test('Given 历史失败 When 落地 Then historyError保留、historyLoaded不置位', async () => {
  const { store } = setup({
    listOwnerExecutionGrantHistory: async () => ({
      ok: false,
      error: { code: 'failed', message: '历史不可读' },
    }),
  })
  await store.set(loadOwnerGrantHistoryAtom, subject)
  expect(editor(store).historyError).toBe('历史不可读')
  expect(editor(store).historyLoaded).toBe(false)
})
test('Given 响应主体不匹配 When 落地 Then 抛错不写入错误subject', async () => {
  const { store } = setup({
    getOwnerExecutionGrant: async () => ({ ok: true, value: { ...grant, projectId: 'b' } }),
  })
  await store.set(loadOwnerGrantAtom, subject)
  expect(editor(store).grant).toBeNull()
  expect(editor(store).loaded).toBe(false)
})

test('Given发行期间旧只读请求晚到 When确认已成功 Then旧null不得覆盖active', async () => {
  const old = deferred<Awaited<ReturnType<ProjectOwnerExecutionGrantApi['getOwnerExecutionGrant']>>>()
  const { store } = setup({ getOwnerExecutionGrant: () => old.promise })
  await store.set(previewOwnerGrantIssueAtom, { subject, input })
  const pending = store.set(loadOwnerGrantAtom, subject)
  await store.set(confirmOwnerGrantIssueAtom, { subject, input, confirmedFingerprint: preview.approvalFingerprint })
  old.resolve({ ok: true, value: null }); await pending
  expect(editor(store).grant?.state).toBe('active')
  expect(editor(store).loaded).toBe(true)
})
test('Given撤权期间旧active读取晚到 When撤权成功 Then不能复活paused授权', async () => {
  const old = deferred<Awaited<ReturnType<ProjectOwnerExecutionGrantApi['getOwnerExecutionGrant']>>>()
  const { store } = setup({ getOwnerExecutionGrant: () => old.promise })
  await store.set(previewOwnerGrantRevokeAtom, { subject, grantId: grant.grantId })
  const pending = store.set(loadOwnerGrantAtom, subject)
  await store.set(confirmOwnerGrantRevokeAtom, { subject, grantId: grant.grantId, confirmedFingerprint: revokePreview.fingerprint })
  old.resolve({ ok: true, value: grant }); await pending
  expect(editor(store).grant?.state).toBe('paused')
})

test('Given旧历史读取在途 When发行成功 Then晚到空历史不能冒充新版本已同步', async () => {
  const old = deferred<Awaited<ReturnType<ProjectOwnerExecutionGrantApi['listOwnerExecutionGrantHistory']>>>()
  const { store } = setup({ listOwnerExecutionGrantHistory: () => old.promise })
  const pending = store.set(loadOwnerGrantHistoryAtom, subject)
  await store.set(previewOwnerGrantIssueAtom, { subject, input })
  await store.set(confirmOwnerGrantIssueAtom, { subject, input, confirmedFingerprint: preview.approvalFingerprint })
  old.resolve({ ok: true, value: [] }); await pending
  expect(editor(store).historyLoaded).toBe(false)
  expect(editor(store).grant?.state).toBe('active')
})
