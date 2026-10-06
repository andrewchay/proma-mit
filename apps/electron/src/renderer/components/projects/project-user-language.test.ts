import { describe, expect, test } from 'bun:test'
import { buildNextStepItems, describeIntentKind, describeTaskState } from './project-user-language'
import type { PilotIntent, PilotObservation } from '@gravitas/shared'

type TaskState = PilotObservation['tasks'][number]['state']

const ALL_TASK_STATES: TaskState[] = [
  'waiting_dependency', 'awaiting_review', 'needs_attention', 'ready', 'running', 'done', 'inactive',
]
const ALL_INTENT_KINDS: PilotIntent['kind'][] = [
  'dependency_wait', 'ready_candidate', 'review_candidate', 'attention_candidate', 'approval_request',
]

function makeIntent(id: string, kind: PilotIntent['kind'], sourceId = 'task-1', sourceType: PilotIntent['sourceType'] = 'task'): PilotIntent {
  return { id, projectId: 'p1', sourceType, sourceId, sourceVersion: '1', kind, status: 'open', createdAt: 0 }
}

function makeTask(taskId: string, state: TaskState): PilotObservation['tasks'][number] {
  return {
    taskId, rootTaskId: taskId, title: `任务 ${taskId}`, status: 'pending', updatedAt: 0,
    state, reason: '示例原因', blockerTaskIds: [],
  }
}

describe('用户层状态语言（R-P1-02）', () => {
  test('每个任务观察状态都有非空中文标签与下一步', () => {
    for (const state of ALL_TASK_STATES) {
      const language = describeTaskState(state)
      expect(language.label.length).toBeGreaterThan(0)
      expect(language.nextAction.length).toBeGreaterThan(0)
      expect(language.actionKind).not.toBe('none')
    }
  })

  test('每个意图类型都有非空中文标签与下一步', () => {
    for (const kind of ALL_INTENT_KINDS) {
      const language = describeIntentKind(kind)
      expect(language.label.length).toBeGreaterThan(0)
      expect(language.nextAction.length).toBeGreaterThan(0)
    }
  })

  test('下一步行动按优先级排序：人工答复 > 需处理 > 待验收 > 可开始 > 等待依赖', () => {
    const intents = [
      makeIntent('i-ready', 'ready_candidate', 'task-r'),
      makeIntent('i-wait', 'dependency_wait', 'task-w'),
      makeIntent('i-review', 'review_candidate', 'task-v'),
      makeIntent('i-approval', 'approval_request', 'approval-1', 'approval'),
      makeIntent('i-attention', 'attention_candidate', 'decision-1', 'decision'),
    ]
    const items = buildNextStepItems({ tasks: [], attention: [] }, intents, 10)
    expect(items.map((item) => item.id)).toEqual(['i-approval', 'i-attention', 'i-review', 'i-ready', 'i-wait'])
  })

  test('同任务多条意图去重，取最优先一条；默认最多 5 条', () => {
    const intents = [
      makeIntent('a', 'ready_candidate', 'task-1'),
      makeIntent('b', 'dependency_wait', 'task-1'),
      makeIntent('c', 'review_candidate', 'task-2'),
      makeIntent('d', 'ready_candidate', 'task-3'),
      makeIntent('e', 'ready_candidate', 'task-4'),
      makeIntent('f', 'ready_candidate', 'task-5'),
      makeIntent('g', 'ready_candidate', 'task-6'),
    ]
    const items = buildNextStepItems({ tasks: [], attention: [] }, intents)
    expect(items).toHaveLength(5)
    expect(items[0]!.id).toBe('c')
    expect(items.some((item) => item.id === 'b')).toBe(false)
  })

  test('任务来源携带任务观察；stale 意图被排除', () => {
    const observation = { tasks: [makeTask('task-1', 'ready')], attention: [] }
    const items = buildNextStepItems(observation, [
      makeIntent('open', 'ready_candidate', 'task-1'),
      { ...makeIntent('stale', 'review_candidate', 'task-1'), status: 'stale' as const },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe('open')
    expect(items[0]!.task?.taskId).toBe('task-1')
    expect(items[0]!.reason).toBe(describeIntentKind('ready_candidate').nextAction)
  })
})
