export type RightWorkspaceTab = 'files' | 'changes' | 'preview' | 'terminal' | 'browser' | 'skills' | 'mcp'
export type RightWorkspacePane = 'left' | 'right'

export interface RightWorkspaceSplitState {
  leftTab: RightWorkspaceTab
  rightTab: RightWorkspaceTab
  focusedPane: RightWorkspacePane
  ratio: number
}

export function clampRightWorkspaceSplitRatio(ratio: number): number {
  return Math.max(0.3, Math.min(0.7, ratio))
}

export function createRightWorkspaceSplit(
  activeTab: RightWorkspaceTab,
  nextTab: RightWorkspaceTab,
  placement: RightWorkspacePane,
  ratio = 0.5,
): RightWorkspaceSplitState | null {
  if (activeTab === nextTab) return null
  return {
    leftTab: placement === 'left' ? nextTab : activeTab,
    rightTab: placement === 'right' ? nextTab : activeTab,
    focusedPane: placement,
    ratio: clampRightWorkspaceSplitRatio(ratio),
  }
}

/**
 * 将文件预览固定展示在右侧 Pane。
 *
 * 文件树中的点击不应只是切换 Tab，否则用户会失去原来的目录上下文。
 * 未分屏时以当前主视图创建「主视图 + 预览」；已有分屏时保留左侧内容。
 */
export function openRightWorkspacePreview(
  split: RightWorkspaceSplitState | null,
  primaryTab: Extract<RightWorkspaceTab, 'files' | 'changes'>,
): RightWorkspaceSplitState {
  if (!split) {
    return createRightWorkspaceSplit(primaryTab, 'preview', 'right')!
  }

  return {
    ...split,
    rightTab: 'preview',
    focusedPane: 'right',
  }
}

export function selectRightWorkspaceTab(
  split: RightWorkspaceSplitState,
  tab: RightWorkspaceTab,
): RightWorkspaceSplitState {
  if (split.leftTab === tab) return { ...split, focusedPane: 'left' }
  if (split.rightTab === tab) return { ...split, focusedPane: 'right' }
  return split.focusedPane === 'left' ? { ...split, leftTab: tab } : { ...split, rightTab: tab }
}

export function replaceRightWorkspacePane(
  split: RightWorkspaceSplitState,
  pane: RightWorkspacePane,
  tab: RightWorkspaceTab,
): RightWorkspaceSplitState | null {
  const otherTab = pane === 'left' ? split.rightTab : split.leftTab
  if (tab === otherTab) return null
  return pane === 'left'
    ? { ...split, leftTab: tab, focusedPane: pane }
    : { ...split, rightTab: tab, focusedPane: pane }
}

export function focusedRightWorkspaceTab(split: RightWorkspaceSplitState): RightWorkspaceTab {
  return split.focusedPane === 'left' ? split.leftTab : split.rightTab
}
