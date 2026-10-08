import { resolveOwnerPlanningTask } from './project-owner-planning-source'
/** 非代码项目任务：准备不执行；本机显式启动确认不是Pilot grant或硬费用保证。 */
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from './config-paths'
import type {
	ControlledTaskStartPreview,
	ControlledTaskStartResult,
	PrepareControlledTaskInput,
} from '@gravitas/shared'
import * as store from './project-sqlite-store'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getChannelById } from './channel-manager'
import { hasProjectWorkspaceBinding } from './project-workspace-bindings'
import { validateControlledTarget } from './agent-controlled-context'
import { getActivePilotGrant } from './project-pilot-grant-issue'

interface PreparationRow {
	id: string
	project_id: string
	request_id: string
	task_id: string
	input_hash: string
	actor: string
	confirmed_preview_hash: string | null
	authorized_scope_hash: string | null
	authorized_until: number | null
	execution_id: string | null
	provider_admitted_at: number | null
}
function transactionResult<T>(run: () => T): T {
	let result: T | undefined
	store.getProjectDb().transaction(() => {
		result = run()
	})()
	if (result === undefined) throw new Error('非代码任务事务未产生回执')
	return result
}
const ttl = 5 * 60_000
const digest = (value: unknown): string =>
	createHash('sha256').update(JSON.stringify(value)).digest('hex')
