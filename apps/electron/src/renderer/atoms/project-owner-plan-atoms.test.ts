import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from 'jotai/vanilla'
import type { ProjectOwnerPlanApi, ProjectOwnerPlanDraft, ProjectOwnerPlanningContext } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
import { acknowledgeOwnerPlanComparisonAtom, confirmOwnerPlanAtom, editOwnerPlanAtom, getOwnerPlanEditor, loadOwnerPlanAtom, loadOwnerPlanHistoryAtom, ownerPlanApiAtom, ownerPlanEditorsAtom, saveOwnerPlanAtom } from './project-owner-plan-atoms'
const original = process.env.PROMA_TEST_CONFIG_DIR
const directory = mkdtempSync(join(tmpdir(), 'owner-plan-atoms-'))
process.env.PROMA_TEST_CONFIG_DIR = directory
afterAll(() => { if (original === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = original; rmSync(directory, { recursive: true, force: true }) })
const subject = { projectId: 'a' }
function plan(revision = 1, state: ProjectOwnerPlanDraft['state'] = 'proposed', projectId = 'a'): ProjectOwnerPlanDraft {
  return { ...subject, projectId, schemaVersion: 1, revision, planVersion: revision, goalRevision: 1, goalVersion: 1, state, actor: 'local-user', origin: 'manual', savedAt: 1, changeReason: '修订依据', contextFingerprint: 'context', planFingerprint: `plan-${revision}`, sources: { project: { id: projectId, title: '项目', description: '' }, roles: [{ key: 'research', name: '研究岗位', version: '1', sourceSha256: 's', rulesSha256: 'r' }] }, proposal: { projectId, goalVersion: 1, mode: 'proposal_only', summary: `计划${revision}`, assumptions: ['假设'], risks: ['风险'], steps: [{ key: 's1', title: '调研', outcome: '报告', acceptanceCriteria: ['可评审'], dependencies: [], roleKey: 'research' }] } }
}
function setup(api: Partial<ProjectOwnerPlanApi> = {}) {
  const store = createStore(); let writes = 0; let confirms = 0
  const context: ProjectOwnerPlanningContext = { goal: { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1, goal: { ...subject, goalVersion: 1, objective: '目标', constraints: [], acceptanceCriteria: [] } }, sources: plan().sources, fingerprint: 'context' }
  store.set(ownerGoalEditorsAtom, new Map([['["a",null]', { ...getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: context.goal }]]))
  store.set(ownerPlanApiAtom, { getOwnerPlanDraft: async () => ({ ok: true, value: plan() }), getOwnerPlanningContext: async () => ({ ok: true, value: context }), listOwnerPlanHistory: async () => ({ ok: true, value: [] }), saveOwnerPlanDraft: async () => { writes++; return { ok: true, value: plan(2) } }, confirmOwnerPlanDraft: async () => { confirms++; return { ok: true, value: plan(3, 'confirmed') } }, ...api })
  return { store, read: (s = subject) => getOwnerPlanEditor(store.get(ownerPlanEditorsAtom), s), writes: () => writes, confirms: () => confirms }
}
test('Given 无计划 When 加载和尝试保存确认 Then 空态零写入', async () => {
  const f = setup({ getOwnerPlanDraft: async () => ({ ok: true, value: null }) }); await f.store.set(loadOwnerPlanAtom, subject); await f.store.set(saveOwnerPlanAtom, subject); await f.store.set(confirmOwnerPlanAtom, subject)
  expect(f.read().snapshot).toBeNull(); expect(f.writes()).toBe(0); expect(f.confirms()).toBe(0)
})
test('Given 已有计划 When 修订保存 Then 新版本 proposed，之后才可确认', async () => {
  const f = setup(); await f.store.set(loadOwnerPlanAtom, subject)
  f.store.set(editOwnerPlanAtom, { subject, patch: { summary: '修订', changeReason: '补充证据' } }); await f.store.set(confirmOwnerPlanAtom, subject); expect(f.confirms()).toBe(0)
  await f.store.set(saveOwnerPlanAtom, subject); expect(f.read().snapshot?.revision).toBe(2); expect(f.read().dirty).toBe(false)
  await f.store.set(confirmOwnerPlanAtom, subject); expect(f.confirms()).toBe(1)
})
test('Given stale或目标未保存/冲突 When 确认或保存 Then 禁止写入', async () => {
  const f = setup({ getOwnerPlanDraft: async () => ({ ok: true, value: plan(1, 'stale') }) }); await f.store.set(loadOwnerPlanAtom, subject); await f.store.set(confirmOwnerPlanAtom, subject); expect(f.confirms()).toBe(0)
  for (const patch of [{ dirty: true }, { conflict: true }, { requiresReview: true }]) {
    f.store.set(ownerGoalEditorsAtom, new Map([['["a",null]', { ...getOwnerGoalEditor(f.store.get(ownerGoalEditorsAtom), subject), ...patch }]]))
    f.store.set(editOwnerPlanAtom, { subject, patch: { summary: '修订', changeReason: '更新' } }); await f.store.set(saveOwnerPlanAtom, subject)
  }
  expect(f.writes()).toBe(0)
})
test('Given 加载晚到 When 输入变化/切换主体 Then 输入保留且主体隔离', async () => {
  let resolve!: (value: Awaited<ReturnType<ProjectOwnerPlanApi['getOwnerPlanDraft']>>) => void
  const pending = new Promise<Awaited<ReturnType<ProjectOwnerPlanApi['getOwnerPlanDraft']>>>(done => { resolve = done })
  const f = setup({ getOwnerPlanDraft: () => pending }); const loading = f.store.set(loadOwnerPlanAtom, subject)
  f.store.set(editOwnerPlanAtom, { subject, patch: { summary: '晚到前输入' } }); f.store.set(editOwnerPlanAtom, { subject: { projectId: 'b' }, patch: { summary: 'B输入' } })
  resolve({ ok: true, value: plan() }); await loading
  expect(f.read().summary).toBe('晚到前输入'); expect(f.read().requiresReview).toBe(true); expect(f.read({ projectId: 'b' }).summary).toBe('B输入')
})
test('Given 保存晚到 When 继续输入 Then 仅更新快照不覆盖输入', async () => {
  let resolve!: (value: Awaited<ReturnType<ProjectOwnerPlanApi['saveOwnerPlanDraft']>>) => void
  const f = setup({ saveOwnerPlanDraft: () => new Promise(done => { resolve = done }) }); await f.store.set(loadOwnerPlanAtom, subject)
  f.store.set(editOwnerPlanAtom, { subject, patch: { summary: '首次', changeReason: '原因' } }); const saving = f.store.set(saveOwnerPlanAtom, subject)
  f.store.set(editOwnerPlanAtom, { subject, patch: { summary: '继续输入' } }); resolve({ ok: true, value: plan(2) }); await saving
  expect(f.read().summary).toBe('继续输入'); expect(f.read().dirty).toBe(true); expect(f.read().snapshot?.revision).toBe(2)
})
test('Given 冲突 When 加载最新 Then 必须显式比较，不自动重试', async () => {
  let revision = 1; let writes = 0
  const f = setup({ getOwnerPlanDraft: async () => ({ ok: true, value: plan(revision) }), saveOwnerPlanDraft: async () => { writes++; return { ok: false, error: { code: 'conflict', message: '冲突' } } } })
  await f.store.set(loadOwnerPlanAtom, subject); f.store.set(editOwnerPlanAtom, { subject, patch: { summary: '保留输入', changeReason: '原因' } }); await f.store.set(saveOwnerPlanAtom, subject)
  await f.store.set(saveOwnerPlanAtom, subject); expect(writes).toBe(1)
  revision = 2; await f.store.set(loadOwnerPlanAtom, subject); expect(f.read().summary).toBe('保留输入'); expect(f.read().requiresReview).toBe(true)
  await f.store.set(saveOwnerPlanAtom, subject); expect(writes).toBe(1)
  f.store.set(acknowledgeOwnerPlanComparisonAtom, subject); await f.store.set(saveOwnerPlanAtom, subject); expect(writes).toBe(2)
})
test('Given stale When 基于最新来源重新保存 Then 新 proposed 版本可确认', async () => {
  const f = setup({ getOwnerPlanDraft: async () => ({ ok: true, value: plan(1, 'stale') }) }); await f.store.set(loadOwnerPlanAtom, subject)
  f.store.set(editOwnerPlanAtom, { subject, patch: { changeReason: '按最新来源修订' } }); await f.store.set(saveOwnerPlanAtom, subject)
  expect(f.writes()).toBe(1); expect(f.read().snapshot?.state).toBe('proposed'); await f.store.set(confirmOwnerPlanAtom, subject); expect(f.confirms()).toBe(1)
})
test('Given 非当前主体响应/计划接口缺失 When 加载 Then 局部失败禁止写入', async () => {
  for (const getOwnerPlanDraft of [async () => ({ ok: true as const, value: plan(1, 'proposed', 'wrong') }), async () => { throw new Error('旧API缺少计划方法') }]) {
    const f = setup({ getOwnerPlanDraft }); await f.store.set(loadOwnerPlanAtom, subject)
    expect(f.read().loaded).toBe(false); expect(f.read().error).not.toBe(''); await f.store.set(confirmOwnerPlanAtom, subject); expect(f.confirms()).toBe(0)
  }
})
test('Given 已载计划 When 目标保存版本改变/依赖循环 Then 写入门禁拒绝', async () => {
  const f = setup(); await f.store.set(loadOwnerPlanAtom, subject)
  f.store.set(editOwnerPlanAtom, { subject, patch: { changeReason: '原因', steps: [ { ...plan().proposal.steps[0]!, dependencies: ['s2'] }, { ...plan().proposal.steps[0]!, key: 's2', dependencies: ['s1'] } ] } })
  await f.store.set(saveOwnerPlanAtom, subject); expect(f.writes()).toBe(0)
  const goal = getOwnerGoalEditor(f.store.get(ownerGoalEditorsAtom), subject)
  f.store.set(ownerGoalEditorsAtom, new Map([['["a",null]', { ...goal, snapshot: { ...goal.snapshot!, revision: 2 } }]]))
  f.store.set(editOwnerPlanAtom, { subject, patch: { steps: plan().proposal.steps } }); await f.store.set(saveOwnerPlanAtom, subject); expect(f.writes()).toBe(0)
})
test('Given 当前任务 When 切换同项目另一任务 Then 编辑与历史严格隔离', async () => {
  const f = setup(); const task = { projectId: 'a', taskId: 'task-a' }
  f.store.set(editOwnerPlanAtom, { subject: task, patch: { summary: '任务专属' } }); await f.store.set(loadOwnerPlanAtom, subject)
  expect(f.read(task).summary).toBe('任务专属'); expect(f.read().summary).toBe('计划1')
})
test('Given 当前计划 When 保存 Then 精确绑定主体/目标/计划revision与最新来源指纹', async () => {
  let request: Parameters<ProjectOwnerPlanApi['saveOwnerPlanDraft']>[0] | undefined
  const f = setup({ saveOwnerPlanDraft: async r => { request = r; return { ok: true, value: plan(2) } } }); await f.store.set(loadOwnerPlanAtom, subject)
  f.store.set(editOwnerPlanAtom, { subject, patch: { summary: '修订', changeReason: '依据', assumptions: ['  假设  ', ''], risks: [' 风险 '], steps: [{ ...plan().proposal.steps[0]!, dependencies: [''] }] } })
  await f.store.set(saveOwnerPlanAtom, subject)
  expect(request).toMatchObject({ projectId: 'a', expectedRevision: 1, expectedGoalRevision: 1, input: { expectedContextFingerprint: 'context', summary: '修订', changeReason: '依据', assumptions: ['假设'], risks: ['风险'] } })
  expect(request?.input.steps[0]?.dependencies).toEqual([])
})
test('Given 确认晚到 When 修改当前内容 Then 只更新快照，输入仍未保存不能再次确认', async () => {
  let resolve!: (value: Awaited<ReturnType<ProjectOwnerPlanApi['confirmOwnerPlanDraft']>>) => void
  const f = setup({ confirmOwnerPlanDraft: () => new Promise(done => { resolve = done }) }); await f.store.set(loadOwnerPlanAtom, subject)
  const confirming = f.store.set(confirmOwnerPlanAtom, subject)
  f.store.set(editOwnerPlanAtom, { subject, patch: { summary: '确认途中继续修订' } }); resolve({ ok: true, value: plan(2, 'confirmed') }); await confirming
  expect(f.read().summary).toBe('确认途中继续修订'); expect(f.read().dirty).toBe(true); expect(f.read().snapshot?.state).toBe('confirmed')
})
test('Given 历史已确认 When 加载历史 Then 不改变当前草案或沿用确认', async () => {
  const f = setup({ listOwnerPlanHistory: async () => ({ ok: true, value: [plan(1, 'confirmed')] }) }); await f.store.set(loadOwnerPlanAtom, subject); await f.store.set(loadOwnerPlanHistoryAtom, subject)
  expect(f.read().history[0]?.state).toBe('confirmed'); expect(f.read().snapshot?.state).toBe('proposed'); expect(f.confirms()).toBe(0)
})
test('Given 历史晚到/错误主体 When 加载 Then 按主体隔离并拒绝错误历史', async () => {
  let resolve!: (value: Awaited<ReturnType<ProjectOwnerPlanApi['listOwnerPlanHistory']>>) => void
  const f = setup({ listOwnerPlanHistory: () => new Promise(done => { resolve = done }) }); const loading = f.store.set(loadOwnerPlanHistoryAtom, subject)
  const other = { projectId: 'b', taskId: 't' }; f.store.set(editOwnerPlanAtom, { subject: other, patch: { summary: 'B任务' } })
  resolve({ ok: true, value: [plan()] }); await loading; expect(f.read(other).history).toEqual([]); expect(f.read(other).summary).toBe('B任务')
  const bad = setup({ listOwnerPlanHistory: async () => ({ ok: true, value: [plan(1, 'confirmed', 'wrong')] }) }); await bad.store.set(loadOwnerPlanHistoryAtom, subject); expect(bad.read().historyLoaded).toBe(false); expect(bad.read().historyError).toContain('主体')
})
test('Given 修改无原因 When 保存 Then 必填修订原因，不产生新版本', async () => {
  const f = setup(); await f.store.set(loadOwnerPlanAtom, subject); f.store.set(editOwnerPlanAtom, { subject, patch: { summary: '修改但缺原因', changeReason: ' ' } }); await f.store.set(saveOwnerPlanAtom, subject); expect(f.writes()).toBe(0)
})

test('Given 内容超出服务上限 When 点击保存 Then UI拦截而不是发送必失败请求', async () => {
  const f = setup(); await f.store.set(loadOwnerPlanAtom, subject)
  const valid = { summary: '修订', changeReason: '原因', steps: plan().proposal.steps }
  for (const patch of [
    { summary: 'x'.repeat(2001) }, { changeReason: 'x'.repeat(2001) },
    { steps: [{ ...plan().proposal.steps[0]!, title: 'x'.repeat(301) }] },
    { steps: [{ ...plan().proposal.steps[0]!, outcome: 'x'.repeat(2001) }] },
    { risks: Array.from({ length: 33 }, (_, i) => `风险${i}`) },
    { steps: [{ ...plan().proposal.steps[0]!, acceptanceCriteria: ['x'.repeat(2001)] }] },
  ]) {
    f.store.set(editOwnerPlanAtom, { subject, patch: { ...valid, risks: [], ...patch } })
    await f.store.set(saveOwnerPlanAtom, subject)
  }
  expect(f.writes()).toBe(0)
})
