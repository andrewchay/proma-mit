import type { ProactiveExecutionTarget } from '@gravitas/shared'

/** 只接收必要元数据，不读取密钥；创建与执行使用同一校验规则。 */
export interface ProactiveTargetFacts {
	getChannel(
		id: string,
	):
		| {
				enabled: boolean
				defaultModel?: string
				models: Array<{ id: string; enabled: boolean }>
		  }
		| undefined
	getSession(
		id: string,
	):
		| { workspaceId?: string; channelId?: string; agentRuntime?: string }
		| undefined
	getWorkspace(id: string): { rootPath?: string } | undefined
	isDirectory(path: string): boolean
}

export function validateProactiveTarget<T extends ProactiveExecutionTarget>(
	target: T,
	facts: ProactiveTargetFacts,
): T & { modelId: string; workspaceId: string } {
	if (target.runtime !== 'proma' && target.runtime !== 'ai-sdk')
		throw new Error(
			'当前主动任务仅支持 Gravitas / AI SDK Runtime；Pi / Claude 尚未完成无人值守验收',
		)
	if (
		target.permissionMode &&
		target.permissionMode !== 'safe' &&
		target.permissionMode !== 'plan'
	)
		throw new Error('主动任务只允许安全或计划权限')
	if (!target.prompt?.trim()) throw new Error('请填写任务内容')
	const channel = facts.getChannel(target.channelId)
	if (!channel?.enabled)
		throw new Error('渠道不存在或已停用，请编辑任务选择已启用渠道')
	const modelId = (target.modelId ?? channel.defaultModel)?.trim()
	if (
		!modelId ||
		!channel.models.some((model) => model.id === modelId && model.enabled)
	)
		throw new Error('模型缺失或未启用，请编辑任务明确选择该渠道的模型')
	const session =
		!target.newSession && target.sessionId
			? facts.getSession(target.sessionId)
			: undefined
	if (!target.newSession && !session)
		throw new Error('目标会话不存在，请编辑任务重新选择会话')
	if (
		session &&
		(session.channelId !== target.channelId ||
			session.agentRuntime !== target.runtime)
	)
		throw new Error('会话渠道或 Runtime 已变更，请编辑任务重新确认执行目标')
	if (
		session &&
		target.workspaceId &&
		target.workspaceId !== session.workspaceId
	)
		throw new Error('任务与目标会话工作区不一致，请重新选择执行目标')
	const workspaceId = target.workspaceId ?? session?.workspaceId
	const workspace = workspaceId ? facts.getWorkspace(workspaceId) : undefined
	if (!workspaceId || !workspace)
		throw new Error('请为任务选择有效工作区，避免在不明确的项目中执行')
	if (workspace.rootPath && !facts.isDirectory(workspace.rootPath))
		throw new Error('工作区目录不可用，请恢复目录或编辑任务选择其他工作区')
	return { ...target, modelId, workspaceId }
}

/** JSONL 兜底只允许本轮新增消息，不能把历史回答当成本次成果。 */
export function extractCurrentProactiveOutput(
	messages: Array<{ id: string; role: string; content: string }>,
	previousIds: ReadonlySet<string>,
): string | undefined {
	return [...messages]
		.reverse()
		.find(
			(message) =>
				!previousIds.has(message.id) &&
				message.role === 'assistant' &&
				message.content.trim(),
		)
		?.content.trim()
}

/** 失败仍保留新建会话的定位信息，便于用户修复。 */
export class ProactiveExecutionError extends Error {
	constructor(
		message: string,
		readonly sessionId: string,
	) {
		super(message)
		this.name = 'ProactiveExecutionError'
	}
}
