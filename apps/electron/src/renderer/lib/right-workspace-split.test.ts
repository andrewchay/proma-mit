import { describe, expect, test } from 'bun:test'
import {
  clampRightWorkspaceSplitRatio,
  createRightWorkspaceSplit,
  focusedRightWorkspaceTab,
  openRightWorkspacePreview,
  replaceRightWorkspacePane,
  selectRightWorkspaceTab,
} from './right-workspace-split'

describe('右侧工作台双 Pane', () => {
  test('不允许把同一个 Tab 同时放入两侧', () => {
    expect(createRightWorkspaceSplit('files', 'files', 'right')).toBeNull()
  })

  test('创建分屏时固定顺序、焦点和安全比例', () => {
    expect(createRightWorkspaceSplit('files', 'preview', 'right', 0.9)).toEqual({
      leftTab: 'files',
      rightTab: 'preview',
      focusedPane: 'right',
      ratio: 0.7,
    })
    expect(clampRightWorkspaceSplitRatio(0.1)).toBe(0.3)
  })

  test('点击文件会保留目录上下文，并在右侧展开预览', () => {
    expect(openRightWorkspacePreview(null, 'files')).toEqual({
      leftTab: 'files',
      rightTab: 'preview',
      focusedPane: 'right',
      ratio: 0.5,
    })

    const existing = createRightWorkspaceSplit('changes', 'terminal', 'right', 0.6)!
    expect(openRightWorkspacePreview(existing, 'changes')).toEqual({
      leftTab: 'changes',
      rightTab: 'preview',
      focusedPane: 'right',
      ratio: 0.6,
    })
  })

  test('选择已有 Tab 只移动焦点，选择新 Tab 替换当前 Pane', () => {
    const split = createRightWorkspaceSplit('files', 'preview', 'right')!
    expect(selectRightWorkspaceTab(split, 'files').focusedPane).toBe('left')
    const changed = selectRightWorkspaceTab(split, 'terminal')
    expect(changed.rightTab).toBe('terminal')
    expect(focusedRightWorkspaceTab(changed)).toBe('terminal')
  })

  test('替换为另一侧已有 Tab 时收起分屏', () => {
    const split = createRightWorkspaceSplit('files', 'preview', 'right')!
    expect(replaceRightWorkspacePane(split, 'left', 'preview')).toBeNull()
  })
})
