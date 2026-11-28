import { expect, test } from 'bun:test'
import { findOwnerUnstatedWeekday } from './project-owner-source-facts'

test('Given 原通知只允许给定事实 When 正文补入日期的星期 Then 要求按原目标返工', () => {
  const goal = { projectId: 'p', goalVersion: 1, objective: '12月3日18:30在社区室举行读书活动。只使用以上事实。', constraints: [], acceptanceCriteria: [] }
  expect(findOwnerUnstatedWeekday(goal, '社区读书活动定于**12月3日（星期四）18:30**举行。')).toContain('星期四')
  expect(findOwnerUnstatedWeekday(goal, '社区读书活动定于**12月3日18:30**举行。')).toBeNull()
  expect(findOwnerUnstatedWeekday({ ...goal, objective: goal.objective.replace('3日', '3日周四') }, '12月3日（星期四）18:30')).toBeNull()
  expect(findOwnerUnstatedWeekday({ ...goal, objective: goal.objective.replace('3日', '3日周四') }, '12月4日（星期四）18:30')).toContain('12月4日')
  expect(findOwnerUnstatedWeekday({ ...goal, objective: '策划社区活动，建议一个日期' }, '建议12月3日（星期四）18:30')).toBeNull()
})

test('Given 用户明确给出年份和星期 When 正文更改年份或星期 Then 保留原日期的约束', () => {
  const goal = { projectId: 'p', goalVersion: 1, objective: '只使用给定事实。活动定于2026年12月1日（周二）。', constraints: [], acceptanceCriteria: [] }
  expect(findOwnerUnstatedWeekday(goal, '2027年12月1日（周二）')).toContain('2027年')
  expect(findOwnerUnstatedWeekday(goal, '2026年12月1日，周三')).toContain('周三')
  expect(findOwnerUnstatedWeekday(goal, '12月1日，星期二')).toBeNull()
})
