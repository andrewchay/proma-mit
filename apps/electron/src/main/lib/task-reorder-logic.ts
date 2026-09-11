/**
 * 任务排序纯逻辑 — Task Reorder Logic
 *
 * 中点法（借鉴 Plane）：拖拽落点取相邻两条 sort_order 的中点，一次只写一行；
 * 相邻间隙不足（浮点精度耗尽）时对整列做等距重编号兜底（借鉴 Taiga 的区间重排）。
 * sort_order 为 REAL，列内升序即展示顺序。
 */

/** 重编号时的等距间隔（同时用于头插/尾插步长） */
export const RENUMBER_SPACING = 65536

/** 相邻间隙小于该值时触发整列重编号（epoch 量级数值下双精度安全余量） */
export const MIN_SORT_GAP = 1e-3

export interface ReorderPlan {
  /** 被移动任务的新 sort_order */
  movedSortOrder: number
  /** 需要一并改写的其他任务排序（仅触发重编号时非空） */
  rewritten: Array<{ taskId: string; sortOrder: number }>
}

/**
 * 计算把 movedTaskId 插入目标列第 targetIndex 位（0 起）后的排序方案。
 *
 * @param columnTaskIds 目标列现有任务 id，按 sort_order 升序，不含被移动任务
 * @param currentOrders 列内各任务当前 sort_order
 */
export function computeReorderPlan(
  columnTaskIds: string[],
  movedTaskId: string,
  targetIndex: number,
  currentOrders: ReadonlyMap<string, number>,
): ReorderPlan {
  const index = Math.max(0, Math.min(targetIndex, columnTaskIds.length))
  const prevId = index > 0 ? columnTaskIds[index - 1]! : null
  const nextId = index < columnTaskIds.length ? columnTaskIds[index]! : null
  const prevOrder = prevId !== null ? currentOrders.get(prevId) ?? 0 : null
  const nextOrder = nextId !== null ? currentOrders.get(nextId) ?? 0 : null

  if (prevOrder !== null && nextOrder !== null && nextOrder - prevOrder >= MIN_SORT_GAP) {
    // 中点法：一次只写被移动任务这一行
    return { movedSortOrder: (prevOrder + nextOrder) / 2, rewritten: [] }
  }
  if (prevOrder === null && nextOrder !== null) {
    // 头插
    return { movedSortOrder: nextOrder - RENUMBER_SPACING, rewritten: [] }
  }
  if (prevOrder !== null && nextOrder === null) {
    // 尾插
    return { movedSortOrder: prevOrder + RENUMBER_SPACING, rewritten: [] }
  }

  // 间隙不足（或空列）：整列等距重编号
  const orderedIds = [...columnTaskIds.slice(0, index), movedTaskId, ...columnTaskIds.slice(index)]
  return {
    movedSortOrder: (index + 1) * RENUMBER_SPACING,
    rewritten: orderedIds
      .filter((id) => id !== movedTaskId)
      .map((taskId, position) => ({ taskId, sortOrder: (position + 1) * RENUMBER_SPACING })),
  }
}
