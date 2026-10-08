import type { AISDKAgentTurnInput } from './agent-runtime/ai-sdk-runtime-core'
import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(
	join(tmpdir(), 'gravitas-controlled-preparation-'),
)
const original = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const service = await import('./controlled-project-task-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject, unbindWorkspaceFromProject } = await import(
	'./project-workspace-bindings'
)
const { setHeadlessAgentRunner } = await import(
	'./agent-headless-runner-registry'
)
let calls = 0
const callbacks = new Map<string, HeadlessAgentRunCallbacks>()
beforeAll(async () => {
	await store.initProjectDb()
	setHeadlessAgentRunner(async (input, handlers) => {
		calls++
		callbacks.set(input.sessionId, handlers)
	})
})
afterAll(() => {
	employees.stopAgentEmployeeHeartbeat()
	store.closeProjectDb()
	if (original === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
	else process.env.PROMA_TEST_CONFIG_DIR = original
	rmSync(directory, { recursive: true, force: true })
})
function fixture() {
	const workspace = createAgentWorkspace(`研究-${randomUUID()}`)
	const project = store.createProject({ title: '定位项目', description: '' })
	bindWorkspaceToProject(project.id, workspace.id)
	const channel = createChannel({
		name: 'fake',
		provider: 'openai',
		baseUrl: 'https://example.invalid',
		apiKey: 'fake',
		enabled: true,
		models: [{ id: 'model', name: 'model', enabled: true }],
	})
	const employee = employees.createAgentEmployee({
		name: '需求分析师',
		role: '需求分析',
		description: '',
		executionProfile: 'controlled',
		permissionMode: 'safe',
		runtime: 'pi',
		channelId: channel.id,
		modelId: 'model',
		workspaceIds: [workspace.id],
	})
	const input = {
		requestId: randomUUID(),
		projectId: project.id,
		employeeId: employee.id,
		workspaceId: workspace.id,
		title: '整理产品定位',
		description: '产出可人工审阅的方案',
		priority: 'medium',
	}
	return { workspace, project, employee, input }
}
function executionCount(): number {
	return (
		store
			.getProjectDb()
			.prepare('SELECT COUNT(*) AS c FROM agent_executions')
			.get() as { c: number }
	).c
}

test('Given 受控员工与托管项目绑定 When 准备任务 Then 权威任务已指派但暂停且没有执行/模型副作用', () => {
	const { input, employee } = fixture()
	const count = executionCount()
	const before = calls
	const result = service.prepareControlledTask(input)
	expect(store.getTask(result.taskId)).toMatchObject({
		projectId: input.projectId,
		workspaceId: input.workspaceId,
		status: 'paused',
		assignee: { userId: `agent-${employee.id}`, displayName: employee.name },
	})
	expect(store.getTask(result.taskId)?.controlledPreparationId).toBeDefined()
	expect(executionCount()).toBe(count)
	expect(calls).toBe(before)
})

test('Given 请求已提交 When 重复调用及数据库重开 Then 同一任务且冲突请求拒绝', async () => {
	const { input } = fixture()
	const first = service.prepareControlledTask(input)
	expect(service.prepareControlledTask(input)).toEqual({
		taskId: first.taskId,
		created: false,
	})
	store.closeProjectDb()
	await store.initProjectDb()
	expect(service.prepareControlledTask(input).taskId).toBe(first.taskId)
	expect(() =>
		service.prepareControlledTask({ ...input, title: '不同目标' }),
	).toThrow('请求')
	expect(store.listTasks(input.projectId)).toHaveLength(1)
})

test('Given 客户端试图带状态身份授权或假角色 When 准备 Then 没有残留任务', () => {
	const { input } = fixture()
	for (const field of [
		'status',
		'actor',
		'grantId',
		'authorized',
		'permissionMode',
	])
		expect(() =>
			service.prepareControlledTask({ ...input, [field]: 'fake' }),
		).toThrow()
	expect(() =>
		service.prepareControlledTask({
			...input,
			employeeId: 'requirements-analyst',
		}),
	).toThrow('员工')
	expect(store.listTasks(input.projectId)).toHaveLength(0)
})

test('Given 项目解绑或员工停用 When 准备 Then 不自动绑定或全局回退', () => {
	const { input, workspace, project, employee } = fixture()
	unbindWorkspaceFromProject(project.id, workspace.id)
	expect(() => service.prepareControlledTask(input)).toThrow('项目')
	bindWorkspaceToProject(project.id, workspace.id)
	store.updateAgentEmployee(employee.id, { enabled: false })
	expect(() => service.prepareControlledTask(input)).toThrow('员工')
	expect(store.listTasks(project.id)).toHaveLength(0)
})

test('Given 待启动任务 When 只改状态或直接调用普通派发 Then 不建执行或调用模型', async () => {
	const { input } = fixture()
	const result = service.prepareControlledTask(input)
	const count = executionCount()
	const before = calls
	const task = store.updateTask(result.taskId, { status: 'pending' })!
	expect(await employees.dispatchTaskToAgent(task)).toBeNull()
	expect(executionCount()).toBe(count)
	expect(calls).toBe(before)
})

test('Given 有待启动预检 When 未确认费用或预检后更改目标 Then 拒绝启动', async () => {
	const { input } = fixture()
	const result = service.prepareControlledTask(input)
	const preview = service.getControlledTaskStartPreview(result.taskId)
	await expect(
		service.startControlledTask({
			taskId: result.taskId,
			previewHash: preview.previewHash,
			acknowledgeModelCosts: false,
		}),
	).rejects.toThrow()
	store.updateTask(result.taskId, { description: '扩大范围' })
	await expect(
		service.startControlledTask({
			taskId: result.taskId,
			previewHash: preview.previewHash,
			acknowledgeModelCosts: true,
		}),
	).rejects.toThrow('预检')
})

test('Given 当前预检及费用确认 When 并发重复开始 Then 仅一个权威execution与runner，完成仍待验收', async () => {
	const { input } = fixture()
	const result = service.prepareControlledTask(input)
	const preview = service.getControlledTaskStartPreview(result.taskId)
	const before = calls
	const count = executionCount()
	const [first, second] = await Promise.all([
		service.startControlledTask({
			taskId: result.taskId,
			previewHash: preview.previewHash,
			acknowledgeModelCosts: true,
		}),
		service.startControlledTask({
			taskId: result.taskId,
			previewHash: preview.previewHash,
			acknowledgeModelCosts: true,
		}),
	])
	expect(first.executionId).toBe(second.executionId)
	expect(executionCount()).toBe(count + 1)
	expect(calls).toBe(before + 1)
	expect(store.getAgentExecution(first.executionId)?.status).toBe('running')
	// 调用真实完成回调但无Provider/费用证据，完成后仍须人工验收。
	callbacks
		.get(store.getAgentExecution(first.executionId)!.sessionId!)!
		.onComplete([
			{
				id: randomUUID(),
				role: 'assistant',
				content: '隔离测试模拟成果，待人工验收',
				createdAt: Date.now(),
			},
		])
	const task = store.getTask(result.taskId)!
	expect(task.status).toBe('paused')
	expect(store.getAgentExecution(first.executionId)?.status).toBe('completed')
	expect(
		await employees.dispatchTaskToAgent({ ...task, status: 'pending' }),
	).toBeNull()
	expect(calls).toBe(before + 1)
})

test('Given 已准备任务 When 普通编辑清标记/改成旧员工 Then 中央入口仍不能执行', async () => {
	const { input, employee } = fixture()
	const result = service.prepareControlledTask(input)
	const marker = store.getTask(result.taskId)?.controlledPreparationId
	store.updateTask(result.taskId, {
		controlledPreparationId: undefined,
		status: 'pending',
	})
	expect(store.getTask(result.taskId)?.controlledPreparationId).toBe(marker)
	store.updateAgentEmployee(employee.id, { executionProfile: 'general' })
	expect(
		await employees.dispatchTaskToAgent(store.getTask(result.taskId)!),
	).toBeNull()
	expect(() => service.getControlledTaskStartPreview(result.taskId)).toThrow(
		'员工',
	)
})

const boundary = await import('./controlled-provider-boundary')
const { getAgentSessionWorkspacePath } = await import('./config-paths')
const { registerPiModelFromChannel } = await import(
	'./adapters/pi-model-registry'
)
async function runningFixture(cleanup = true, runtime: 'pi' | 'ai-sdk' = 'pi') {
	for (const execution of cleanup ? store.listRunningAgentExecutions() : []) {
		const handlers = execution.sessionId
			? callbacks.get(execution.sessionId)
			: undefined
		if (handlers) handlers.onError('隔离测试夹具收束')
		else store.updateAgentExecution(execution.id, { status: 'failed' })
	}
	const facts = fixture()
	if (runtime !== 'pi')
		store.updateAgentEmployee(facts.employee.id, { runtime })
	const { taskId } = service.prepareControlledTask(facts.input)
	const preview = service.getControlledTaskStartPreview(taskId)
	const { executionId } = await service.startControlledTask({
		taskId,
		previewHash: preview.previewHash,
		acknowledgeModelCosts: true,
	})
	const sessionId = store.getAgentExecution(executionId)!.sessionId!
	const cwd = getAgentSessionWorkspacePath(facts.workspace.slug, sessionId)
	return { ...facts, taskId, executionId, sessionId, cwd }
}
for (const column of [
	'controlled_preparation_id',
	'confirmed_preview_hash',
	'input_hash',
]) {
	test(`Given 已确认执行 When ${column}损坏并重开 Then 拒绝普通派发和模型出口`, async () => {
		const facts = await runningFixture()
		const before = calls
		if (column === 'controlled_preparation_id')
			store
				.getProjectDb()
				.prepare(
					'UPDATE tasks SET controlled_preparation_id = NULL WHERE id = ?',
				)
				.run(facts.taskId)
		else
			store
				.getProjectDb()
				.prepare(
					`UPDATE controlled_task_preparations SET ${column} = ? WHERE task_id = ?`,
				)
				.run('', facts.taskId)
		store.closeProjectDb()
		await store.initProjectDb()
		expect(
			await employees.dispatchTaskToAgent(store.getTask(facts.taskId)!),
		).toBeNull()
		expect(() =>
			service.assertControlledPreparedExecution(facts.executionId),
		).toThrow()
		expect(calls).toBe(before)
	})
}

test('Given 运行时异步准备后目标或工作区变化 When 最终HTTP出口调用 Then 零发送且禁止home回退', async () => {
	for (const mutate of ['goal', 'binding', 'profile', 'model', 'permission']) {
		const facts = await runningFixture()
		let sent = 0
		const fetch = Object.assign(
			async () => {
				sent++
				return new Response('never')
			},
			{ preconnect: () => {} },
		)
		const actual = () => ({
			runtime: 'pi' as const,
			cwd: facts.cwd,
			modelId: 'model',
			permissionMode: 'safe',
		})
		const guarded = boundary.createControlledProviderFetch(
			facts.sessionId,
			actual,
			fetch,
		)!
		if (mutate === 'goal')
			store.updateTask(facts.taskId, { description: '范围变化' })
		if (mutate === 'binding')
			unbindWorkspaceFromProject(facts.project.id, facts.workspace.id)
		if (mutate === 'profile')
			store.updateAgentEmployee(facts.employee.id, {
				executionProfile: 'general',
			})
		if (mutate === 'model')
			store.updateAgentEmployee(facts.employee.id, { modelId: 'other' })
		if (mutate === 'permission')
			store.updateAgentEmployee(facts.employee.id, { permissionMode: 'auto' })
		await expect(
			guarded('https://example.invalid/v1/chat/completions', {
				body: JSON.stringify({ model: 'model' }),
			}),
		).rejects.toThrow()
		expect(sent).toBe(0)
	}
	const facts = await runningFixture()
	expect(() =>
		boundary.assertControlledProviderBoundary(facts.sessionId, {
			runtime: 'pi',
			cwd: tmpdir(),
			modelId: 'model',
			permissionMode: 'safe',
		}),
	).toThrow('实际参数')
})

test('Given 真正Pi ModelRuntime及异步payload钩子 When 等待时目标变化 Then SDK主调用与内部摘要出口均零HTTP', async () => {
	for (const method of ['complete', 'completeSimple'] as const) {
		const facts = await runningFixture()
		const registration = await registerPiModelFromChannel({
			sessionId: facts.sessionId,
			provider: 'openai',
			apiKey: 'fake',
			baseUrl: 'https://example.invalid',
			modelId: 'model',
		})
		const actual = () => ({
			runtime: 'pi' as const,
			cwd: facts.cwd,
			modelId: 'model',
			permissionMode: 'safe',
		})
		let sent = 0
		const fetch = Object.assign(
			async () => {
				sent++
				return new Response('never')
			},
			{ preconnect: () => {} },
		)
		boundary.guardControlledPiModelRuntime(
			facts.sessionId,
			registration.modelRuntime,
			actual,
			fetch,
		)
		const result = await registration.modelRuntime[method](
			registration.model,
			{ messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] },
			{
				apiKey: 'fake',
				maxRetries: 0,
				onPayload: async () => {
					await Promise.resolve()
					store.updateTask(facts.taskId, { description: '初始化期间范围变化' })
				},
			},
		)
		expect(sent).toBe(0)
		expect(result.stopReason).toBe('error')
		expect(result.errorMessage).toContain('变化')
	}
})

