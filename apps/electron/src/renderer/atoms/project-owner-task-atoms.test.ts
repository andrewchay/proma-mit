import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type {
  OwnerExecutionPreparationRecord,
  OwnerTaskMaterializationPreview,
  OwnerTaskMaterializationRecord,
  ProjectOwnerTaskMaterializationApi,
} from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
import {
  editOwnerPlanAtom,
  getOwnerPlanEditor,
  ownerPlanEditorsAtom,
} from './project-owner-plan-atoms'
import {
  editOwnerExecutionAtom,
  getOwnerExecutionEditor,
  ownerExecutionEditorsAtom,
} from './project-owner-execution-atoms'
import {
  canMaterializeOwnerTasks,
  canPreviewOwnerTasks,
  compareOwnerTasksAtom,
  getOwnerTaskEditor,
  loadOwnerTasksAtom,
  loadOwnerTaskHistoryAtom,
  materializeOwnerTasksAtom,
  ownerTaskApiAtom,
  ownerTaskEditorsAtom,
  ownerTaskInput,
  ownerTaskRefreshAtom,
  ownerTaskListRefreshSignalAtom,
  previewOwnerTasksAtom,
} from './project-owner-task-atoms'
const subject = { projectId: 'a' }
const key = '["a",null]'
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
  const plan = {
    ...subject,
    schemaVersion: 1 as const,
    revision: 3,
    planVersion: 2,
    goalRevision: 1,
    goalVersion: 1,
    state: 'confirmed' as const,
    actor: 'local-user' as const,
    origin: 'manual' as const,
    savedAt: 1,
    changeReason: '原因',
    contextFingerprint: 'ctx',
    planFingerprint: 'plan',
    sources: { project: { id: 'a', title: '项目', description: '' }, roles: [] },
    proposal: {
      ...subject,
      goalVersion: 1,
      mode: 'proposal_only' as const,
      summary: '计划',
      assumptions: [],
      risks: [],
      steps: [
        {
          key: 's',
          title: '一步',
          outcome: '成果',
          acceptanceCriteria: ['标准'],
          dependencies: [],
          roleKey: 'research',
        },
      ],
    },
  }
  const prepInput = {
    requestId: 'prep',
    expectedPreparationRevision: 0,
    expectedPolicyRevision: null,
    expectedGoalRevision: 1,
    expectedPlanRevision: 3,
    selectedStepKeys: ['s'],
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
    id: 'prep-id',
    revision: 4,
    policyRevision: 2,
    stage: 'pending_task_links',
    actor: 'local-user',
    savedAt: 1,
    input: prepInput,
    inputHash: 'inputhash',
    previousIntegrityHash: null,
    integrityHash: 'prephash',
    source: {
      ...subject,
      schemaVersion: 1,
      stage: 'pending_task_links',
      ownerBindingProvenance: { state: 'none' },
      goalRevision: 1,
      goalVersion: 1,
      planRevision: 3,
      planVersion: 2,
      planFingerprint: 'plan',
      contextFingerprint: 'ctx',
      selectedStepKeys: ['s'],
      executor: { id: 'e', name: '执行', configurationHash: 'eh' },
      reviewer: { id: 'r', name: '技术评审', configurationHash: 'rh' },
      workspaceId: 'w',
      workspaceName: '工作区',
      workspaceHash: 'wh',
      channelId: 'c',
      modelId: 'm',
      runtime: 'ai-sdk',
      channelHash: 'ch',
      capabilityConfigurationHash: 'cap',
      knowledgeSources: [],
      plan,
      blockers: ['pending_task_links'],
    },
  }
  store.set(
    ownerGoalEditorsAtom,
    new Map([[key, { ...getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: goal }]]),
  )
  store.set(
    ownerPlanEditorsAtom,
    new Map([
      [
        key,
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
      [
        key,
        {
          ...getOwnerExecutionEditor(new Map(), subject),
          loaded: true,
          view: {
            revision: 4,
            policyRevision: 2,
            status: 'current',
            preparation,
            choices: { employees: [], workspaces: [], knowledgeSources: [] },
            blockers: [],
          },
        },
      ],
    ]),
  )
  let previews = 0,
    saves = 0,
    refreshes = 0
  const api: ProjectOwnerTaskMaterializationApi = {
    getOwnerTaskMaterialization: async () => ({
      ok: true,
      value: { revision: 0, status: 'none', materialization: null, blockers: [] },
    }),
    listOwnerTaskMaterializationHistory: async () => ({ ok: true, value: [] }),
    previewOwnerTaskMaterialization: async (request) => {
      previews++
      return {
        ok: true,
        value: {
          ...subject,
          input: request.input,
          preparation,
          projections: [
            {
              stepKey: 's',
              title: '一步',
              description: '成果与标准',
              roleKey: 'research',
              outcome: '成果',
              acceptanceCriteria: ['标准'],
              dependencies: [],
              assignee: { userId: 'agent-e', displayName: '执行' },
              workspaceId: 'w',
            },
          ],
          previewFingerprint: 'fingerprint',
        },
      }
    },
    materializeOwnerTasks: async (request) => {
      saves++
      const preview = editor(store).preview
      if (!preview) throw new Error('fixture missing preview')
      return {
        ok: true,
        value: {
          ...subject,
          schemaVersion: 1,
          purpose: 'owner_business_task_materialization',
          id: 'batch',
          revision: 1,
          actor: 'local-user',
          savedAt: 1,
          stage: 'paused_materialized_needs_revalidation',
          input: request.input,
          inputHash: 'ih',
          preview,
          links: [],
          previousIntegrityHash: null,
          integrityHash: 'ih',
        },
      }
    },
  }
  store.set(ownerTaskApiAtom, api)
  store.set(ownerTaskRefreshAtom, {
    listTasks: async () => {
      refreshes++
    },
  })
  return { store, api, preparation, counts: () => ({ previews, saves, refreshes }) }
}
function editor(store: ReturnType<typeof createStore>) {
  return getOwnerTaskEditor(store.get(ownerTaskEditorsAtom), subject)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { resolve, promise }
}
test('Given 当前AO05 When 读取并预览 Then 精确版本输入、无自由patch且主体隔离', async () => {
  const { store } = setup()
  await store.set(loadOwnerTasksAtom, subject)
  expect(ownerTaskInput(store.get, subject)).toEqual({
    requestId: editor(store).requestId,
    expectedMaterializationRevision: 0,
    expectedPreparationId: 'prep-id',
    expectedPreparationRevision: 4,
    expectedPreparationHash: 'prephash',
    expectedPolicyRevision: 2,
  })
  await store.set(previewOwnerTasksAtom, subject)
  expect(canMaterializeOwnerTasks(store.get, subject)).toBe(true)
  expect(
    getOwnerTaskEditor(store.get(ownerTaskEditorsAtom), { projectId: 'a', taskId: 'other' })
      .preview,
  ).toBeNull()
})
test('Given 旧预览 When AO05编辑或计划编辑 Then 立即废弃且不改上游输入', async () => {
  for (const mode of ['prep', 'plan']) {
    const { store } = setup()
    await store.set(loadOwnerTasksAtom, subject)
    await store.set(previewOwnerTasksAtom, subject)
    if (mode === 'prep')
      store.set(editOwnerExecutionAtom, { subject, patch: { changeReason: '新输入' } })
    else store.set(editOwnerPlanAtom, { subject, patch: { summary: '新计划' } })
    expect(editor(store).preview).toBeNull()
    expect(canMaterializeOwnerTasks(store.get, subject)).toBe(false)
    expect(editor(store).requiresReview).toBe(true)
  }
})
test('Given 预览晚到 When 来源变化 Then 不复活旧预览、晚到冲突诊断保留', async () => {
  const { store, api } = setup()
  await store.set(loadOwnerTasksAtom, subject)
  const pending = deferred<Awaited<ReturnType<typeof api.previewOwnerTaskMaterialization>>>()
  store.set(ownerTaskApiAtom, { ...api, previewOwnerTaskMaterialization: () => pending.promise })
  const job = store.set(previewOwnerTasksAtom, subject)
  store.set(editOwnerExecutionAtom, { subject, patch: { changeReason: '保留此输入' } })
  pending.resolve({ ok: false, error: { code: 'conflict', message: '服务端版本冲突' } })
  await job
  expect(editor(store).preview).toBeNull()
  expect(editor(store).error).toBe('服务端版本冲突')
  expect(getOwnerExecutionEditor(store.get(ownerExecutionEditorsAtom), subject).changeReason).toBe(
    '保留此输入',
  )
})
test('Given 预览正在请求 When 重复点击及成功晚到 Then 仅调用一次且丢弃陈旧结果', async () => {
  const { store, api } = setup()
  await store.set(loadOwnerTasksAtom, subject)
  const pending = deferred<Awaited<ReturnType<typeof api.previewOwnerTaskMaterialization>>>()
  let calls = 0
  const response = await api.previewOwnerTaskMaterialization({
    ...subject,
    input: ownerTaskInput(store.get, subject)!,
  })
  store.set(ownerTaskApiAtom, {
    ...api,
    previewOwnerTaskMaterialization: () => {
      calls++
      return pending.promise
    },
  })
  const job = store.set(previewOwnerTasksAtom, subject)
  await store.set(previewOwnerTasksAtom, subject)
  store.set(editOwnerPlanAtom, { subject, patch: { summary: 'changed' } })
  pending.resolve(response)
  await job
  expect(calls).toBe(1)
  expect(editor(store).preview).toBeNull()
})
test('Given 保存冲突 When reload/比较 Then request换新、必须重新预览', async () => {
  const { store, api } = setup()
  await store.set(loadOwnerTasksAtom, subject)
  await store.set(previewOwnerTasksAtom, subject)
  const old = editor(store).requestId
  store.set(ownerTaskApiAtom, {
    ...api,
    materializeOwnerTasks: async () => ({
      ok: false,
      error: { code: 'conflict', message: 'revision冲突' },
    }),
  })
  await store.set(materializeOwnerTasksAtom, subject)
  expect(editor(store).requiresReview).toBe(true)
  expect(canPreviewOwnerTasks(store.get, subject)).toBe(false)
  store.set(compareOwnerTasksAtom, subject)
  expect(editor(store).requiresReview).toBe(true)
  await store.set(loadOwnerTasksAtom, subject)
  store.set(compareOwnerTasksAtom, subject)
  expect(editor(store).requestId).not.toBe(old)
  expect(canPreviewOwnerTasks(store.get, subject)).toBe(true)
  expect(canMaterializeOwnerTasks(store.get, subject)).toBe(false)
})
test('Given 保存成功且列表刷新失败 When 完成 Then 保留成功记录、明确非回滚且不再提交', async () => {
  const { store, counts } = setup()
  await store.set(loadOwnerTasksAtom, subject)
  await store.set(previewOwnerTasksAtom, subject)
  store.set(ownerTaskRefreshAtom, {
    listTasks: async () => {
      throw new Error('离线')
    },
  })
  await store.set(materializeOwnerTasksAtom, subject)
  await store.set(materializeOwnerTasksAtom, subject)
  expect(editor(store).view?.status).toBe('needs_revalidation')
  expect(editor(store).view?.materialization?.id).toBe('batch')
  expect(editor(store).refreshError).toContain('未回滚')
  expect(editor(store).error).toBe('')
  expect(counts().saves).toBe(1)
})
test('Given 保存进行中 When 双击 Then 一次保存并只读刷新一次、晚到保留新计划', async () => {
  const { store, api, counts } = setup()
  await store.set(loadOwnerTasksAtom, subject)
  await store.set(previewOwnerTasksAtom, subject)
  const result = await api.materializeOwnerTasks({
    ...subject,
    input: ownerTaskInput(store.get, subject)!,
    previewFingerprint: 'fingerprint',
  })
  let calls = 0
  const pending = deferred<Awaited<ReturnType<typeof api.materializeOwnerTasks>>>()
  store.set(ownerTaskApiAtom, {
    ...api,
    materializeOwnerTasks: () => {
      calls++
      return pending.promise
    },
  })
  const job = store.set(materializeOwnerTasksAtom, subject)
  await store.set(materializeOwnerTasksAtom, subject)
  store.set(editOwnerPlanAtom, { subject, patch: { summary: '不要覆盖新计划' } })
  pending.resolve(result)
  await job
  expect(calls).toBe(1)
  expect(counts().refreshes).toBe(1)
  expect(editor(store).view?.materialization?.id).toBe('batch')
  expect(getOwnerPlanEditor(store.get(ownerPlanEditorsAtom), subject).summary).toBe(
    '不要覆盖新计划',
  )
})
test('Given 跨subject/篡改preparation预览 When 返回 Then 不可确认并有诊断', async () => {
  for (const mode of ['subject', 'source']) {
    const { store, api } = setup()
    await store.set(loadOwnerTasksAtom, subject)
    const result = await api.previewOwnerTaskMaterialization({
      ...subject,
      input: ownerTaskInput(store.get, subject)!,
    })
    if (!result.ok) throw new Error('fixture')
    const bad: OwnerTaskMaterializationPreview =
      mode === 'subject'
        ? { ...result.value, taskId: 'other' }
        : {
            ...result.value,
            preparation: { ...result.value.preparation, integrityHash: 'different' },
          }
    store.set(ownerTaskApiAtom, {
      ...api,
      previewOwnerTaskMaterialization: async () => ({ ok: true, value: bad }),
    })
    await store.set(previewOwnerTasksAtom, subject)
    expect(editor(store).preview).toBeNull()
    expect(editor(store).error).not.toBe('')
  }
})
test('Given 历史只读 When 跨主体record返回 Then 拒绝且不更改当前preview', async () => {
  const { store, api } = setup()
  await store.set(loadOwnerTasksAtom, subject)
  await store.set(previewOwnerTasksAtom, subject)
  const result = await api.materializeOwnerTasks({
    ...subject,
    input: ownerTaskInput(store.get, subject)!,
    previewFingerprint: 'fingerprint',
  })
  if (!result.ok) throw new Error('fixture')
  const bad: OwnerTaskMaterializationRecord = { ...result.value, taskId: 'other' }
  store.set(ownerTaskApiAtom, {
    ...api,
    listOwnerTaskMaterializationHistory: async () => ({ ok: true, value: [bad] }),
  })
  await store.set(loadOwnerTaskHistoryAtom, subject)
  expect(editor(store).historyError).not.toBe('')
  expect(editor(store).preview).not.toBeNull()
})

