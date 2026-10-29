import type { ToolContext } from './agent-runtime/types'
/** 非代码准备任务的模型出口。仅按权威execution识别，不接受客户端授权标志。 */
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { AnyModel, ProviderRequestOptions } from '@earendil-works/pi-ai'
import { resolveAgentRuntimeBaseUrl } from '@gravitas/shared'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getConfigDir } from './config-paths'
import { getAgentWorkspace, getAgentWorkspaceCwd } from './agent-workspace-manager'
import { getChannelById } from './channel-manager'
import * as store from './project-sqlite-store'
import {
	assertControlledPreparedExecution,
	requiresControlledStart,
} from './controlled-project-task-service'
import { resolveOwnerPlanningSession } from './project-owner-planning-source'
import { assertOwnerPlanningCredential, claimOwnerPlanningProviderRequest } from './project-owner-planning-provider'
import { resolvePiBaseUrl } from './adapters/pi-runtime-base-url'
import { assertNoOwnerBusinessSession } from './project-owner-task-evidence'
import { assertOwnerExecutionRequestGate } from './project-owner-execution-gates'
import { assertOwnerCommandRuntimeContext } from './project-owner-execution-start'
import { createOwnerRequestFetch } from './project-owner-execution-request-exit'
import { getPilotReviewedPriceEvidenceForModel } from './project-pilot-request-evidence'
import { ownerEmployeePriceProviderKind, readOwnerCommandRuntime } from './project-owner-employee-runtime'

export interface ControlledProviderContext {
	runtime: 'pi' | 'ai-sdk'
	cwd: string
	modelId: string
	permissionMode: string
}
export function isControlledProviderSession(sessionId: string): boolean {
	assertNoOwnerBusinessSession(sessionId)
	const execution = store.getAgentExecutionBySessionId(sessionId)
	if (!execution) return false
	// 旧队列或普通改派也不能凭缺少准备记录绕过最终发送与权限门禁。
	return (
		store.getAgentEmployee(execution.agentId)?.executionProfile === 'controlled' ||
		(execution.entityType === 'task' && requiresControlledStart(execution.entityId))
	)
}
export function hasOwnerCommandExecutionSession(sessionId: string): boolean {
	return Boolean(store.getAgentExecutionBySessionId(sessionId)?.ownerCommandId)
}
/** 每次最终payload/HTTP发送前重读；异步初始化与既有payload钩子不能沿用旧确认。 */
export function assertControlledProviderBoundary(
	sessionId: string,
	actual: ControlledProviderContext,
	actualBaseUrl?: string,
): void {
	assertNoOwnerBusinessSession(sessionId)
	const execution = store.getAgentExecutionBySessionId(sessionId)
	if (
		!execution ||
		execution.status !== 'running' ||
		execution.sessionId !== sessionId ||
		execution.entityType !== 'task'
	)
		throw new Error('非代码模型出口没有当前运行执行')
	const ownerCommandId = execution.ownerCommandId
	if (ownerCommandId) assertOwnerCommandRuntimeContext(execution.id, ownerCommandId, sessionId, true)
	else assertControlledPreparedExecution(execution.id, 'provider')
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
	const expectedCwd = ownerCommandId
		? getAgentWorkspaceCwd(workspace, sessionId)
		: workspace.rootPath ?? join(getConfigDir(), 'agent-workspaces', workspace.slug, sessionId)
	const expectedBaseUrl =
		actual.runtime === 'pi'
			? resolvePiBaseUrl(channel.provider, channel.baseUrl)
			: resolveAgentRuntimeBaseUrl(channel.provider, 'ai-sdk', channel.baseUrl)
	if (
		actual.runtime !== (employee.runtime ?? 'ai-sdk') ||
		actual.modelId !== employee.modelId ||
		(ownerCommandId ? actual.permissionMode !== 'safe' : (actual.permissionMode !== (employee.permissionMode ?? 'safe') && actual.permissionMode !== 'plan')) ||
		resolve(actual.cwd) !== resolve(expectedCwd) ||
		(actualBaseUrl !== undefined &&
			actualBaseUrl.replace(/\/+$/, '') !== expectedBaseUrl.replace(/\/+$/, ''))
	) {
		throw new Error('模型实际参数与确认的员工、模型、权限或工作区不一致')
	}
	// 这是请求准入时间，不宣称Provider已启动、实际费用或终态。
	if (!ownerCommandId) store.getProjectDb().prepare(
		'UPDATE controlled_task_preparations SET provider_admitted_at = COALESCE(provider_admitted_at, ?) WHERE execution_id = ?',
	).run(Date.now(), execution.id)
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
	const controlled = isControlledProviderSession(sessionId)
	return {
		...context,
		runSubAgent: controlled || !context.runSubAgent ? undefined : async (...args) => {
			assertNoOwnerBusinessSession(sessionId)
			if (isControlledProviderSession(sessionId)) throw new Error('受控会话不允许委派子代理')
			return context.runSubAgent!(...args)
		},
		setPermissionMode: controlled || context.setPermissionMode ? (mode) => {
			assertControlledPermissionChange(sessionId, mode)
			context.setPermissionMode?.(mode)
		} : undefined,
	}
}

