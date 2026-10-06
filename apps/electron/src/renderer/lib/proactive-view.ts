import type { ProactiveSchedule, ProactiveTaskRun } from '@gravitas/shared'

export const PROJECT_CHECK_PROMPT =
	'只读检查当前工作区项目的 Git 未提交变更：确认项目路径，列出已暂存、未暂存和未跟踪文件，概述影响与需要人工确认的风险。不要修改文件、暂存、提交或访问其他项目。输出检查时间、项目路径、变化列表、风险和建议；没有变化时明确写明无未提交变更；工具或权限不足时明确说明检查未完成，禁止臆测。'
export const RUN_STATUS_LABELS: Record<ProactiveTaskRun['status'], string> = {
	queued: '等待执行',
	running: '执行中',
	success: '已完成',
	failed: '失败',
	cancelled: '已取消',
}
export function sortProactiveRuns(
	runs: ProactiveTaskRun[],
): ProactiveTaskRun[] {
	return [...runs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}
export function visibleProactiveRuns(
	runs: ProactiveTaskRun[],
): ProactiveTaskRun[] {
	const runIds = new Set(runs.map((run) => run.id))
	// Schedule/Monitor 外层运行会生成一个 Routine 子运行；默认列表展示根运行，
	// 保留子运行数据用于审计和记忆阶段详情，避免用户看到两条一模一样的记录。
	return runs.filter((run) => !run.parentRunId || !runIds.has(run.parentRunId))
}
export function summarizeProactiveRuns(
	runs: ProactiveTaskRun[],
	now = new Date(),
): { running: number; today: number } {
	return {
		running: runs.filter((run) => run.status === 'running').length,
		today: runs.filter(
			(run) =>
				run.startedAt != null &&
				new Date(run.startedAt).toDateString() === now.toDateString(),
		).length,
	}
}
export function scheduleRunState(
	schedule: ProactiveSchedule,
	runs: ProactiveTaskRun[],
): string {
	if (
		runs.some((run) => run.sourceId === schedule.id && run.status === 'running')
	)
		return '执行中'
	if (!schedule.enabled)
		return schedule.consecutiveFailures >= 3
			? '连续失败，已自动暂停'
			: '已暂停 / 已结束'
	return schedule.consecutiveFailures > 0
		? '上次失败，等待下次触发'
		: '等待触发'
}
export function assertProactiveRunSucceeded(run: ProactiveTaskRun): void {
	if (run.status !== 'success')
		throw new Error(
			run.error ?? `任务${RUN_STATUS_LABELS[run.status]}，请查看运行详情`,
		)
}
