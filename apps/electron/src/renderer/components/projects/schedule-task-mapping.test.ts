import { describe, expect, test } from 'bun:test'
import { projectStateGroupToScheduleStatus, timestampToDueDate, projectPriorityToSchedulePriority, projectTaskToScheduleTask } from './schedule-task-mapping'

describe('项目任务映射到日程视图', () => {
  test('语义组 → 日程状态', () => {
    expect(projectStateGroupToScheduleStatus('started')).toBe('in-progress')
    expect(projectStateGroupToScheduleStatus('unstarted')).toBe('todo')
    expect(projectStateGroupToScheduleStatus('backlog')).toBe('todo')
  })

  test('时间戳 → 本地 YYYY-MM-DD（横杠）', () => {
    expect(timestampToDueDate(new Date(2026, 8, 20, 12).getTime())).toBe('2026-09-20')
    expect(timestampToDueDate(new Date(2026, 0, 3, 8).getTime())).toBe('2026-01-03')
  })

  test('优先级 critical → urgent', () => {
    expect(projectPriorityToSchedulePriority('critical')).toBe('urgent')
    expect(projectPriorityToSchedulePriority('high')).toBe('high')
  })

  test('完整映射：id 前缀 + category 带项目名', () => {
    const mapped = projectTaskToScheduleTask({
      id: 't1', projectId: 'p1', projectTitle: '官网改版', title: '写周报',
      status: 'in_progress', stateGroup: 'started', priority: 'critical',
      dueDate: new Date(2026, 8, 20, 12).getTime(),
    })
    expect(mapped.id).toBe('project-t1')
    expect(mapped.status).toBe('in-progress')
    expect(mapped.priority).toBe('urgent')
    expect(mapped.dueDate).toBe('2026-09-20')
    expect(mapped.category).toBe('project:官网改版')
  })
})
