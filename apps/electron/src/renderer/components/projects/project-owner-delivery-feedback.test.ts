import { expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { ProjectOwnerGoalDraft, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from '@/atoms/project-owner-goal-atoms'
import { addOwnerDeliveryFeedbackToGoalAtom, applyOwnerDeliveryFeedback } from './project-owner-delivery-feedback'

test('Given审阅者提出有效意见 When应用到交付命令 Then按精确命令替换草案意见并保留其他约束', () => {
  expect(applyOwnerDeliveryFeedback(['不能发布', 'Owner交付修改意见（命令 cmd-1）：旧意见'], 'cmd-1', '  补充验证   正常数量  ')).toEqual({
    ok: true, constraints: ['不能发布', 'Owner交付修改意见：补充验证 正常数量'],
  })
})

test('Given意见为空/过长/命令ID非法或容量已满 When应用意见 Then拒绝且不产生草案', () => {
  expect(applyOwnerDeliveryFeedback([], 'cmd-1', '  ')).toEqual({ ok: false, reason: 'invalid' })
  expect(applyOwnerDeliveryFeedback([], 'cmd-1', 'x'.repeat(1801))).toEqual({ ok: false, reason: 'too_long' })
  expect(applyOwnerDeliveryFeedback([], '命令/伪造', '修改')).toEqual({ ok: false, reason: 'invalid' })
  expect(applyOwnerDeliveryFeedback(Array.from({ length: 32 }, (_, i) => `限制${i}`), 'cmd-1', '修改')).toEqual({ ok: false, reason: 'too_many' })
})

test('Given项目与Task Goal隔离 When对具体交付提交意见 Then只编辑对应未保存Task草案', async () => {
  const store = createStore(), project = { projectId: 'p' }, task = { projectId: 'p', taskId: 't' }
  const makeGoal = (subject: typeof project | typeof task): ProjectOwnerGoalDraft => ({ schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1, goal: { ...subject, goalVersion: 1, objective: '完成任务', constraints: ['原约束'], acceptanceCriteria: [] } })
  const subjects: ProjectOwnerGoalSubject[] = [project, task]
  const entries = subjects.map(subject => [JSON.stringify([subject.projectId, subject.taskId ?? null]), { ...getOwnerGoalEditor(new Map(), subject), snapshot: makeGoal(subject), loaded: true, objective: '完成任务', constraintsText: '原约束', criteriaText: '' }] as const)
  store.set(ownerGoalEditorsAtom, new Map(entries))
  const result = await store.set(addOwnerDeliveryFeedbackToGoalAtom, { ...task, commandId: 'delivery-1', feedback: '补充验收正常边界' })
  expect(result).toEqual({ ok: true })
  expect(getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), project).constraintsText).toBe('原约束')
  expect(getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), task).constraintsText).toContain('Owner交付修改意见：补充验收正常边界')
  expect(getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), task).constraintsText).not.toContain('delivery-1')
  expect(getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), task).dirty).toBe(true)
})

test('Given材料化Task尚无Goal When提交带冻结标准的交付意见 Then建立本地草案且不保存、不授权', async () => {
  const store = createStore(), subject = { projectId: 'p', taskId: 'fresh-task' }
  store.set(ownerGoalEditorsAtom, new Map([[JSON.stringify(['p', 'fresh-task']), { ...getOwnerGoalEditor(new Map(), subject), loaded: true }]]))
  const result = await store.set(addOwnerDeliveryFeedbackToGoalAtom, { ...subject, commandId: 'cmd', feedback: '补充来源', delivery: { title: '产品定位方案', acceptanceCriteria: ['有引用', '有取舍'] } })
  const draft = getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), subject)
  expect(result.ok).toBe(true)
  expect(draft.snapshot).toBeNull()
  expect(draft.objective).toBe('产品定位方案')
  expect(draft.criteriaText).toBe('有引用\n有取舍')
  expect(draft.constraintsText).toContain('Owner交付修改意见：补充来源')
  expect(draft.constraintsText).not.toContain('cmd')
  expect(draft.codeSourceAccess).toBe('none')
})
