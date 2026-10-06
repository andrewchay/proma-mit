import { describe, expect, test } from 'bun:test'
import { inspectTaskReadiness, type TaskReadinessWorld } from './project-task-readiness'
import type { Task } from './project-types'

function makeTask(patch: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    title: 'AI 任务',
    description: '',
    status: 'pending',
    priority: 'medium',
    assignee: { userId: 'agent-emp-1', displayName: 'AI 员工' },
    developmentScope: {
      workspaceId: 'ws-1',
      targetPaths: ['src/a.ts'],
      allowedPaths: ['src'],
      reviewerId: 'local-user',
      decisionIds: ['decision-1'],
    },
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Task
}

function makeWorld(patch: Partial<TaskReadinessWorld> = {}): TaskReadinessWorld {
  return {
    getWorkspace: (id) => ({ id, rootPath: '/tmp/repo' } as never),
    getChain: () => ({ decisions: [{ id: 'decision-1', status: 'decided' } as never] }),
    listExecutions: () => [],
    ...patch,
  }
}

describe('AI 任务 readiness（R-P0-08）', () => {
  test('范围、决策、验收人齐备 → ready，无阻塞', () => {
    const result = inspectTaskReadiness(makeTask(), makeWorld())
    expect(result.phase).toBe('ready')
    expect(result.blockers).toEqual([])
  })

  test('AI 负责人但缺 developmentScope → blocked 且说明不会进入交付', () => {
    const task = makeTask({ developmentScope: undefined })
    const result = inspectTaskReadiness(task, makeWorld())
    expect(result.phase).toBe('blocked')
    expect(result.blockers[0]?.code).toBe('MISSING_DEVELOPMENT_SCOPE')
    expect(result.blockers[0]?.message).toContain('不会进入交付与评审')
  })

  test('决策待拍板 → 给出去哪里拍板的指引', () => {
    const world = makeWorld({ getChain: () => ({ decisions: [{ id: 'decision-1', status: 'candidate' } as never] }) })
    const result = inspectTaskReadiness(makeTask(), world)
    expect(result.blockers.find((b) => b.code === 'DECISION_NOT_DECIDED')?.message).toContain('拍板')
  })

  test('工作区未绑定仓库 → WORKSPACE_INVALID', () => {
    const world = makeWorld({ getWorkspace: () => ({ id: 'ws-1' } as never) })
    const result = inspectTaskReadiness(makeTask(), world)
    expect(result.blockers.find((b) => b.code === 'WORKSPACE_INVALID')).toBeTruthy()
  })

  test('有运行中执行 → running；已取消任务 → closed', () => {
    const running = inspectTaskReadiness(makeTask(), makeWorld({ listExecutions: () => [{ id: 'e1', status: 'running' }] }))
    expect(running.phase).toBe('running')
    const closed = inspectTaskReadiness(makeTask({ status: 'cancelled' }), makeWorld())
    expect(closed.phase).toBe('closed')
  })

  test('有已完成执行且无阻塞 → awaiting_review；普通任务不需要范围', () => {
    const review = inspectTaskReadiness(makeTask(), makeWorld({ listExecutions: () => [{ id: 'e1', status: 'completed' }] }))
    expect(review.phase).toBe('awaiting_review')
    const normal = inspectTaskReadiness(makeTask({ assignee: { userId: 'paa-alice', displayName: 'Alice' }, developmentScope: undefined }), makeWorld())
    expect(normal.phase).toBe('ready')
    expect(normal.blockers).toEqual([])
  })
})