test('Given 同一确认的主请求与压缩 When 首次准入后TTL结束 Then 相同范围可继续但新漂移拒发', async () => {
	const facts = await runningFixture()
	const actual = () => ({
		runtime: 'pi' as const,
		cwd: facts.cwd,
		modelId: 'model',
		permissionMode: 'safe',
	})
	let sent = 0
	const fetch = Object.assign(
		async () => {
			sent++
			return new Response('ok')
		},
		{ preconnect: () => {} },
	)
	const guarded = boundary.createControlledProviderFetch(
		facts.sessionId,
		actual,
		fetch,
	)!
	const call = () =>
		guarded('https://example.invalid/v1/chat/completions', {
			body: JSON.stringify({ model: 'model' }),
		})
	await call()
	store
		.getProjectDb()
		.prepare(
			'UPDATE controlled_task_preparations SET authorized_until = ? WHERE task_id = ?',
		)
		.run(Date.now() - 1, facts.taskId)
	await call()
	expect(sent).toBe(2)
	store.updateTask(facts.taskId, { description: '改目标' })
	await expect(call()).rejects.toThrow('变化')
	expect(sent).toBe(2)
})

test('Given 并发已满的已确认任务 When 排队期间模型变化 Then 启动复核失败且无新runner/session', async () => {
	await runningFixture()
	for (let index = 0; index < 4; index++) await runningFixture(false)
	const facts = await runningFixture(false)
	expect(store.getAgentExecution(facts.executionId)?.status).toBe('queued')
	const before = calls
	const previousSession = store.getAgentExecution(facts.executionId)?.sessionId
	store.updateAgentEmployee(facts.employee.id, { modelId: 'other' })
	expect(await employees.tryStartExecution(facts.executionId)).toBe(false)
	expect(store.getAgentExecution(facts.executionId)?.status).toBe('failed')
	expect(store.getAgentExecution(facts.executionId)?.sessionId).toBe(
		previousSession,
	)
	expect(calls).toBe(before)
})

