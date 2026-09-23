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

/**
 * 消息身份键：跨消息格式统一标识一条消息。
 * proma / ai-sdk runtime 持久化的是 SDK 格式（身份在 uuid），Claude 系为 AgentMessage（身份在 id）。
 */
export function getMessageIdentity(message: unknown): string {
	if (typeof message !== 'object' || message === null) return ''
	const record = message as Record<string, unknown>
	if (typeof record.uuid === 'string') return record.uuid
	if (typeof record.id === 'string') return record.id
	return ''
}

/** 从 content blocks 或字符串中提取纯文本（SDK block 数组 / AgentMessage 字符串都支持）。 */
function extractTextFromContent(content: unknown): string {
	if (typeof content === 'string') return content.trim()
	if (!Array.isArray(content)) return ''
	return content
		.map((block) => {
			if (typeof block !== 'object' || block === null) return ''
			const record = block as Record<string, unknown>
			return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
		})
		.filter(Boolean)
		.join('\n')
		.trim()
}

/**
 * JSONL 兜底只允许本轮新增消息，不能把历史回答当成本次成果。
 * 同时兼容两种持久化格式：
 * - SDK 消息：{ type: 'assistant', uuid, message: { content: [blocks] } }（proma / ai-sdk runtime）
 * - AgentMessage：{ id, role: 'assistant', content: string }
 */
export function extractCurrentProactiveOutput(
	messages: unknown[],
	previousIds: ReadonlySet<string>,
): string | undefined {
	for (const message of [...messages].reverse()) {
		if (typeof message !== 'object' || message === null) continue
		const record = message as Record<string, unknown>
		const isAssistant = record.role === 'assistant' || record.type === 'assistant'
		if (!isAssistant) continue
		const identity = getMessageIdentity(message)
		if (previousIds.has(identity)) continue
		const text = extractTextFromContent(record.content ?? (record.message as Record<string, unknown> | undefined)?.content)
		if (text) return text
	}
	return undefined
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