test('Given 权威listTasks刷新 When 保存成功 Then 仅替换当前项目任务表、别的项目不变', async () => {
  const { projectTasksAtom } = await import('./project-atoms')
  const { store } = setup()
  const task = {
    id: 'task',
    projectId: 'a',
    title: '暂停任务',
    description: '',
    status: 'paused',
    priority: 'medium' as const,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  store.set(projectTasksAtom, new Map([['other', [{ ...task, projectId: 'other' }]]]))
  store.set(ownerTaskRefreshAtom, { listTasks: async () => [task] })
  await store.set(loadOwnerTasksAtom, subject)
  await store.set(previewOwnerTasksAtom, subject)
  await store.set(materializeOwnerTasksAtom, subject)
  expect(store.get(projectTasksAtom).get('a')).toEqual([task])
  expect(store.get(ownerTaskListRefreshSignalAtom)).toEqual({ projectId: 'a', revision: 1 })
  expect(store.get(projectTasksAtom).get('other')?.[0]?.projectId).toBe('other')
})
test('Given current资料/员工冻结 When AO05 stale/dirty或policy变化 Then 禁止沿用旧预览', async () => {
  for (const mode of ['stale', 'policy', 'hash', 'expired']) {
    const { store } = setup()
    await store.set(loadOwnerTasksAtom, subject)
    await store.set(previewOwnerTasksAtom, subject)
    const e = getOwnerExecutionEditor(store.get(ownerExecutionEditorsAtom), subject)
    if (!e.view?.preparation) throw new Error('fixture')
    const view =
      mode === 'stale'
        ? { ...e.view, status: 'stale' as const }
        : mode === 'policy'
          ? { ...e.view, policyRevision: 9 }
          : {
              ...e.view,
              preparation: {
                ...e.view.preparation,
                ...(mode === 'hash'
                  ? { integrityHash: 'changed' }
                  : { input: { ...e.view.preparation.input, expiresAt: 1 } }),
              },
            }
    store.set(ownerExecutionEditorsAtom, new Map([[key, { ...e, view }]]))
    expect(editor(store).preview).toBeNull()
    expect(canMaterializeOwnerTasks(store.get, subject)).toBe(false)
  }
})
test('Given 已保存历史 When 只读加载 Then 不覆盖当前来源/预览/requestId', async () => {
  const { store, api } = setup()
  await store.set(loadOwnerTasksAtom, subject)
  await store.set(previewOwnerTasksAtom, subject)
  const before = editor(store)
  const result = await api.materializeOwnerTasks({
    ...subject,
    input: ownerTaskInput(store.get, subject)!,
    previewFingerprint: 'fingerprint',
  })
  if (!result.ok) throw new Error('fixture')
  store.set(ownerTaskApiAtom, {
    ...api,
    listOwnerTaskMaterializationHistory: async () => ({ ok: true, value: [result.value] }),
  })
  await store.set(loadOwnerTaskHistoryAtom, subject)
  expect(editor(store).history).toEqual([result.value])
  expect(editor(store).requestId).toBe(before.requestId)
  expect(editor(store).preview).toBe(before.preview)
})
test('Given 只读刷新在途 When 重复点击 Then 只调用一次且保已保存记录', async () => {
  const { refreshOwnerTaskListAtom } = await import('./project-owner-task-atoms')
  const { store } = setup()
  const pending = deferred<void>()
  let calls = 0
  store.set(ownerTaskRefreshAtom, {
    listTasks: () => {
      calls++
      return pending.promise
    },
  })
  const job = store.set(refreshOwnerTaskListAtom, subject)
  expect(editor(store).refreshing).toBe(true)
  await store.set(refreshOwnerTaskListAtom, subject)
  pending.resolve()
  await job
  expect(calls).toBe(1)
  expect(editor(store).refreshing).toBe(false)
})

test('Given singleTask多步或有依赖 When 本地准备可见 Then 首片不预览、不默认拆子任务', async () => {
  for (const mode of ['many', 'dependency']) {
    const { store, preparation } = setup()
    const single = { projectId: 'a', taskId: 'target' }
    const singleKey = '["a","target"]'
    const old = getOwnerExecutionEditor(store.get(ownerExecutionEditorsAtom), subject)
    const changed = {
      ...preparation,
      ...single,
      source: {
        ...preparation.source,
        ...single,
        selectedStepKeys: mode === 'many' ? ['s', 'second'] : ['s'],
        plan: {
          ...preparation.source.plan,
          ...single,
          proposal: {
            ...preparation.source.plan.proposal,
            ...single,
            steps: preparation.source.plan.proposal.steps.map((step) => ({
              ...step,
              dependencies: mode === 'dependency' ? ['upstream'] : [],
            })),
          },
        },
      },
    }
    store.set(
      ownerExecutionEditorsAtom,
      new Map([[singleKey, { ...old, view: { ...old.view!, preparation: changed } }]]),
    )
    const p = getOwnerPlanEditor(store.get(ownerPlanEditorsAtom), subject)
    store.set(ownerPlanEditorsAtom, new Map([[singleKey, { ...p, snapshot: changed.source.plan }]]))
    const g = getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), subject)
    store.set(ownerGoalEditorsAtom, new Map([[singleKey, g]]))
    await store.set(loadOwnerTasksAtom, single)
    expect(canPreviewOwnerTasks(store.get, single)).toBe(false)
    expect(ownerTaskInput(store.get, single)).toBeNull()
  }
})