test('Given 正确确认的真实Pi SDK When 模拟HTTP返回 Then 有一个合法出口，不是全部请求都被误拦截', async () => {
	const facts = await runningFixture()
	const registration = await registerPiModelFromChannel({
		sessionId: facts.sessionId,
		provider: 'openai',
		apiKey: 'fake',
		baseUrl: 'https://example.invalid',
		modelId: 'model',
	})
	let sent = 0
	const fetch = Object.assign(
		async () => {
			sent++
			return new Response(
				'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"离线结果"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{ headers: { 'Content-Type': 'text/event-stream' } },
			)
		},
		{ preconnect: () => {} },
	)
	boundary.guardControlledPiModelRuntime(
		facts.sessionId,
		registration.modelRuntime,
		() => ({
			runtime: 'pi',
			cwd: facts.cwd,
			modelId: 'model',
			permissionMode: 'safe',
		}),
		fetch,
	)
	const result = await registration.modelRuntime.completeSimple(
		registration.model,
		{ messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] },
		{ apiKey: 'fake', maxRetries: 0 },
	)
	expect(sent).toBe(1)
	expect(result.stopReason).toBe('stop')
})

test('Given AI SDK的受控执行 When 实际fetch出口前权限变更 Then 零HTTP', async () => {
	const facts = await runningFixture(true, 'ai-sdk')
	let sent = 0
	const fetch = Object.assign(
		async () => {
			sent++
			return new Response('never')
		},
		{ preconnect: () => {} },
	)
	const guarded = boundary.createControlledProviderFetch(
		facts.sessionId,
		() => ({
			runtime: 'ai-sdk',
			cwd: facts.cwd,
			modelId: 'model',
			permissionMode: 'auto',
		}),
		fetch,
	)!
	await expect(
		guarded('https://example.invalid/v1/chat/completions', {
			body: '{"model":"model"}',
		}),
	).rejects.toThrow('实际参数')
	expect(sent).toBe(0)
})

