import type * as React from 'react'
import { useAtomValue } from 'jotai'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { proactiveRunsAtom, proactiveLoadingAtom } from '@/atoms/proactive-data'
import { sortProactiveRuns, visibleProactiveRuns } from '@/lib/proactive-view'
import { ProactiveRunCard } from '../ProactiveRunCard'

export function RunsTab({
	onRefresh,
	runningOnly = false,
}: {
	onRefresh: () => Promise<void>
	runningOnly?: boolean
}): React.ReactElement {
	const allRuns = useAtomValue(proactiveRunsAtom)
	const loading = useAtomValue(proactiveLoadingAtom)
	const runs = visibleProactiveRuns(sortProactiveRuns(allRuns)).filter(
		(run) =>
			!runningOnly || run.status === 'running' || run.status === 'queued',
	)
	return (
		<div className="p-4 space-y-3 max-w-4xl mx-auto">
			<div className="flex justify-between items-center">
				<h2 className="text-sm font-medium">
					{runningOnly ? '正在执行的主动任务' : '运行记录'} · {runs.length}
				</h2>
				<Button
					size="sm"
					variant="outline"
					disabled={loading}
					onClick={() => void onRefresh()}
				>
					<RefreshCw className="size-4 mr-1" />
					刷新
				</Button>
			</div>
			{runs.length === 0 && (
				<p className="py-12 text-center text-sm text-muted-foreground">
					{runningOnly
						? '当前没有正在执行的主动任务。已启用的任务会在到期或收到事件后运行。'
						: '暂无运行记录。请在定时任务中创建并试跑。'}
				</p>
			)}
			{runs.map((run) => (
				<ProactiveRunCard key={run.id} run={run} onRefresh={onRefresh} />
			))}
		</div>
	)
}