function object(input: unknown, keys: string[]): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new Error('任务请求格式无效')
	const value = input as Record<string, unknown>
	if (Object.keys(value).some((key) => !keys.includes(key)))
		throw new Error('任务请求包含不允许的状态、身份或授权字段')
	return value
}
function text(value: unknown, limit: number, label: string): string {
	if (typeof value !== 'string' || !value.trim() || value.trim().length > limit)
		throw new Error(`${label}为空或过长`)
	return value.trim()
}
function parseInput(input: unknown): PrepareControlledTaskInput {
	const value = object(input, [
		'requestId',
		'projectId',
		'employeeId',
		'workspaceId',
		'title',
		'description',
		'priority',
	])
	const priority = value.priority ?? 'medium'
	if (!['low', 'medium', 'high', 'critical'].includes(String(priority)))
		throw new Error('任务优先级无效')
	if (
		typeof value.description !== 'string' ||
		value.description.length > 24_000
	)
		throw new Error('任务说明格式无效或过长')
	return {
		requestId: text(value.requestId, 128, '准备请求ID'),
		projectId: text(value.projectId, 128, '项目ID'),
		employeeId: text(value.employeeId, 128, '员工ID'),
		workspaceId: text(value.workspaceId, 128, '工作区ID'),
		title: text(value.title, 200, '任务目标'),
		description: value.description.trim(),
		priority: priority as PrepareControlledTaskInput['priority'],
	}
}
function target(projectId: string, employeeId: string, workspaceId: string) {
	const project = store.getProject(projectId)
	if (!project) throw new Error('项目不存在')
	const employee = store.getAgentEmployee(employeeId)
	if (!employee?.enabled || employee.executionProfile !== 'controlled')
		throw new Error('员工不存在、已停用或不是非代码受控员工')
	const result = validateControlledTarget(employee, workspaceId, {
		getChannel: getChannelById,
		getWorkspace: getAgentWorkspace,
	})
	if (!hasProjectWorkspaceBinding(projectId, workspaceId))
		throw new Error('工作区尚未授权给当前项目，请先在项目工作区中明确绑定')
	return {
		project,
		employee,
		result,
		channel: getChannelById(employee.channelId)!,
		workspace: getAgentWorkspace(workspaceId)!,
	}
}
/** 两种持久证据任一存在都需受控；损坏或恢复丢标记不能退回旧全自动。 */
export function requiresControlledStart(taskId: string): boolean {
	return Boolean(
		store.getTask(taskId)?.controlledPreparationId ||
			store
				.getProjectDb()
				.prepare(
					'SELECT id FROM controlled_task_preparations WHERE task_id = ?',
				)
				.get(taskId),
	)
}
function row(taskId: string): PreparationRow {
	const task = store.getTask(taskId)
	if (!task?.controlledPreparationId)
		throw new Error('不是待明确启动的非代码任务')
	const record = store
		.getProjectDb()
		.prepare(
			'SELECT * FROM controlled_task_preparations WHERE id = ? AND task_id = ?',
		)
		.get(task.controlledPreparationId, taskId) as PreparationRow | undefined
	if (
		!record ||
		record.project_id !== task.projectId ||
		record.actor !== 'local-user' ||
		!/^[a-f0-9]{64}$/.test(record.input_hash) ||
		typeof record.request_id !== 'string' ||
		!record.request_id
	)
		throw new Error('非代码任务准备回执缺失或损坏，请保留数据核查')
	return record
}
function context(taskId: string, allowOwnerPreview = false) {
  // A阶段只允许暂停准备。目的双证据防止关联丢失后降级普通Agent；B阶段将替换为受限出口校验。
  const ownerPlanning = resolveOwnerPlanningTask(taskId)
  if (ownerPlanning && !allowOwnerPreview)
    throw new Error('Owner规划出口尚未开放，不能按普通Agent启动')

	const task = store.getTask(taskId)
	if (
		!task ||
		task.parentId ||
		!task.assignee?.userId.startsWith('agent-') ||
		!task.workspaceId
	)
		throw new Error('任务身份、负责人或明确工作区已变化')
	const facts = target(
		task.projectId,
		task.assignee.userId.slice(6),
		task.workspaceId,
	)
	if (getActivePilotGrant(task.projectId))
		throw new Error('项目存在活动Pilot授权，不能从非代码普通入口派发')
	if (
		store
			.listTaskBlockers(task.projectId)
			.some((blocker) => blocker.taskId === taskId)
	)
		throw new Error('任务依赖尚未解除，请先解决阻塞')
	if (facts.employee.runtime === 'pi' && facts.channel.provider === 'google')
		throw new Error(
			'当前 Pi Google 渠道不支持已核验的受控模型出口，请为员工选择其他支持的渠道',
		)
	const capabilities = store.getActiveAgentEmployeeCapabilityVersions(
		facts.employee.id,
		task.workspaceId,
	)
	const scopeHash = digest({
    ...(ownerPlanning ? { ownerPlanning: { link: ownerPlanning.link, binding: ownerPlanning.binding, source: ownerPlanning.context, request: ownerPlanning.request } } : {}),
		task: {
			id: task.id,
			projectId: task.projectId,
			title: task.title,
			description: task.description,
			updatedAt: task.updatedAt,
			status: task.status,
			assignee: task.assignee,
			workspaceId: task.workspaceId,
			priority: task.priority,
			permissionRequests: task.permissionRequests ?? [],
			tokenBudget: task.tokenBudget ?? null,
		},
		projectUpdatedAt: facts.project.updatedAt,
		employee: {
			id: facts.employee.id,
			name: facts.employee.name,
			role: facts.employee.role,
			description: facts.employee.description,
			profile: facts.employee.executionProfile,
			runtime: facts.employee.runtime,
			prompt: facts.employee.systemPrompt,
			skills: facts.employee.skills,
			channelId: facts.employee.channelId,
			modelId: facts.result.modelId,
			permissionMode: facts.result.permissionMode,
			workspaceIds: facts.employee.workspaceIds,
			workspaceId: facts.employee.workspaceId,
		},
		// 只冻结配置指纹，不保存或返回凭据。
		channel: {
			id: facts.channel.id,
			provider: facts.channel.provider,
			baseUrl: facts.channel.baseUrl,
			updatedAt: facts.channel.updatedAt,
		},
		workspace: {
			id: facts.workspace.id,
			slug: facts.workspace.slug,
			rootPath: facts.workspace.rootPath,
			realRootPath: realpathSync(
				facts.workspace.rootPath ??
					join(getConfigDir(), 'agent-workspaces', facts.workspace.slug),
			),
		},
		capabilities: capabilities.map((version) => ({
			id: version.id,
			hash: version.contentHash,
		})),
	})
	return { task, ...facts, scopeHash, ownerPlanning }
}

