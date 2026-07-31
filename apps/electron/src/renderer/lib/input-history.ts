/** 对话输入历史的纯状态机，供 Chat 与 Agent 共用。 */

export interface InputHistoryState {
  /** -1 代表当前草稿；0 代表最新一条历史。 */
  index: number
  draft: string
}

export type InputHistoryDirection = 'previous' | 'next'

export interface InputHistoryNavigationResult extends InputHistoryState {
  value: string
}

/** 保留输入顺序，仅过滤空白项与连续重复项。 */
export function normalizeInputHistory(entries: readonly string[]): string[] {
  const history: string[] = []
  for (const entry of entries) {
    const value = entry.trim()
    if (value && history.at(-1) !== value) history.push(value)
  }
  return history
}

/** 在历史记录与当前未发送草稿之间移动。 */
export function navigateInputHistory(
  entries: readonly string[],
  state: InputHistoryState,
  currentValue: string,
  direction: InputHistoryDirection,
): InputHistoryNavigationResult | undefined {
  const history = normalizeInputHistory(entries)
  if (history.length === 0) return undefined

  if (direction === 'previous') {
    const index = Math.min(state.index + 1, history.length - 1)
    return {
      index,
      draft: state.index === -1 ? currentValue : state.draft,
      value: history[history.length - 1 - index]!,
    }
  }

  if (state.index === -1) return undefined
  if (state.index === 0) return { index: -1, draft: state.draft, value: state.draft }
  const index = state.index - 1
  return { index, draft: state.draft, value: history[history.length - 1 - index]! }
}