test('Given 受控Pi的真实工具桥且权限允许 When ExitPlan试图升级bypass或委派 Then 无权限变化与子代理', async () => {
	const facts = await runningFixture()
	const { createPiToolBridge } = await import('./adapters/pi-tool-bridge')
	let mode: 'safe' | 'auto' | 'plan' | 'bypassPermissions' = 'safe'
	let delegated = 0
	const context = boundary.guardControlledPiToolContext(facts.sessionId, {
		cwd: facts.cwd,
		sessionId: facts.sessionId,
		permissionMode: 'safe',
		onExitPlanMode: async () => ({
			behavior: 'allow',
			targetMode: 'bypassPermissions',
		}),
		setPermissionMode: (next) => {
			mode = next
		},
		runSubAgent: async () => {
			delegated++
			return 'never'
		},
	})
	const tools = createPiToolBridge({
		toolContext: context,
		allowSubAgent: false,
		canUseTool: async () => ({ allowed: true }),
	})
	expect(tools.some((tool) => tool.name === 'Agent')).toBe(false)
	expect(context.runSubAgent).toBeUndefined()
	const exit = tools.find((tool) => tool.name === 'ExitPlanMode')!
	await expect(
		exit.execute('scope-exit', {}, undefined, undefined, {} as never),
	).rejects.toThrow('权限变化')
	expect(mode).toBe('safe')
	expect(delegated).toBe(0)
	context.setPermissionMode?.('plan')
	expect(mode as string).toBe('plan')
	context.setPermissionMode?.('safe')
	expect(mode as string).toBe('safe')
})

