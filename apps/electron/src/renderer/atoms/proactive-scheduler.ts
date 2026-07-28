/** Proactive Scheduler 设置页状态。 */

import { atom } from 'jotai'
import type { AgentSessionMeta, ProactiveSchedule, ProactiveTaskRun } from '@proma/shared'

export const proactiveSchedulesAtom = atom<ProactiveSchedule[]>([])
export const proactiveRunsAtom = atom<ProactiveTaskRun[]>([])
export const proactiveSessionsAtom = atom<AgentSessionMeta[]>([])
export const proactiveLoadingAtom = atom(false)
export const proactiveSelectedSessionIdAtom = atom('')
export const proactivePromptAtom = atom('')
export const proactiveScheduleKindAtom = atom<'at' | 'interval'>('at')
export const proactiveRunAtAtom = atom('')
export const proactiveIntervalMinutesAtom = atom('60')
