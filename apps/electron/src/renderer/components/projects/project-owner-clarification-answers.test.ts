import { expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { ProjectOwnerGoalDraft, ProjectOwnerPlanDraft } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalApiAtom, ownerGoalEditorsAtom } from '../../atoms/project-owner-goal-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from '../../atoms/project-owner-plan-atoms'
import { getOwnerRuntimeEditor, ownerRuntimeEditorsAtom } from '../../atoms/project-owner-runtime-atoms'
import { applyOwnerClarificationAnswers, applyOwnerClarificationAnswersToGoalAtom } from './project-owner-clarification-answers'

const questions = [
  { key: 'audience', reasonType: 'missing_information' as const, question: '主要面向谁？', why: '影响方案重点。', options: ['新用户', '现有用户'], recommended: '新用户' },
  { key: 'format', reasonType: 'missing_information' as const, question: '交付形式是什么？', why: '影响成果标准。', options: [] },
]

function setCurrentClarificationRun(store: ReturnType<typeof createStore>, subject: { projectId: string; taskId?: string }, goal: ProjectOwnerGoalDraft) {
  const executionId = 'execution', linkId = 'link', contextFingerprint = 'a'.repeat(64)
  const run = {
    link: { schemaVersion: 1 as const, id: linkId, projectId: subject.projectId, requestId: 'request', planningTaskId: 'planning-task', ...(subject.taskId ? { targetTaskId: subject.taskId } : {}), bindingRevision: 1, goalRevision: goal.revision, goalVersion: goal.goal.goalVersion, planRevision: 0, contextFingerprint, carrierFingerprint: 'b'.repeat(64), protocolVersion: '2' as const, promptHash: 'c'.repeat(64), purpose: 'owner_planning' as const, maxRequests: 1 as const, maxOutputTokens: 8192 as const, createdAt: 1 },
    executions: [{ id: executionId, sessionId: 'session', status: 'completed' as const, summary: 'need answer' }], receipts: [],
    outcomes: [{ executionId, receiptId: 'receipt', state: 'needs_clarification' as const, detail: '需要澄清', clarification: { projectId: subject.projectId, ...(subject.taskId ? { taskId: subject.taskId } : {}), goalVersion: goal.goal.goalVersion, contextFingerprint, reason: '需要澄清', questions } }],
  }
  const runtime = getOwnerRuntimeEditor(new Map(), subject)
  store.set(ownerRuntimeEditorsAtom, new Map([[JSON.stringify([subject.projectId, subject.taskId ?? null]), { ...runtime, context: { goal, fingerprint: contextFingerprint, sources: { project: { id: subject.projectId, title: '项目', description: '' }, ...(subject.taskId ? { task: { id: subject.taskId, projectId: subject.projectId, title: '任务', description: '' } } : {}), roles: [{ key: 'owner', name: 'Owner', version: '1', sourceSha256: 'd'.repeat(64), rulesSha256: 'e'.repeat(64) }] } }, runs: [run] }]]))
  return { executionId, linkId, contextFingerprint }
}

test('Given 答复不完整 When 应用澄清 Then 返回错误且不修改原约束', () => {
  const original = ['保留原有约束']
  const result = applyOwnerClarificationAnswers(original, questions, { audience: '新用户' })
  expect(result.ok).toBe(false)
  expect(original).toEqual(['保留原有约束'])
})

test('Given 全部答复 When 应用澄清 Then 返回可审阅的新约束草案且保留原文顺序', () => {
  const result = applyOwnerClarificationAnswers(['原约束一', '原约束二'], questions, { audience: '现有用户', format: '方案报告' })
  expect(result).toEqual({ ok: true, constraints: [
    '原约束一', '原约束二', 'Owner澄清答复（主要面向谁？）：现有用户', 'Owner澄清答复（交付形式是什么？）：方案报告',
  ] })
})

test('Given 同题已有答复 When 应用新答复 Then 替换旧条目而不重复', () => {
  const result = applyOwnerClarificationAnswers(['稳定约束', 'Owner澄清答复（主要面向谁？）：新用户'], questions.slice(0, 1), { audience: '现有用户' })
  expect(result).toEqual({ ok: true, constraints: ['稳定约束', 'Owner澄清答复（主要面向谁？）：现有用户'] })
})

test('Given 答复超长或Goal约束数将超限 When 应用 Then 拒绝且不截断', () => {
  const tooLong = applyOwnerClarificationAnswers([], questions.slice(0, 1), { audience: 'x'.repeat(2000) })
  expect(tooLong.ok).toBe(false)
  const full = Array.from({ length: 32 }, (_, index) => `约束${index}`)
  const tooMany = applyOwnerClarificationAnswers(full, questions.slice(0, 1), { audience: '新用户' })
  expect(tooMany.ok).toBe(false)
  expect(full).toHaveLength(32)
})

