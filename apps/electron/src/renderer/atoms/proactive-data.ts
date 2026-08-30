/**
 * Proactive Center 数据状态
 *
 * 供 Today Tab 等组件消费
 */

import { atom } from 'jotai'
import type { ProactiveSchedule, ProactiveTaskRun, ProactiveRecommendation, ProactiveApproval, ProactiveMonitor } from '@gravitas/shared'

/** 定时任务列表 */
export const proactiveSchedulesAtom = atom<ProactiveSchedule[]>([])

/** 运行记录列表 */
export const proactiveRunsAtom = atom<ProactiveTaskRun[]>([])

/** 推荐列表 */
export const proactiveRecommendationsAtom = atom<ProactiveRecommendation[]>([])

/** 审批列表 */
export const proactiveApprovalsAtom = atom<ProactiveApproval[]>([])

/** 监听任务列表 */
export const proactiveMonitorsAtom = atom<ProactiveMonitor[]>([])

/** 加载状态 */
export const proactiveLoadingAtom = atom<boolean>(false)

/** 记忆插件列表 */
export interface MemoryPlugin {
  id: string
  name: string
  description: string
  enabled: boolean
}
export const proactiveMemoryPluginsAtom = atom<MemoryPlugin[]>([])
