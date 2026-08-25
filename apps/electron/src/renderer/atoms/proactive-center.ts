/**
 * Proactive Center Tab 状态
 */

import { atom } from 'jotai'

export type ProactiveTab = 'today' | 'schedules' | 'monitors' | 'approvals' | 'runs' | 'memory'

/** Proactive Center 当前活跃 Tab */
export const proactiveCenterTabAtom = atom<ProactiveTab>('today')
