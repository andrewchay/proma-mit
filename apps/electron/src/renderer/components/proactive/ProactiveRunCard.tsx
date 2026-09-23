import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { useOpenSession } from '@/hooks/useOpenSession'
import {
	proactiveSchedulesAtom,
	proactiveRunsAtom,
} from '@/atoms/proactive-data'
import {
	proactiveCenterTabAtom,
	proactiveEditScheduleIdAtom,
} from '@/atoms/proactive-center'
import {
	RUN_STATUS_LABELS,
	assertProactiveRunSucceeded,
} from '@/lib/proactive-view'
import type { ProactiveTaskRun } from '@gravitas/shared'

/** 首页与运行记录共用：显示同一次运行快照，而不是最新会话回答。 */

/** 记忆 Routine 成果阶段标签：区分「真实无新记忆」与「无输入/输出不合契约」。 */
const MEMORY_STAGE_LABELS: Record<string, string> = {
	no_input: '无输入资料',
	invalid_output: '输出不合契约',
	no_new: '无新记忆',
	pending_approval: '记忆候选待审批',
	committed: '已写入记忆',
	no_output: '无输出',
}

export function ProactiveRunCard({
	run,
	onRefresh,
}: {
	run: ProactiveTaskRun
	onRefresh: () => Promise<void>
}): React.ReactElement {
	const [detailsOpen, setDetailsOpen] = React.useState(false)
	const [retrying, setRetrying] = React.useState(false)
	const schedules = useAtomValue(proactiveSchedulesAtom)
	const runs = useAtomValue(proactiveRunsAtom)
	const setTab = useSetAtom(proactiveCenterTabAtom)
	const setEditing = useSetAtom(proactiveEditScheduleIdAtom)
	const { openSession } = useOpenSession()
	const schedule =
		run.sourceType === 'schedule' || run.sourceType === 'manual'
			? schedules.find((item) => item.id === run.sourceId)
			: undefined
	const busy =
		retrying ||
		runs.some(
			(item) => item.sourceId === run.sourceId && item.status === 'running',
		)
	const retry = async (): Promise<void> => {
		if (!schedule || busy) return
		setRetrying(true)
		try {
			const result = await window.electronAPI.runProactiveSchedule(schedule.id)
			assertProactiveRunSucceeded(result)
			toast.success('本次重试已完成，可查看新运行记录')
		} catch (error) {
			toast.error(error instanceof Error ? error.message : '重试失败')
		} finally {
			setRetrying(false)
			await onRefresh()
		}
	}
	return (
		<article className="rounded-xl bg-foreground/[0.025] p-3 space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				<span
					className={
						run.status === 'failed'
							? 'text-xs font-medium text-destructive'
							: run.status === 'running'
								? 'text-xs font-medium text-primary'
								: 'text-xs font-medium text-muted-foreground'
					}
				>
					{RUN_STATUS_LABELS[run.status]}
					{run.memoryStage && MEMORY_STAGE_LABELS[run.memoryStage] && (
						<span className="ml-2 rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-foreground/60">
							{MEMORY_STAGE_LABELS[run.memoryStage]}
						</span>
					)}
				</span>
				<h3 className="flex-1 min-w-32 text-sm font-medium">
					{run.sourceTitle ?? '主动任务'}
				</h3>
				<span className="text-xs text-muted-foreground">
					{run.startedAt
						? new Date(run.startedAt).toLocaleString()
						: '等待执行'}
				</span>
			</div>
			<p className="text-xs text-muted-foreground line-clamp-2 break-words">
				{run.error ??
					run.outputSummary ??
					(run.status === 'running'
						? '正在执行，结果将在完成后显示'
						: '此记录没有结果摘要')}
			</p>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="outline"
					onClick={() => setDetailsOpen(true)}
				>
					查看详情
				</Button>
				{run.sessionId && (
					<Button
						size="sm"
						variant="ghost"
						onClick={() =>
							openSession(
								'agent',
								run.sessionId!,
								run.sourceTitle ?? '主动任务',
							)
						}
					>
						打开会话
					</Button>
				)}
				{run.status === 'failed' && schedule && (
					<>
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => void retry()}
						>
							{retrying ? '重试中…' : '重试一次'}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => {
								setEditing(schedule.id)
								setTab('schedules')
							}}
						>
							修复配置
						</Button>
					</>
				)}
			</div>
			<Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
				<DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{run.sourceTitle ?? '运行详情'}</DialogTitle>
						<DialogDescription>
							{RUN_STATUS_LABELS[run.status]} · {run.trigger} · {run.id}
						</DialogDescription>
					</DialogHeader>
					{run.error && (
						<div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive whitespace-pre-wrap break-words">
							{run.error}
						</div>
					)}
					<p className="text-xs text-muted-foreground">
						{run.endedAt
							? `结束于 ${new Date(run.endedAt).toLocaleString()}`
							: '尚无结束时间'}
						。完成状态仅表示执行结束，不代表业务验收通过。
					</p>
					<pre className="whitespace-pre-wrap break-words rounded-lg bg-foreground/[0.025] p-4 text-sm font-sans">
						{run.output ??
							run.outputSummary ??
							'没有本次输出。可打开对应会话排查。'}
					</pre>
					{!run.output && run.outputSummary && (
						<p className="text-xs text-muted-foreground">
							旧记录仅保留摘要；完整历史请打开会话。新运行将保存独立结果快照。
						</p>
					)}
				</DialogContent>
			</Dialog>
		</article>
	)
}
