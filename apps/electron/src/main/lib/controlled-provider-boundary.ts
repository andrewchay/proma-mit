import type { ToolContext } from './agent-runtime/types'
/** 非代码准备任务的模型出口。仅按权威execution识别，不接受客户端授权标志。 */
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { resolveAgentRuntimeBaseUrl } from '@gravitas/shared'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getConfigDir } from './config-paths'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getChannelById } from './channel-manager'
import * as store from './project-sqlite-store'
import {
	assertControlledPreparedExecution,
	requiresControlledStart,
} from './controlled-project-task-service'
import { resolvePiBaseUrl } from './adapters/pi-runtime-base-url'

export interface ControlledProviderContext {
	runtime: 'pi' | 'ai-sdk'
	cwd: string
	modelId: string
	permissionMode: string
}
export function isControlledProviderSession(sessionId: string): boolean {
	const execution = store.getAgentExecutionBySessionId(sessionId)
	if (!execution) return false
	// 旧队列或普通改派也不能凭缺少准备记录绕过最终发送与权限门禁。
	return (
		store.getAgentEmployee(execution.agentId)?.executionProfile === 'controlled' ||
		(execution.entityType === 'task' && requiresControlledStart(execution.entityId))
	)
}
/** 每次最终payload/HTTP发送前重读；异步初始化与既有payload钩子不能沿用旧确认。 */
export function assertControlledProviderBoundary(
	sessionId: string,
	actual: ControlledProviderContext,
	actualBaseUrl?: string,
): void {
	const execution = store.getAgentExecutionBySessionId(sessionId)
	if (
		!execution ||
		execution.status !== 'running' ||
		execution.sessionId !== sessionId ||
		execution.entityType !== 'task'
	)
		throw new Error('非代码模型出口没有当前运行执行')
	assertControlledPreparedExecution(execution.id, 'provider')
	const task = store.getTask(execution.entityId)!
	const employee = store.getAgentEmployee(execution.agentId)!
	const workspace = task.workspaceId
		? getAgentWorkspace(task.workspaceId)
		: undefined
	const channel = getChannelById(employee.channelId)
	if (
		!workspace ||
		!channel ||
		!existsSync(actual.cwd) ||
		!statSync(actual.cwd).isDirectory()
	)
		throw new Error('明确工作区不可用，禁止回退到主目录')
	const expectedCwd =
		workspace.rootPath ??
		join(getConfigDir(), 'agent-workspaces', workspace.slug, sessionId)
	const expectedBaseUrl =
		actual.runtime === 'pi'
			? resolvePiBaseUrl(channel.provider, channel.baseUrl)
			: resolveAgentRuntimeBaseUrl(channel.provider, 'ai-sdk', channel.baseUrl)
	if (
		actual.runtime !== (employee.runtime ?? 'ai-sdk') ||
		actual.modelId !== employee.modelId ||
		(actual.permissionMode !== (employee.permissionMode ?? 'safe') &&
			actual.permissionMode !== 'plan') ||
		resolve(actual.cwd) !== resolve(expectedCwd) ||
		(actualBaseUrl !== undefined &&
			actualBaseUrl.replace(/\/+$/, '') !== expectedBaseUrl.replace(/\/+$/, ''))
	) {
		throw new Error('模型实际参数与确认的员工、模型、权限或工作区不一致')
	}
	// 这是请求准入时间，不宣称Provider已启动、实际费用或终态。
	store
		.getProjectDb()
		.prepare(
			'UPDATE controlled_task_preparations SET provider_admitted_at = COALESCE(provider_admitted_at, ?) WHERE execution_id = ?',
		)
		.run(Date.now(), execution.id)
}

/** Plan可收紧权限，但不能借退出Plan把当前确认升级为auto/bypass。 */
export function assertControlledPermissionChange(
	sessionId: string,
	mode: string,
): void {
	if (!isControlledProviderSession(sessionId)) return
	const execution = store.getAgentExecutionBySessionId(sessionId)!
	assertControlledPreparedExecution(execution.id, 'provider')
	const employee = store.getAgentEmployee(execution.agentId)
	if (mode !== 'plan' && mode !== (employee?.permissionMode ?? 'safe'))
		throw new Error('权限变化超出本次确认，请重新预检启动')
}

