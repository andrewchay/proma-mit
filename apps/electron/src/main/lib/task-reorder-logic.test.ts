/**
 * 任务排序纯逻辑测试 — Task Reorder Logic Test
 *
 * 覆盖中点法四象限：头插 / 尾插 / 中间插入（中点）/ 间隙耗尽整列重编号。
 */
import { describe, expect, test } from 'bun:test'
import { computeReorderPlan, MIN_SORT_GAP, RENUMBER_SPACING } from './task-reorder-logic'

/** 按顺序构造列内任务 id 与 sort_order 的查找表 */
function orders(ids: number[]): Map<string, number> {
  return new Map(ids.map((id, index) => [`t${id}`, (index + 1) * RENUMBER_SPACING]))
}

describe('computeReorderPlan 排序方案', () => {
  test('Given 空列 When 放入任务 Then 使用首档排序值', () => {
    const plan = computeReorderPlan([], 't1', 0, new Map())
    expect(plan.movedSortOrder).toBe(RENUMBER_SPACING)
    expect(plan.rewritten).toEqual([])
  })

  test('Given 头插到首位 When 计算方案 Then 取首元素减步长，不重编号', () => {
    const ids = ['t1', 't2']
    const plan = computeReorderPlan(ids, 't9', 0, orders([1, 2]))
    expect(plan.movedSortOrder).toBe(RENUMBER_SPACING - RENUMBER_SPACING)
    expect(plan.rewritten).toEqual([])
  })

  test('Given 尾插到末位 When 计算方案 Then 取末元素加步长，不重编号', () => {
    const ids = ['t1', 't2']
    const plan = computeReorderPlan(ids, 't9', 2, orders([1, 2]))
    expect(plan.movedSortOrder).toBe(2 * RENUMBER_SPACING + RENUMBER_SPACING)
    expect(plan.rewritten).toEqual([])
  })

  test('Given 插入到相邻两任务之间 When 计算方案 Then 取两者中点，一次只写一行', () => {
    const ids = ['t1', 't2']
    const map = orders([1, 2])
    const plan = computeReorderPlan(ids, 't9', 1, map)
    expect(plan.movedSortOrder).toBe((RENUMBER_SPACING + 2 * RENUMBER_SPACING) / 2)
    expect(plan.rewritten).toEqual([])
  })

  test('Given 相邻间隙小于精度阈值 When 插入中间 Then 触发整列等距重编号', () => {
    // 构造间隙 1e-4 < MIN_SORT_GAP(1e-3)
    const ids = ['t1', 't2']
    const map = new Map<string, number>([['t1', 10], ['t2', 10.0001]])
    const plan = computeReorderPlan(ids, 't9', 1, map)
    expect(plan.rewritten.length).toBe(2)
    expect(plan.movedSortOrder).toBe(2 * RENUMBER_SPACING)
    // 重编号后仍保持原相对顺序：t1 在前、t2 在后
    const rewritten = plan.rewritten.find((item) => item.taskId === 't1')
    expect(rewritten?.sortOrder).toBe(RENUMBER_SPACING)
  })

  test('Given 目标索引越界 When 计算方案 Then 收敛到列尾（尾插语义）', () => {
    const ids = ['t1']
    const plan = computeReorderPlan(ids, 't9', 99, orders([1]))
    expect(plan.movedSortOrder).toBe(RENUMBER_SPACING + RENUMBER_SPACING)
    expect(plan.rewritten).toEqual([])
  })

  test('Given 间隙大于阈值但很小 When 插入中间 Then 仍走中点法不重编号', () => {
    // 注：浮点下无法构造"恰好等于阈值"的间隙（10+1e-3 回减 10 会略小于 1e-3），
    // 用 0.01（>> MIN_SORT_GAP 但远小于一个档位）验证小间隙正常取中点
    const map = new Map<string, number>([['t1', 10], ['t2', 10.01]])
    const plan = computeReorderPlan(['t1', 't2'], 't9', 1, map)
    expect(plan.rewritten).toEqual([])
    expect(plan.movedSortOrder).toBeCloseTo(10.005)
  })
})