test('Given 当前Goal草案有效 When 应用答复 Then 只编辑Jotai草案，不调用保存接口', () => {
  const store = createStore()
  const subject = { projectId: 'p' }
  const goal: ProjectOwnerGoalDraft = { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1, goal: { ...subject, goalVersion: 1, objective: '形成方案', constraints: ['已有约束'], acceptanceCriteria: [] } }
  store.set(ownerGoalEditorsAtom, new Map([['["p",null]', { ...getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: goal, objective: goal.goal.objective, constraintsText: '已有约束', criteriaText: '' }]]))
  const identity = setCurrentClarificationRun(store, subject, goal)
  let saves = 0
  store.set(ownerGoalApiAtom, { getOwnerGoalDraft: async () => ({ ok: true, value: goal }), saveOwnerGoalDraft: async () => { saves++; return { ok: true, value: goal } } })
  const result = store.set(applyOwnerClarificationAnswersToGoalAtom, { subject, ...identity, questions, answers: { audience: '现有用户', format: '方案报告' } })
  expect(result.ok).toBe(true)
  const editor = getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), subject)
  expect(editor.dirty).toBe(true)
  expect(editor.constraintsText).toContain('Owner澄清答复（主要面向谁？）：现有用户')
  expect(editor.snapshot).toEqual(goal)
  expect(saves).toBe(0)
})

test('Given Goal版本冲突未解决 When 应用答复 Then 拒绝且不改变未保存输入', () => {
  const store = createStore()
  const subject = { projectId: 'p' }
  const goal: ProjectOwnerGoalDraft = { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1, goal: { ...subject, goalVersion: 1, objective: '目标', constraints: ['原约束'], acceptanceCriteria: [] } }
  const original = { ...getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: goal, objective: '目标', constraintsText: '原约束', criteriaText: '', conflict: true }
  store.set(ownerGoalEditorsAtom, new Map([['["p",null]', original]]))
  const result = store.set(applyOwnerClarificationAnswersToGoalAtom, { subject, executionId: 'execution', linkId: 'link', questions, answers: { audience: '新用户', format: '方案报告' } })
  expect(result).toEqual({ ok: false, reason: 'goal_unavailable' })
  expect(getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), subject)).toEqual(original)
})

test('Given 项目和任务Goal同时存在 When 对任务应用澄清 Then 仅改指定项目任务草案', () => {
  const store = createStore()
  const subjects = [{ projectId: 'p' }, { projectId: 'p', taskId: 'task-1' }, { projectId: 'other' }]
  const entries = subjects.map((subject, index) => {
    const goal: ProjectOwnerGoalDraft = { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1, goal: { ...subject, goalVersion: 1, objective: `目标${index}`, constraints: [`原约束${index}`], acceptanceCriteria: [] } }
    return [JSON.stringify([subject.projectId, subject.taskId ?? null]), { ...getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: goal, objective: goal.goal.objective, constraintsText: goal.goal.constraints.join('\n'), criteriaText: '' }] as const
  })
  store.set(ownerGoalEditorsAtom, new Map(entries))
  const identity = setCurrentClarificationRun(store, subjects[1]!, entries[1]![1].snapshot!)
  const result = store.set(applyOwnerClarificationAnswersToGoalAtom, { subject: subjects[1]!, ...identity, questions, answers: { audience: '现有用户', format: '方案报告' } })
  expect(result.ok).toBe(true)
  expect(getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), subjects[0]!).constraintsText).toBe('原约束0')
  expect(getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), subjects[1]!).constraintsText).toContain('Owner澄清答复（主要面向谁？）：现有用户')
  expect(getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), subjects[2]!).constraintsText).toBe('原约束2')
})

test('Given 问题来源之后计划修订 When 应用旧答复 Then 拒绝并保留Goal草案', () => {
  const store = createStore(), subject = { projectId: 'p' }
  const goal: ProjectOwnerGoalDraft = { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1, goal: { ...subject, goalVersion: 1, objective: '目标', constraints: ['原约束'], acceptanceCriteria: [] } }
  store.set(ownerGoalEditorsAtom, new Map([['["p",null]', { ...getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: goal, objective: '目标', constraintsText: '原约束', criteriaText: '' }]]))
  const identity = setCurrentClarificationRun(store, subject, goal)
  const changedPlan: ProjectOwnerPlanDraft = { ...subject, schemaVersion: 1, revision: 1, planVersion: 1, goalRevision: 1, goalVersion: 1, state: 'proposed', actor: 'local-user', origin: 'manual', savedAt: 2, changeReason: '计划已变化', contextFingerprint: identity.contextFingerprint, planFingerprint: 'f'.repeat(64), sources: { project: { id: 'p', title: '项目', description: '' }, roles: [] }, proposal: { ...subject, goalVersion: 1, mode: 'proposal_only', summary: '新计划', assumptions: [], risks: [], steps: [] } }
  const plan = getOwnerPlanEditor(new Map(), subject)
  store.set(ownerPlanEditorsAtom, new Map([['["p",null]', { ...plan, snapshot: changedPlan }]]))
  const original = getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), subject)
  const result = store.set(applyOwnerClarificationAnswersToGoalAtom, { subject, ...identity, questions, answers: { audience: '新用户', format: '方案报告' } })
  expect(result).toEqual({ ok: false, reason: 'source_stale' })
  expect(getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), subject)).toEqual(original)
})


test('Given 不同key却重复问句 When 合并答复 Then 拒绝而不无声覆盖其中一个答案', () => {
  expect(applyOwnerClarificationAnswers([], [{ key: 'a', question: '同一问题？' }, { key: 'b', question: '同一问题？' }], { a: '第一答复', b: '第二答复' })).toEqual({ ok: false, reason: 'invalid' })
})
