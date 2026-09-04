/**
 * Proactive Center Tab 状态
 */

import { atom } from 'jotai'
import type { ProactiveRecommendation } from '@gravitas/shared'

export type ProactiveTab = 'today' | 'schedules' | 'monitors' | 'approvals' | 'running' | 'runs' | 'memory' | 'routines' | 'cost-audit' | 'credential-health'

/** Proactive Center 当前活跃 Tab */
export const proactiveCenterTabAtom = atom<ProactiveTab>('today')

/** 等待用户补齐执行目标的推荐；创建成功后才将 Recommendation 标记为 accepted。 */
export const proactiveConfigurationRecommendationAtom = atom<ProactiveRecommendation | null>(null)
