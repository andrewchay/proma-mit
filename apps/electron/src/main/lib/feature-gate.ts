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
 * 最终可见 = 当前渠道允许（本文件） 且 权益允许（既有逻辑，不改动）。
 *
 * 功能清单中的新模块默认在 Dev 可见、Stable 隐藏；未登记模块仍按 fail-closed 处理。
 * 仅非打包开发环境可以通过 settings.json 临时开启显式隐藏的 Dev 模块。
 *
 * 全局调试放开：另有一条更粗暴的路径，一次性打开全部已登记模块。
 * - 运行时：环境变量 GRAVITAS_UNLOCK_ALL_CAPABILITIES=1，仅非打包环境有效
 * - 构建期：调试专用打包脚本注入 __GRAVITAS_DEV_UNLOCK__，打包产物也生效
 * 两者都见 dev-unlock.ts，且都不绕过登记表：未登记的模块 id 仍然不可见。
 */

import type { AppChannel } from './app-channel'
import { DEV_GATE_MODULES, type DevGateModuleId, type DevGateModuleMeta } from './dev-feature-manifest'
import { isDevUnlockEnabled } from './dev-unlock'

export { DEV_GATE_MODULES }
export type { DevGateModuleId, DevGateModuleMeta }

function findModule(moduleId: string): DevGateModuleMeta | undefined {
	return DEV_GATE_MODULES.find((module) => module.id === moduleId)
}
/** 该模块是否已宣布完成。未登记的模块返回 false，避免新增模块默认泄漏。 */
export function isModuleReleased(moduleId: string): boolean {
	return findModule(moduleId)?.stableAvailability === 'released'
}

/**
 * 模块是否对当前渠道可见。
 *
 * devModules 只允许覆盖 Dev 状态，且仅限非打包环境：
 * settings.json 是本机可编辑文件，若不限制运行环境，任何用户改一行 JSON
 * 就能解锁未完成功能，「默认关闭」就只是口头约定而非机制保证。
 */
export function isModuleVisible(
	moduleId: string,
	options: { devEnabled?: readonly string[]; isPackaged: boolean; channel?: AppChannel },
): boolean {
	// 必须同时是登记表内的模块，避免调用方传入任意 id 绕过白名单。
	// 调试放开也不能绕开这一条：未登记的模块没有发布状态可依据，不应默认泄漏。
	const module = findModule(moduleId)
	if (!module) return false
	// 调试放开优先于打包环境检查：构建期注入的标记就是为了在打包产物里生效，
	// 若放在 isPackaged 之后，build-mac-app.sh 产出的 .app 依旧看不到这些模块。
	// 透传 isPackaged，避免本进程里出现两份「是否打包」的判断源。
	if (isDevUnlockEnabled({ isPackaged: options.isPackaged })) return true

	const channel = options.channel ?? (options.isPackaged ? 'stable' : 'dev')
	if (channel === 'stable') return module.stableAvailability === 'released'
	if (module.devAvailability !== 'hidden') return true
	return !options.isPackaged && (options.devEnabled ?? []).includes(moduleId)
}

/**
 * 计算当前生效的模块清单（已发布 + 本地开启）。
 *
 * 这是渲染层唯一需要的输入：让渲染层拿到「哪些模块该可见」的结论，而不是
 * 自己再维护一份发布状态——两份状态一定会漂移，出现「IPC 放开了但入口还
 * 藏着」这类半开故障。
 */
export function resolveEffectiveModules(options: {
	devEnabled?: unknown
	isPackaged: boolean
	channel?: AppChannel
}): DevGateModuleId[] {
	const devEnabled = resolveDevEnabledModules(options.devEnabled, {
		isPackaged: options.isPackaged,
	})
	// 复用 isModuleVisible 而不是重写一遍判定条件：两份条件一定会漂移，
	// 出现「IPC 放开了但入口还藏着」这类半开故障。
	return DEV_GATE_MODULES.filter((module) =>
		isModuleVisible(module.id, { devEnabled, isPackaged: options.isPackaged, channel: options.channel }),
	).map((module) => module.id)
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
