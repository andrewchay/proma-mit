/**
 * Sidebar Atoms — 侧边栏 UI 状态
 */

import { atomWithStorage } from 'jotai/utils'

/** 侧边栏是否收起（持久化） */
export const sidebarCollapsedAtom = atomWithStorage<boolean>(
  'proma-sidebar-collapsed',
  false,
)