test('Given AI SDK真实活跃adapter在模型等待中 When 外部选择bypass Then 拒绝且安全状态不变、写工具不执行', async () => {
	const facts = await runningFixture(true, 'ai-sdk')
	const { AISDKAgentAdapter } = await import('./adapters/ai-sdk-agent-adapter')
	const { AISDKRuntimeCore } = await import(
		'./agent-runtime/ai-sdk-runtime-core'
	)
	let release!: () => void
	let ready!: () => void
	const blocked = new Promise<void>((resolve) => {
		release = resolve
	})
	const started = new Promise<void>((resolve) => {
		ready = resolve
	})
	let turn: AISDKAgentTurnInput | undefined
	const spy = spyOn(
		AISDKRuntimeCore.prototype,
		'runAgentTurn',
	).mockImplementation(async (input) => {
		turn = input
		ready()
		await blocked
		return []
	})
	const adapter = new AISDKAgentAdapter()
	const iterator = adapter
		.query({
			sessionId: facts.sessionId,
			agentRuntime: 'ai-sdk',
			prompt: '离线测试',
			model: 'model',
			provider: 'openai',
			apiKey: 'fake',
			baseUrl: 'https://example.invalid',
			cwd: facts.cwd,
			permissionMode: 'safe',
		})
		[Symbol.asyncIterator]()
	const pending = iterator.next()
	try {
		await started
		await expect(
			adapter.setPermissionMode(facts.sessionId, 'bypassPermissions'),
		).rejects.toThrow('权限变化')
		expect(turn!.activeSession.permissionMode).toBe('safe')
		let written = false
		const tools = new AISDKRuntimeCore().createAISDKTools(
			[
				{
					name: 'Write',
					description: 'test',
					parameters: { type: 'object', properties: {} },
					execute: async () => {
						written = true
						return { toolCallId: 'write', content: 'never' }
					},
				},
			],
			{
				sessionId: facts.sessionId,
				cwd: facts.cwd,
				signal: turn!.activeSession.controller.signal,
				activeSession: turn!.activeSession,
			},
		)
		const write = tools.Write as unknown as {
			execute: (
				input: Record<string, unknown>,
				options: {
					toolCallId: string
					messages: never[]
					abortSignal: AbortSignal
					context: Record<string, unknown>
				},
			) => Promise<unknown>
		}
		await write.execute(
			{},
			{
				context: {},
				toolCallId: 'write',
				messages: [],
				abortSignal: turn!.activeSession.controller.signal,
			},
		)
		expect(written).toBe(false)
	} finally {
		release()
		await pending
		spy.mockRestore()
	}
})

