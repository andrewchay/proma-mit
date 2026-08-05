/** Proactive Scheduler 设置页状态。 */

import { atom } from 'jotai'
import type { AgentSessionMeta, ProactiveSchedule, ProactiveTaskRun } from '@gravitas/shared'

export const proactiveSchedulesAtom = atom<ProactiveSchedule[]>([])
export const proactiveRunsAtom = atom<ProactiveTaskRun[]>([])
export const proactiveSessionsAtom = atom<AgentSessionMeta[]>([])
export const proactiveLoadingAtom = atom(false)
export const proactiveSelectedSessionIdAtom = atom('')
export const proactiveNewSessionAtom = atom(false)
export const proactiveSelectedChannelIdAtom = atom('')
export const proactivePromptAtom = atom('')
export const proactiveScheduleKindAtom = atom<'at' | 'interval' | 'cron'>('at')
export const proactiveRunAtAtom = atom('')
export const proactiveIntervalMinutesAtom = atom('60')
export const proactiveCronExpressionAtom = atom('0 9 * * 1-5')
export const proactiveCronTimezoneAtom = atom(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