/** 真实Pi工具桥复用此约束；普通Agent委派和权限升级均不属于启动确认。 */
export function guardControlledPiToolContext(
	sessionId: string,
	context: ToolContext,
): ToolContext {
	if (!isControlledProviderSession(sessionId)) return context
	return {
		...context,
		runSubAgent: undefined,
		setPermissionMode: (mode) => {
			assertControlledPermissionChange(sessionId, mode)
			context.setPermissionMode?.(mode)
		},
	}
}

/** 原session一旦被识别为受控，后续marker/回执损坏也不撤掉出口。 */
export function createControlledProviderFetch(
	sessionId: string,
	actual: () => ControlledProviderContext,
	baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch | undefined {
	if (!isControlledProviderSession(sessionId)) return undefined
	const guarded = async (
		input: Parameters<typeof globalThis.fetch>[0],
		init?: Parameters<typeof globalThis.fetch>[1],
	): Promise<Response> => {
		const body =
			init?.body ??
			(input instanceof Request ? await input.clone().text() : undefined)
		if (typeof body !== 'string')
			throw new Error('非代码模型出口不能核验请求体')
		const payload = JSON.parse(body) as { model?: unknown }
		const current = actual()
		const requestUrl = new URL(
			input instanceof Request ? input.url : String(input),
		)
		const googleModelPath = `/models/${encodeURIComponent(current.modelId)}:`
		if (
			payload.model !== current.modelId &&
			!requestUrl.pathname.includes(googleModelPath)
		)
			throw new Error('模型请求体与确认模型不一致')
		const execution = store.getAgentExecutionBySessionId(sessionId)
		const employee = execution && store.getAgentEmployee(execution.agentId)
		const channel = employee && getChannelById(employee.channelId)
		if (!channel) throw new Error('模型渠道不可用')
		const url = new URL(input instanceof Request ? input.url : String(input))
		const base = new URL(
			current.runtime === 'pi'
				? resolvePiBaseUrl(channel.provider, channel.baseUrl)
				: resolveAgentRuntimeBaseUrl(
						channel.provider,
						'ai-sdk',
						channel.baseUrl,
					),
		)
		if (
			url.origin !== base.origin ||
			!(
				url.pathname === base.pathname ||
				url.pathname.startsWith(`${base.pathname.replace(/\/+$/, '')}/`)
			)
		)
			throw new Error('模型请求出口与确认渠道不一致')
		assertControlledProviderBoundary(sessionId, current)
		return baseFetch(input, init)
	}
	return Object.assign(guarded, { preconnect: () => {} })
}

/** 同一ModelRuntime覆盖普通对话、内部摘要及重试；保留已有payload钩子。 */
export function guardControlledPiModelRuntime(
	sessionId: string,
	runtime: ModelRuntime,
	actual: () => ControlledProviderContext,
	baseFetch: typeof globalThis.fetch = globalThis.fetch,
): void {
	if (!isControlledProviderSession(sessionId)) return
	const stream = runtime.stream.bind(runtime)
	const streamSimple = runtime.streamSimple.bind(runtime)
	runtime.stream = (model, context, options) =>
		stream(model, context, {
			...options,
			transport: 'sse',
			fetch: createControlledProviderFetch(
				sessionId,
				actual,
				options?.fetch ?? baseFetch,
			),
			onPayload: async (payload, requestModel) => {
				const amended = await options?.onPayload?.(payload, requestModel)
				assertControlledProviderBoundary(
					sessionId,
					{ ...actual(), modelId: requestModel.id },
					requestModel.baseUrl,
				)
				return amended
			},
		} as NonNullable<typeof options>)
	runtime.streamSimple = (model, context, options) =>
		streamSimple(model, context, {
			...options,
			transport: 'sse',
			fetch: createControlledProviderFetch(
				sessionId,
				actual,
				options?.fetch ?? baseFetch,
			),
			onPayload: async (payload, requestModel) => {
				const amended = await options?.onPayload?.(payload, requestModel)
				assertControlledProviderBoundary(
					sessionId,
					{ ...actual(), modelId: requestModel.id },
					requestModel.baseUrl,
				)
				return amended
			},
		})
	const unsupported = (): never => {
		throw new Error('非代码受控任务不允许未经核验的模型请求路径')
	}
	runtime.streamDeferred = unsupported
	runtime.fetchDeferred = unsupported
	runtime.generateImages = unsupported
	runtime.classify = unsupported
}