/** 同事务首次INSERT就是paused，创建回执不通知自动派发。 */
export function prepareControlledTask(raw: unknown): {
	taskId: string
	created: boolean
} {
	const input = parseInput(raw)
	return transactionResult(() => {
		const facts = target(input.projectId, input.employeeId, input.workspaceId)
		const hash = digest(input)
		const existing = store
			.getProjectDb()
			.prepare(
				'SELECT * FROM controlled_task_preparations WHERE project_id = ? AND request_id = ?',
			)
			.get(input.projectId, input.requestId) as PreparationRow | undefined
		if (existing) {
			if (existing.input_hash !== hash)
				throw new Error('准备请求已用于其他内容，请重新确认后提交新请求')
			const task = store.getTask(existing.task_id)
			if (!task || task.controlledPreparationId !== existing.id)
				throw new Error('原请求任务已删除或回执不一致，不自动重新创建')
			return { taskId: task.id, created: false }
		}
		const id = randomUUID()
		const task = store.createTask(
			input.projectId,
			{
				title: input.title,
				description: input.description,
				priority: input.priority,
				workspaceId: input.workspaceId,
				assignee: {
					userId: `agent-${facts.employee.id}`,
					displayName: facts.employee.name,
				},
				createdByUserId: 'local-user',
			},
			{ id },
		)
		store
			.getProjectDb()
			.prepare(
				'INSERT INTO controlled_task_preparations (id, project_id, request_id, task_id, input_hash, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			)
			.run(
				id,
				input.projectId,
				input.requestId,
				task.id,
				hash,
				'local-user',
				Date.now(),
			)
		return { taskId: task.id, created: true }
	})
}
export function getControlledTaskStartPreview(
	taskId: string,
): ControlledTaskStartPreview {
	text(taskId, 128, '任务ID')
	row(taskId)
	const facts = context(taskId, true)
	if (!['paused', 'pending', 'in_progress'].includes(facts.task.status))
		throw new Error('当前任务状态不能开始')
	const executions = store.listAgentExecutionsByEntity('task', taskId)
	if (
		executions.some(
			(execution) =>
				execution.status === 'queued' || execution.status === 'running',
		)
	)
		throw new Error('任务已有排队或运行的执行，请查看现有执行')
  if (facts.ownerPlanning && (executions.length > 0 || store.getProjectDb().prepare('SELECT link_id FROM project_owner_planning_admissions WHERE link_id = ?').get(facts.ownerPlanning.link.id))) throw new Error('这份Owner准备已有Run或发送占位，不会补发；新调用需要新准备和费用确认')
	const expiresAt = (Math.floor(Date.now() / ttl) + 1) * ttl
	return {
		taskId,
		previewHash: digest({
			scopeHash: facts.scopeHash,
			previousExecutionId: executions[0]?.id ?? null,
			expiresAt,
		}),
		expiresAt,
		title: facts.task.title,
		description: facts.task.description,
		requestedPermissions: facts.task.permissionRequests ?? [],
		employeeName: facts.employee.name,
		channelName: facts.channel.name,
		modelId: facts.result.modelId,
		runtime: facts.employee.runtime,
		workspaceName: facts.workspace.name,
		permissionMode: facts.result.permissionMode,
    ...(facts.ownerPlanning ? { ownerPlanning: { purpose: 'owner_planning' as const, linkId: facts.ownerPlanning.link.id, ownerName: facts.ownerPlanning.binding.ownerName, bindingRevision: facts.ownerPlanning.link.bindingRevision, goalRevision: facts.ownerPlanning.link.goalRevision, planRevision: facts.ownerPlanning.link.planRevision, contextFingerprint: facts.ownerPlanning.context.fingerprint, promptHash: facts.ownerPlanning.link.promptHash, protocolVersion: '1' as const, maxRequests: 1 as const, maxOutputTokens: 4096 as const, systemPrompt: facts.ownerPlanning.request.systemPrompt, userPrompt: facts.ownerPlanning.request.userPrompt, context: facts.ownerPlanning.context, costs: 'unknown_no_hard_cap' as const } } : {}),
	}
}

/** 每次启动复核一次确认，仅供该execution消费；普通状态编辑永远不获得此凭据。 */
export function assertControlledPreparedExecution(
	executionId: string,
	stage: 'queue' | 'provider' = 'queue',
): void {
	const execution = store.getAgentExecution(executionId)
	if (!execution || execution.entityType !== 'task')
		throw new Error('非代码执行身份无效')
	const record = row(execution.entityId)
	const facts = context(execution.entityId)
	if (
		record.execution_id !== execution.id ||
		record.authorized_scope_hash !== facts.scopeHash ||
		!record.confirmed_preview_hash ||
		!/^[a-f0-9]{64}$/.test(record.confirmed_preview_hash) ||
		(record.provider_admitted_at !== null &&
			(!Number.isFinite(record.provider_admitted_at) ||
				record.provider_admitted_at <= 0)) ||
		!Number.isFinite(record.authorized_until) ||
		!record.authorized_until ||
		(record.authorized_until <= Date.now() &&
			!(stage === 'provider' && record.provider_admitted_at)) ||
		execution.agentId !== facts.employee.id ||
		execution.projectId !== facts.task.projectId
	) {
		throw new Error('非代码启动确认缺失、过期或范围/配置已变化，请重新预检确认')
	}
}
export function claimControlledPreparedExecution(executionId: string): void {
	store.getProjectDb().transaction(() => {
		assertControlledPreparedExecution(executionId)
		const result = store
			.getProjectDb()
			.prepare(
				"UPDATE agent_executions SET status = 'running', last_heartbeat_at = ? WHERE id = ? AND status = 'queued'",
			)
			.run(Date.now(), executionId)
		if (result.changes !== 1)
			throw new Error('非代码执行已被认领，不重复创建会话')
	})()
}
export async function startControlledTask(
	raw: unknown,
): Promise<ControlledTaskStartResult> {
	const input = object(raw, ['taskId', 'previewHash', 'acknowledgeModelCosts'])
	const taskId = text(input.taskId, 128, '任务ID')
	const previewHash = text(input.previewHash, 128, '预检指纹')
	if (input.acknowledgeModelCosts !== true)
		throw new Error('请明确确认本次模型费用；创建任务不等于执行授权')
	const { enqueueControlledPreparedTask, tryStartExecution } = await import(
		'./agent-employee-service'
	)
	const executionId = transactionResult(() => {
		const record = row(taskId)
		if (record.confirmed_preview_hash === previewHash && record.execution_id) {
			const existing = store.getAgentExecution(record.execution_id)
			if (!existing || existing.entityId !== taskId)
				throw new Error('已确认执行记录缺失，请保留数据核查')
			return existing.id
		}
		const preview = getControlledTaskStartPreview(taskId)
		if (preview.previewHash !== previewHash)
			throw new Error('任务或配置已变化，启动预检已失效，请重新确认')
		store.updateTask(taskId, { status: 'pending' })
		const scopeHash = context(taskId).scopeHash
		store
			.getProjectDb()
			.prepare(
				'UPDATE controlled_task_preparations SET confirmed_preview_hash = ?, authorized_scope_hash = ?, authorized_until = ?, provider_admitted_at = NULL WHERE id = ?',
			)
			.run(previewHash, scopeHash, preview.expiresAt, record.id)
		const id = enqueueControlledPreparedTask(taskId)
		store
			.getProjectDb()
			.prepare(
				'UPDATE controlled_task_preparations SET execution_id = ? WHERE id = ?',
			)
			.run(id, record.id)
		return id
	})
	await tryStartExecution(executionId)
	return {
		taskId,
		executionId,
		status: store.getAgentExecution(executionId)?.status ?? 'unknown',
	}
}