test('Given 普通任务未准备 When 指派受控员工并经普通派发 Then 无执行且不调用runner', async () => {
  const { project, employee, workspace } = fixture()
  const task = store.createTask(project.id, { title: '普通创建不可授权', description: '', workspaceId: workspace.id, assignee: { userId: `agent-${employee.id}`, displayName: employee.name } })
  const before = calls
  try {
    expect(await employees.dispatchTaskToAgent(task)).toBeNull()
    expect(store.listAgentExecutionsByEntity('task', task.id)).toHaveLength(0)
    expect(calls).toBe(before)
  } finally {
    for (const run of store.listAgentExecutionsByEntity('task', task.id)) callbacks.get(run.sessionId)?.onComplete([], { stoppedByUser: true })
  }
})

test('Given 旧普通任务 When 改派到受控员工 Then 不能通过编辑获得执行授权', async () => {
  const { project, employee, workspace } = fixture()
  const task = store.createTask(project.id, { title: '人工任务', description: '', workspaceId: workspace.id })
  const updated = store.updateTask(task.id, { assignee: { userId: `agent-${employee.id}`, displayName: employee.name } })!
  const before = calls
  expect(await employees.dispatchTaskToAgent(updated)).toBeNull()
  expect(store.listAgentExecutionsByEntity('task', task.id)).toHaveLength(0)
  expect(calls).toBe(before)
})

test('Given 无确认的历史受控queue When 重开并启动 Then 失败暂停且零runner', async () => {
  const { project, employee, workspace } = fixture()
  const task = store.createTask(project.id, { title: '历史排队', description: '', workspaceId: workspace.id, assignee: { userId: `agent-${employee.id}`, displayName: employee.name } })
  const execution = store.createAgentExecution({ id: randomUUID(), projectId: project.id, entityType: 'task', entityId: task.id, agentId: employee.id, sessionId: '', prompt: '未授权的旧排队', status: 'queued' })
  const before = calls
  store.closeProjectDb()
  await store.initProjectDb()
  expect(await employees.tryStartExecution(execution.id)).toBe(false)
  expect(store.getAgentExecution(execution.id)?.status).toBe('failed')
  expect(store.getTask(task.id)?.status).toBe('paused')
  expect(store.getAgentExecution(execution.id)?.sessionId).toBe('')
  expect(calls).toBe(before)
})

test('Given 无确认的历史running When 请求模型或升级权限 Then 按员工身份识别并拒绝', () => {
  const { project, employee, workspace } = fixture()
  const task = store.createTask(project.id, { title: '历史运行', description: '', workspaceId: workspace.id, assignee: { userId: `agent-${employee.id}`, displayName: employee.name } })
  const sessionId = randomUUID()
  const execution = store.createAgentExecution({ id: randomUUID(), projectId: project.id, entityType: 'task', entityId: task.id, agentId: employee.id, sessionId, prompt: '旧记录', status: 'running' })
  try {
    expect(boundary.isControlledProviderSession(sessionId)).toBe(true)
    expect(() => boundary.assertControlledProviderBoundary(sessionId, { runtime: 'pi', cwd: directory, modelId: 'model', permissionMode: 'safe' })).toThrow()
    expect(() => boundary.assertControlledPermissionChange(sessionId, 'bypassPermissions')).toThrow()
    const context = boundary.guardControlledPiToolContext(sessionId, { cwd: directory, sessionId, permissionMode: 'safe', runSubAgent: async () => '不应执行' })
    expect(context.runSubAgent).toBeUndefined()
  } finally {
    store.updateAgentExecution(execution.id, { status: 'failed' })
  }
})
