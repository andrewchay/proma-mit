import * as React from 'react'
import type { ControlledTaskStartPreview } from '@gravitas/shared'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'

/** 创建任务不等于启动；确认前展示主进程回读的真实范围和费用提醒。 */
export function ControlledTaskStartButton({
	taskId,
	revision,
	onChanged,
}: {
	taskId: string
	revision: number
	onChanged: () => void | Promise<void>
}): React.ReactElement {
	const [preview, setPreview] =
		React.useState<ControlledTaskStartPreview | null>(null)
	const [acknowledged, setAcknowledged] = React.useState(false)
	const [busy, setBusy] = React.useState(false)
	const [error, setError] = React.useState<string | null>(null)
	const [result, setResult] = React.useState<string | null>(null)
	const generation = React.useRef(0)
	const inFlight = React.useRef(false)
	// biome-ignore lint/correctness/useExhaustiveDependencies: 任务或权威版本切换必须清除旧预检与晚到响应。
	React.useEffect(() => {
		generation.current++
		inFlight.current = false
		setBusy(false)
		setPreview(null)
		setAcknowledged(false)
		setError(null)
		setResult(null)
		return () => {
			generation.current++
		}
	}, [taskId, revision])
	const preflight = async (): Promise<void> => {
		if (inFlight.current) return
		inFlight.current = true
		setBusy(true)
		setError(null)
		setAcknowledged(false)
		const current = generation.current
		try {
			const next =
				await window.electronAPI.paa.agentEmployees.getControlledTaskStartPreview(
					taskId,
				)
			if (current === generation.current) setPreview(next)
		} catch (reason) {
			if (current === generation.current)
				setError(reason instanceof Error ? reason.message : String(reason))
		} finally {
			if (current === generation.current) {
				inFlight.current = false
				setBusy(false)
			}
		}
	}
	const start = async (): Promise<void> => {
		if (!preview || !acknowledged || inFlight.current) return
		inFlight.current = true
		setBusy(true)
		setError(null)
		const current = generation.current
		try {
			const next =
				await window.electronAPI.paa.agentEmployees.startControlledTask({
					taskId,
					previewHash: preview.previewHash,
					acknowledgeModelCosts: true,
				})
			if (current !== generation.current) return
			setPreview(null)
			setAcknowledged(false)
			setResult(
				next.status === 'running'
					? '已认领执行，请查看执行会话；成果仍须人工验收。'
					: next.status === 'queued'
						? '已入队，等待调度；未证明模型已开始。'
						: `执行状态：${next.status}，请查看执行记录。`,
			)
			await onChanged()
		} catch (reason) {
			if (current === generation.current) {
				setError(reason instanceof Error ? reason.message : String(reason))
				setAcknowledged(false)
			}
		} finally {
			if (current === generation.current) {
				inFlight.current = false
				setBusy(false)
			}
		}
	}
	return (
		<div className="text-xs" data-testid="controlled-task-start">
			<button
				type="button"
				className="rounded bg-primary/10 px-2 py-1 text-primary disabled:opacity-50"
				disabled={busy}
				onClick={() => void preflight()}
			>
				预检并开始
			</button>
			{error && (
				<p role="alert" className="mt-1 text-destructive">
					{error}
				</p>
			)}
			{result && <p className="mt-1 text-muted-foreground">{result}</p>}
			<Dialog
				open={Boolean(preview)}
				onOpenChange={(open) => {
					if (!open && !busy) {
						setPreview(null)
						setAcknowledged(false)
					}
				}}
			>
				<DialogContent className="max-h-[85vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>确认开始非代码任务</DialogTitle>
					</DialogHeader>
					{preview && (
						<div className="space-y-3 text-sm">
							<p className="font-medium">{preview.title}</p>
							<p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
								{preview.description || '未另填说明，请确认目标已足够明确。'}
							</p>
							<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
								<dt>员工</dt>
								<dd>{preview.employeeName}</dd>
								<dt>工作区</dt>
								<dd>{preview.workspaceName}</dd>
								<dt>渠道 / 模型</dt>
								<dd className="break-all">
									{preview.channelName} / {preview.modelId}
								</dd>
								<dt>Runtime / 权限</dt>
								<dd>
									{preview.runtime} / {preview.permissionMode}
									（无worktree写豁免）
								</dd>
							</dl>
							<p className="text-xs text-muted-foreground">
								预检截至 {new Date(preview.expiresAt).toLocaleTimeString()}
								。配置或目标变化须重新预检。权限申请：
								{preview.requestedPermissions.join('、') || '无'}
								；申请不等于批准。
							</p>
							<p className="rounded bg-amber-500/10 p-3 text-xs">
								开始后会调用真实模型，可能产生费用，沿用应用预算控制但不承诺绝对费用上限。只确认此次任务的模型执行，不授予外发、发布、付款等额外权限；工具操作仍受Runtime审批，完成后待人工验收。
							</p>
							<label className="flex items-start gap-2">
								<input
									aria-label="确认本次模型执行及费用"
									type="checkbox"
									checked={acknowledged}
									onChange={(event) => setAcknowledged(event.target.checked)}
								/>
								<span>我已核对以上范围，确认本次模型执行及费用。</span>
							</label>
							{error && (
								<p role="alert" className="text-xs text-destructive">
									{error}
								</p>
							)}
							<div className="flex justify-end gap-2">
								<button
									type="button"
									disabled={busy}
									onClick={() => void preflight()}
									className="rounded border px-3 py-1.5 text-xs"
								>
									刷新预检
								</button>
								<button
									type="button"
									disabled={busy || !acknowledged}
									onClick={() => void start()}
									className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
								>
									{busy ? '处理中…' : '确认开始（可能收费）'}
								</button>
							</div>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	)
}
