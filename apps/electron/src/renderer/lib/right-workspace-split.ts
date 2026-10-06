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
 * 激活文件预览时更新右侧工作台布局。
 *
 * 用户反馈：未分屏时强行创建「目录 + 预览」分屏会让文档展示区过小，
 * 每次预览都要手动关掉目录页。因此新策略是：
 * - 未分屏：不创建分屏，预览独占整个右侧面板；
 * - 已分屏：保留用户已有的左侧目录上下文，仅把右侧 Pane 切到预览。
 * 需要目录 + 预览同框时，可通过面板 Tab 栏的手动分屏按钮开启。
 */
export function openRightWorkspacePreview(
  split: RightWorkspaceSplitState | null,
): RightWorkspaceSplitState | null {
  if (!split) return null

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
