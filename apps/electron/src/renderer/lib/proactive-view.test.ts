import { describe, test, expect } from 'bun:test'
import type { ProactiveTaskRun, ProactiveSchedule } from '@gravitas/shared'
import {
	summarizeProactiveRuns,
	sortProactiveRuns,
	assertProactiveRunSucceeded,
	scheduleRunState,
} from './proactive-view'
import { proactiveRunsAtom } from '../atoms/proactive-data'
import { proactiveRunsAtom as schedulerRunsAtom } from '../atoms/proactive-scheduler'

describe('主动中心状态', () => {
	const runs: ProactiveTaskRun[] = Array.from({ length: 9 }, (_, i) => ({
		id: String(i),
		sourceId: 's',
		sourceType: 'schedule',
		status: i === 0 ? 'running' : 'success',
		trigger: 'manual',
		startedAt: new Date(2026, 8, 15, 9, i).getTime(),
	}))
	test('今日统计不受最近五条截断影响', () => {
		expect(summarizeProactiveRuns(runs, new Date(2026, 8, 15))).toEqual({
			today: 9,
			running: 1,
		})
	})
	test('最新记录排首位而不改变原数组', () => {
		expect(sortProactiveRuns(runs)[0]?.id).toBe('8')
		expect(runs[0]?.id).toBe('0')
	})
	test('failed 不能提示执行成功', () => {
		expect(() =>
			assertProactiveRunSucceeded({
				...runs[0]!,
				status: 'failed',
				error: '缺少模型',
			}),
		).toThrow('缺少模型')
	})
	test('启用不等于运行中', () => {
		expect(
			scheduleRunState(
				{
					id: 'other',
					enabled: true,
					consecutiveFailures: 0,
				} as ProactiveSchedule,
				runs,
			),
		).toBe('等待触发')
	})
	test('定时任务与首页共享同一 atom', () => {
		expect(schedulerRunsAtom).toBe(proactiveRunsAtom)
	})
})
