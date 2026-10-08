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
	revision: number | string
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
				<DialogContent className="flex max-h-[calc(100dvh-4rem)] w-[calc(100vw-2rem)] max-w-lg min-w-0 flex-col overflow-hidden [overflow-wrap:anywhere]">
					<DialogHeader className="shrink-0 pr-8">
						<DialogTitle>{preview?.ownerPlanning ? '确认一次Owner模型规划' : '确认开始非代码任务'}</DialogTitle>
					</DialogHeader>
					{preview && (
						<>
						<div className="min-h-0 min-w-0 space-y-3 overflow-y-auto text-sm" data-testid="controlled-task-preview-body">
							<p className="font-medium">{preview.title}</p>
							<p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-muted-foreground">
								{preview.description || '未另填说明，请确认目标已足够明确。'}
							</p>
							<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
								{preview.ownerPlanning && <><dt>Owner职责</dt><dd>{preview.ownerPlanning.ownerName}（配置版本 {preview.ownerPlanning.bindingRevision}）</dd></>}
								<dt>{preview.ownerPlanning ? '实际执行载体' : '员工'}</dt>
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
                            {preview.ownerPlanning && <section className="space-y-2 rounded bg-primary/5 p-3 text-xs" aria-label="Owner冻结发送范围">
                                <p>用途仅为规划提案或必要澄清，不完成目标业务任务，不自动派工。目标版本 {preview.ownerPlanning.context.goal.goal.goalVersion} / 目标修订 {preview.ownerPlanning.goalRevision} / 计划修订 {preview.ownerPlanning.planRevision}。</p>
                                <p>最多一次HTTP请求，输出上限4096 token。无工具、MCP、Skills、历史、记忆、自动标题、压缩、重试或自动续跑。safe本身不是沙箱；本次限制来自专用规划出口。</p>
                                <p className="break-all">协议 {preview.ownerPlanning.protocolVersion}；资料指纹 {preview.ownerPlanning.contextFingerprint}；指令指纹 {preview.ownerPlanning.promptHash}。</p>
                                <details><summary className="cursor-pointer">查看完整冻结发送资料和固定指令</summary><p className="mt-2 whitespace-pre-wrap break-words">{preview.ownerPlanning.systemPrompt}</p><pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-all">{preview.ownerPlanning.userPrompt}</pre></details>
                            </section>}
							<p className="rounded bg-amber-500/10 p-3 text-xs">
								{preview.ownerPlanning ? '开始后会调用真实模型并可能收费。当前没有金额硬封顶保证，费用未知时不会当作零元；中止不证明远端已停止或费用已结算，失联不自动补发。保存目标、准备规划、确认提案都不是本次费用许可；本按钮仅确认当前被冻结的一次规划请求。' : '开始后会调用真实模型，可能产生费用，沿用应用预算控制但不承诺绝对费用上限。只确认此次任务的模型执行，不授予外发、发布、付款等额外权限；工具操作仍受Runtime审批，完成后待人工验收。'}
							</p>
						</div>
						<div className="shrink-0 space-y-3" data-testid="controlled-task-preview-actions">
							<label className="flex items-start gap-2 text-sm">
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
							<div className="flex flex-wrap justify-end gap-2 bg-background">
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
					</>
					) }
				</DialogContent>
			</Dialog>
		</div>
	)
}