/** 原session一旦被识别为受控，后续marker/回执损坏也不撤掉出口。 */
export function createControlledProviderFetch(
	sessionId: string,
	actual: () => ControlledProviderContext,
	baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
	// 即使初始化时是legacy也必须注入：用途可在异步初始化或既有请求钩子中出现。
	const initialExecution = store.getAgentExecutionBySessionId(sessionId)
	const ownerCommandId = initialExecution?.ownerCommandId ?? null
	let controlled = isControlledProviderSession(sessionId) || ownerCommandId !== null
	const guarded = async (
		input: Parameters<typeof globalThis.fetch>[0],
		init?: Parameters<typeof globalThis.fetch>[1],
	): Promise<Response> => {
		assertNoOwnerBusinessSession(sessionId)
		controlled = isControlledProviderSession(sessionId) || controlled
		if (!controlled) return baseFetch(input, init)
		const body =
			init?.body ??
			(input instanceof Request ? await input.clone().text() : undefined)
		assertNoOwnerBusinessSession(sessionId)
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
    // async请求体/代理初始化后重新读权威Owner用途；普通controlled保留原语义。
    const owner = resolveOwnerPlanningSession(sessionId)
    if (owner && current.runtime !== 'ai-sdk') throw new Error('Owner规划请求仅允许AI SDK Runtime')
    if (ownerCommandId && !['ai-sdk', 'pi'].includes(current.runtime)) throw new Error('Owner员工运行时与冻结协议不兼容')
    store.getProjectDb().transaction(() => {
      assertControlledProviderBoundary(sessionId, current, base.toString())
      if (ownerCommandId) {
        const ownerExecution = store.getAgentExecutionBySessionId(sessionId)
        if (!ownerExecution || ownerExecution.ownerCommandId !== ownerCommandId) throw new Error('Owner execution绑定在请求发送前变化')
        assertOwnerCommandRuntimeContext(ownerExecution.id, ownerCommandId, sessionId, true)
        assertOwnerExecutionRequestGate({ commandPurpose: 'owner_business_execution', sessionId, runtime: current.runtime, modelId: current.modelId, permissionMode: current.permissionMode, cwd: current.cwd, baseUrl: base.toString(), requestUrl: url.href })
      }
      if (owner) {
        assertOwnerPlanningCredential(owner, input, init)
        claimOwnerPlanningProviderRequest(sessionId, body, url)
      }
    })()
    // fetch内部默认follow会绕过第二次准入并外送冻结资料；所有Owner请求禁止重定向。
		assertNoOwnerBusinessSession(sessionId)
		return baseFetch(input, owner || ownerCommandId ? { ...init, redirect: 'error' } : init)
	}
	const guardedFetch = Object.assign(guarded, { preconnect: () => {} })
	if (ownerCommandId) {
		const ownerExecution = initialExecution!
		const ownerEmployee = store.getAgentEmployee(ownerExecution.agentId)
		const ownerChannel = ownerEmployee && getChannelById(ownerEmployee.channelId)
		if (!ownerChannel) throw new Error('Owner执行渠道不可用，拒绝绑定价格证据')
        const frozen = readOwnerCommandRuntime(ownerCommandId)
        const providerKind = ownerEmployeePriceProviderKind(frozen.runtime, ownerChannel.provider, frozen.modelId)
        const priceEvidenceId = getPilotReviewedPriceEvidenceForModel(actual().modelId, providerKind)?.evidenceId
		return createOwnerRequestFetch({ commandId: ownerCommandId, executionId: ownerExecution.id, sessionId, priceEvidenceId, baseFetch: guardedFetch })
	}
	return guardedFetch
}

