/**
 * 任务列表与派生视图（甘特图 / 依赖 / 成果）的数据同步。
 *
 * 背景：项目详情里 tasks（列表用）和 dependencyTasks（甘特图等用，含子任务与草稿）
 * 是两份独立快照。任务编辑只更新 tasks 时，甘特图仍读旧快照，表现为
 * 「看板已有日期、甘特图还是空状态，退出重进才恢复」。
 *
 * 合并语义（重要）：
 * - 权威列表是**全集**：新增的任务要加进来，删除的任务要去掉；
 *   只做「按 id 覆盖」会漏掉增删，导致甘特图长期停留在旧集合。
 * - 但派生快照里可能有列表不包含的条目（草稿、子任务）。
 *   这些必须由调用方通过 `isDerivedOnly` 明确声明，否则会被当成「已删除」清掉。
 *   默认不保留——宁可多刷一次，也不要显示已经不存在的任务。
 */
export interface TaskLike {
  id: string
}

/**
 * @param derived 派生视图当前的快照
 * @param authoritative 任务列表返回的权威结果（全集）
 * @param isDerivedOnly 判断某条目是否「只属于派生视图、列表里本就不会出现」，
 *   例如草稿与子任务。未提供时视为不存在这类条目。
 */
export function mergeTaskSnapshot<T extends TaskLike>(
  derived: readonly T[],
  authoritative: readonly T[],
  isDerivedOnly?: (task: T) => boolean,
): T[] {
  // 派生快照为空说明还没加载过，直接用权威结果，避免先渲染成空。
  if (derived.length === 0) return [...authoritative]

  const authoritativeById = new Map(authoritative.map((task) => [task.id, task]))
  // 以权威结果为准重建：内容取最新、顺序取列表顺序，新增自动出现、删除自动消失。
  const merged = [...authoritative]
  // 再补回「只属于派生视图」的条目（草稿、子任务），它们不在列表里但必须保留。
  if (isDerivedOnly) {
    for (const task of derived) {
      if (!authoritativeById.has(task.id) && isDerivedOnly(task)) merged.push(task)
    }
  }
  return merged
}
