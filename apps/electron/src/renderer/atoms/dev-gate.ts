/**
 * 开发阶段门禁（渲染层）
 *
 * 与主进程 feature-gate.ts 使用同一份模块 id，判定输入来自主进程下发的
 * 生效开关（已按打包环境过滤），渲染层不重复判断环境，避免两边规则漂移。
 */

import { atom } from 'jotai'
import type { ActiveView } from './active-view'

/** 受开发阶段门禁管辖的模块 id，必须与 main/lib/feature-gate.ts 保持一致。 */
export type DevGateModuleId =
	| 'knowledge'
	| 'marketing'
	| 'outbound-sourcing'
	| 'proactive'

/** 模块 id → 主内容区视图 id（一个模块可能对应多个视图） */
const MODULE_VIEWS: Record<DevGateModuleId, ActiveView[]> = {
	knowledge: ['knowledge'],
	marketing: ['influencer', 'paid-media', 'capabilities'],
	'outbound-sourcing': ['outbound-sourcing'],
	proactive: ['proactive'],
}

/** knowledge / marketing / outbound-sourcing / proactive 四个模块默认全部关闭，未放开前保持隐藏。 */
export const FALLBACK_DEV_MODULES: DevGateModuleId[] = []

/** 主进程下发的生效模块开关（打包环境恒为空数组）。 */
export const enabledDevModulesAtom =
	atom<DevGateModuleId[]>(FALLBACK_DEV_MODULES)

/** 视图 id → 所属开发模块；未登记的视图不受门禁管辖。 */
export function moduleOfView(view: string): DevGateModuleId | undefined {
	for (const [moduleId, views] of Object.entries(MODULE_VIEWS) as Array<
		[DevGateModuleId, ActiveView[]]
	>) {
		if (views.includes(view as ActiveView)) return moduleId
	}
	return undefined
}

/** 该视图当前是否允许展示。未登记视图一律放行，避免影响既有模块。 */
export function isViewVisible(
	view: string,
	enabledModules: readonly DevGateModuleId[],
): boolean {
	const moduleId = moduleOfView(view)
	if (!moduleId) return true
	return enabledModules.includes(moduleId)
}

/**
 * 视图兜底：当前视图所属模块未启用时回落到 conversations。
 *
 * 用于处理旧持久化状态（例如上次停在未发布模块）导致的空白页。
 */
export function resolveVisibleView(
	view: ActiveView,
	enabledModules: readonly DevGateModuleId[],
): ActiveView {
	return isViewVisible(view, enabledModules) ? view : 'conversations'
}

/**
 * 从主进程读取生效开关。
 *
 * 主进程已按打包环境过滤（打包恒为空），这里不做环境判断，避免两处规则漂移；
 * 读取失败按「全部关闭」处理，不能因为一次读取异常就放开未完成功能。
 */
export async function initializeDevModules(
	setEnabled: (modules: DevGateModuleId[]) => void,
): Promise<void> {
	try {
		const settings = await window.electronAPI.getSettings()
		const raw = Array.isArray(settings.enabledDevModules)
			? settings.enabledDevModules
			: []
		setEnabled(
			raw.filter(
				(id): id is DevGateModuleId =>
					typeof id === 'string' &&
					(id === 'knowledge' ||
						id === 'marketing' ||
						id === 'outbound-sourcing' ||
						id === 'proactive'),
			),
		)
	} catch (error) {
		console.error('[开发门禁] 读取开关失败，按全部关闭处理:', error)
		setEnabled(FALLBACK_DEV_MODULES)
	}
}