/** 同一ModelRuntime覆盖普通对话、内部摘要及重试；保留已有payload钩子。 */
export function guardControlledPiModelRuntime(
	sessionId: string,
	runtime: ModelRuntime,
	actual: () => ControlledProviderContext,
	baseFetch: typeof globalThis.fetch = globalThis.fetch,
): void {
	let controlled = isControlledProviderSession(sessionId)
	const check = (): boolean => {
		assertNoOwnerBusinessSession(sessionId)
		controlled = isControlledProviderSession(sessionId) || controlled
		return controlled
	}
	const stream = runtime.stream
	const streamSimple = runtime.streamSimple
	runtime.stream = (model, context, options) => {
		const restricted = check()
		return stream.bind(runtime)(model, context, {
			...options,
			...(restricted ? { transport: 'sse' } : {}),
			fetch: createControlledProviderFetch(sessionId, actual, options?.fetch ?? baseFetch),
			onPayload: async (payload, requestModel) => {
				check()
				const amended = await options?.onPayload?.(payload, requestModel)
				if (check()) assertControlledProviderBoundary(
					sessionId, { ...actual(), modelId: requestModel.id }, requestModel.baseUrl,
				)
				return amended
			},
		} as NonNullable<typeof options>)
	}
	runtime.streamSimple = (model, context, options) => {
		const restricted = check()
		return streamSimple.call(runtime, model, context, {
			...options,
			...(restricted ? { transport: 'sse' } : {}),
			fetch: createControlledProviderFetch(sessionId, actual, options?.fetch ?? baseFetch),
			onPayload: async (payload, requestModel) => {
				check()
				const amended = await options?.onPayload?.(payload, requestModel)
				if (check()) assertControlledProviderBoundary(
					sessionId, { ...actual(), modelId: requestModel.id }, requestModel.baseUrl,
				)
				return amended
			},
		})
	}
	const checkUnsupported = (): void => {
		if (check()) throw new Error('非代码受控任务不允许未经核验的模型请求路径')
	}
	const alternateOptions = <TModel extends AnyModel>(options?: ProviderRequestOptions<TModel>): ProviderRequestOptions<TModel> => ({
		...options,
		fetch: createControlledProviderFetch(sessionId, actual, options?.fetch ?? baseFetch),
		onPayload: async (payload, requestModel) => {
			checkUnsupported()
			const amended = await options?.onPayload?.(payload, requestModel)
			checkUnsupported()
			return amended
		},
	})
	const streamDeferred = runtime.streamDeferred
	runtime.streamDeferred = (model, handle, options) => {
		checkUnsupported()
		return streamDeferred.call(runtime, model, handle, { ...options, ...alternateOptions(options) })
	}
	const fetchDeferred = runtime.fetchDeferred
	runtime.fetchDeferred = (model, handle, options) => {
		checkUnsupported()
		return fetchDeferred.call(runtime, model, handle, { ...options, ...alternateOptions(options) })
	}
	const generateImages = runtime.generateImages
	runtime.generateImages = (model, context, options) => {
		checkUnsupported()
		return generateImages.call(runtime, model, context, { ...options, ...alternateOptions(options) })
	}
	const classify = runtime.classify
	runtime.classify = (model, context, options) => {
		checkUnsupported()
		return classify.call(runtime, model, context, { ...options, ...alternateOptions(options) })
	}
}
