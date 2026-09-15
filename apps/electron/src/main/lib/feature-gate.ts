/**
 * 开发阶段门禁（Development Stage Gate）
 *
 * 与订阅权益门禁（entitlement-gate）职责严格分离：
 * - 权益门禁回答「用户买了没有」，开放条件是用户付费。
 * - 本门禁回答「功能做完了没有」，开放条件是我们自己宣布完成。
 *
 * 两者不要合并。合并后会出现「订阅了却打不开」或「没做完却能看到」这类
 * 无法归因的问题，且两边的演进节奏完全不同：权益跟商业策略走，开发状态
 * 跟工程进度走。
 *
 * 最终可见 = 该模块已发布（本文件） 且 权益允许（既有逻辑，不改动）。
 *
 * 默认策略：未登记或状态非 released 的模块一律不可见（fail-closed）。
 * 需要临时调试时，在非打包环境的 settings.json 写入 enabledDevModules，
 * 详见 isDevModuleAllowed()。
 */

/** 受开发阶段门禁管辖的模块 id。新增模块必须先在此登记，否则一律不可见。 */
export type DevGateModuleId =
	| 'knowledge'
	| 'marketing'
	| 'outbound-sourcing'
	| 'proactive'

/**
 * 模块发布状态。
 *
 * - `hidden`：未完成，对所有用户不可见（默认值）
 * - `released`：已完成，进入正常可见流程；此时才由权益门禁等后续判定接管
 *
 * 模块做完后把这里改成 `released` 即可放开，不需要删除任何代码。
 */
export type DevGateModuleStatus = 'hidden' | 'released'

export interface DevGateModuleMeta {
	id: DevGateModuleId
	status: DevGateModuleStatus
	/** 人话说明：这个模块为什么处于当前状态，避免半年后没人敢改 */
	note: string
}

/**
 * 模块发布状态登记表——单一事实源。
 *
 * 当前四个模块均未完成调试，因此全部为 hidden。项目管理与分析引擎不在管辖
 * 范围内（未登记即不受本门禁限制），保持正常展示。
 */
export const DEV_GATE_MODULES: readonly DevGateModuleMeta[] = [
	{
		id: 'knowledge',
		status: 'hidden',
		note: '知识库 K0–K2 链路未调试完（索引、图谱、AOF 评测）',
	},
	{
		id: 'marketing',
		status: 'hidden',
		note: '营销能力中心未调试完（达人 / 投放 / 能力中心）',
	},
	{
		id: 'outbound-sourcing',
		status: 'hidden',
		note: '出海 sourcing 未调试完（买家发现与线索核验）',
	},
	{
		id: 'proactive',
		status: 'hidden',
		note: 'Proactive Center 未调试完（定时、监听、Routine、审批）',
	},
] as const

function findModule(moduleId: string): DevGateModuleMeta | undefined {
	return DEV_GATE_MODULES.find((module) => module.id === moduleId)
}
/** 该模块是否已宣布完成。未登记的模块返回 false，避免新增模块默认泄漏。 */
export function isModuleReleased(moduleId: string): boolean {
	return findModule(moduleId)?.status === 'released'
}

/**
 * 模块最终是否对用户可见。
 *
 * devModules 允许被本地调试开关覆盖，但仅限非打包环境：
 * settings.json 是本机可编辑文件，若不限制运行环境，任何用户改一行 JSON
 * 就能解锁未完成功能，「默认关闭」就只是口头约定而非机制保证。
 */
export function isModuleVisible(
	moduleId: string,
	options: { devEnabled?: readonly string[]; isPackaged: boolean },
): boolean {
	if (isModuleReleased(moduleId)) return true
	if (options.isPackaged) return false
	// 必须同时是登记表内的模块，避免调用方传入任意 id 绕过白名单。
	if (!findModule(moduleId)) return false
	return (options.devEnabled ?? []).includes(moduleId)
}

/**
 * 校验并规整本地调试开关。
 *
 * 打包环境一律返回空数组：调用方不需要各自判断环境，避免漏判一处就放行。
 */
export function resolveDevEnabledModules(
	raw: unknown,
	options: { isPackaged: boolean },
): string[] {
	if (options.isPackaged) return []
	if (!Array.isArray(raw)) return []
	const known = new Set<string>(DEV_GATE_MODULES.map((module) => module.id))
	return [
		...new Set(
			raw.filter((id): id is string => typeof id === 'string' && known.has(id)),
		),
	]
}
