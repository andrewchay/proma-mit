/** 开发 / 正式渠道的功能发布清单。新增功能默认 Dev 可见、Stable 隐藏。 */
export type DevGateModuleId =
	| 'knowledge'
	| 'marketing'
	| 'outbound-sourcing'
	| 'research'
	| 'proactive'
	| 'workflow'

export type DevFeatureAvailability = 'available' | 'hidden'
export type StableFeatureAvailability = 'released' | 'hidden'

export interface DevGateModuleMeta {
	id: DevGateModuleId
	/** 默认 available；调试期间可显式隐藏。 */
	devAvailability?: DevFeatureAvailability
	/** 默认 hidden；验收并准备发布时改为 released。 */
	stableAvailability?: StableFeatureAvailability
	note: string
}

/**
 * 单一渠道发布清单。
 * 新登记模块只需填写 id 与 note，Dev 自动显示而 Stable 保持隐藏。
 */
export const DEV_GATE_MODULES: readonly DevGateModuleMeta[] = [
	{
		id: 'knowledge',
		stableAvailability: 'released',
		note: '知识库已发布：K0–K2 链路可正常使用（索引、图谱、AOF 评测）',
	},
	{
		id: 'marketing',
		note: '营销能力中心在 Dev 验收（达人 / 投放 / 能力中心）',
	},
	{
		id: 'outbound-sourcing',
		note: '出海 sourcing 在 Dev 验收（买家发现与线索核验）',
	},
	{
		id: 'proactive',
		note: 'Proactive Center 在 Dev 验收（定时、监听、Routine、审批）',
	},
	{
		id: 'research',
		note: '研究领域能力包在 Dev 验收',
	},
	{
		id: 'workflow',
		note: 'Workflow 工作台在 Dev 验收',
	},
] as const

/** Stable 发布门禁读取此结果；无效清单会阻断发布检查。 */
export function validateDevGateModuleManifest(
	modules: readonly DevGateModuleMeta[] = DEV_GATE_MODULES,
): string[] {
	const errors: string[] = []
	const seen = new Set<string>()
	const devStatuses = new Set<string>(['available', 'hidden'])
	const stableStatuses = new Set<string>(['released', 'hidden'])

	for (const module of modules) {
		if (seen.has(module.id)) errors.push(`重复模块 id: ${module.id}`)
		seen.add(module.id)
		if (!module.note.trim()) errors.push(`模块 ${module.id} 缺少说明`)
		if (!devStatuses.has(module.devAvailability ?? 'available')) {
			errors.push(`模块 ${module.id} 的 Dev 状态无效`)
		}
		if (!stableStatuses.has(module.stableAvailability ?? 'hidden')) {
			errors.push(`模块 ${module.id} 的 Stable 状态无效`)
		}
	}

	return errors
}
