import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_STATUS_GROUPS,
  builtinTaskStatusSeed,
  isCompletedStatus,
  isDraftStatusId,
  resolveDefaultActiveStatus,
  resolveStateGroup,
} from './task-status-logic'
import type { TaskStatusDef } from './project-types'

/** 用预置种子构造状态定义列表（可追加自定义状态） */
function seedStatuses(extra: Array<Partial<TaskStatusDef> & Pick<TaskStatusDef, 'id' | 'stateGroup'>> = []): TaskStatusDef[] {
  const builtin = builtinTaskStatusSeed().map((item, index) => ({
    id: item.id,
    projectId: 'p1',
    name: item.name,
    stateGroup: item.stateGroup,
    position: item.position,
    isBuiltin: true,
    isDefault: item.isDefault,
    createdAt: index,
  }))
  return [
    ...builtin,
    ...extra.map((item): TaskStatusDef => ({
      projectId: 'p1',
      position: 99,
      isBuiltin: false,
      isDefault: false,
      createdAt: 0,
      id: item.id,
      name: item.name ?? item.id,
      stateGroup: item.stateGroup,
      color: item.color,
      wipLimit: item.wipLimit,
    })),
  ]
}

describe('State 分组语义', () => {
  test('Given 预置五态 When 解析语义组 Then 与种子表一致', () => {
    const statuses = seedStatuses()
    expect(resolveStateGroup('draft', statuses)).toBe('backlog')
    expect(resolveStateGroup('pending', statuses)).toBe('unstarted')
    expect(resolveStateGroup('in_progress', statuses)).toBe('started')
    expect(resolveStateGroup('paused', statuses)).toBe('started')
    expect(resolveStateGroup('completed', statuses)).toBe('completed')
  })

  test('Given 项目自定义状态 When 解析语义组 Then 使用项目定义而非预置表', () => {
    const statuses = seedStatuses([{ id: 'sts_uat', stateGroup: 'completed', name: '已验收' }])
    expect(resolveStateGroup('sts_uat', statuses)).toBe('completed')
    expect(isCompletedStatus('sts_uat', statuses)).toBe(true)
  })

  test('Given 状态定义缺失的旧 id When 解析语义组 Then 兜底到预置表', () => {
    expect(resolveStateGroup('completed', [])).toBe('completed')
    expect(resolveStateGroup('paused', [])).toBe('started')
  })

  test('Given 完全未知的状态 id When 解析语义组 Then 兜底为 unstarted', () => {
    expect(resolveStateGroup('sts_deleted', [])).toBe('unstarted')
    expect(isCompletedStatus('sts_deleted', [])).toBe(false)
  })

  test('Given 处于 completed 组的状态 When 判断完成 Then 为真；非 completed 组为假', () => {
    const statuses = seedStatuses([{ id: 'sts_ship', stateGroup: 'cancelled', name: '已取消' }])
    expect(isCompletedStatus('completed', statuses)).toBe(true)
    expect(isCompletedStatus('in_progress', statuses)).toBe(false)
    expect(isCompletedStatus('sts_ship', statuses)).toBe(false)
  })

  test('Given 任意输入 When 判断草稿 Then 仅字面 draft 为草稿', () => {
    expect(isDraftStatusId('draft')).toBe(true)
    expect(isDraftStatusId('sts_backlog_x')).toBe(false)
  })

  test('Given 状态列表 When 解析默认初始状态 Then 取 isDefault 项，缺失兜底 pending', () => {
    expect(resolveDefaultActiveStatus(seedStatuses())).toBe('pending')
    expect(resolveDefaultActiveStatus([])).toBe('pending')
  })

  test('Given 预置种子 When 检查 Then 五态齐全且只有 pending 是默认态', () => {
    const seed = builtinTaskStatusSeed()
    expect(seed.map((item) => item.id)).toEqual(['draft', 'pending', 'in_progress', 'paused', 'completed'])
    expect(seed.filter((item) => item.isDefault).map((item) => item.id)).toEqual(['pending'])
    expect(Object.keys(BUILTIN_STATUS_GROUPS)).toHaveLength(5)
  })
})
