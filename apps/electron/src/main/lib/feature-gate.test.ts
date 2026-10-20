import { describe, expect, test, afterEach } from 'bun:test'
import { __setBuildInjectedUnlockForTest } from './dev-unlock'
import {
	DEV_GATE_MODULES,
	isModuleReleased,
	isModuleVisible,
	resolveDevEnabledModules,
	resolveEffectiveModules,
} from './feature-gate'

/** 渠道门禁行为测试：Dev 可先验收，Stable 仅开放已发布模块。 */
describe('开发阶段门禁', () => {
	test('新功能默认在 Dev 可见，在 Stable 隐藏', () => {
		expect(DEV_GATE_MODULES.map((module) => module.id)).toEqual([
			'knowledge',
			'marketing',
			'outbound-sourcing',
			'proactive',
			'research',
			'workflow',
		])
		expect(resolveEffectiveModules({ isPackaged: true, channel: 'dev' })).toEqual([
			'knowledge',
			'marketing',
			'outbound-sourcing',
			'proactive',
			'research',
			'workflow',
		])
		expect(resolveEffectiveModules({ isPackaged: true, channel: 'stable' })).toEqual(['knowledge'])
		expect(isModuleVisible('workflow', { isPackaged: true, channel: 'stable' })).toBe(false)
		expect(isModuleVisible('research', { isPackaged: true, channel: 'stable' })).toBe(false)
		expect(isModuleVisible('workflow', { isPackaged: true, channel: 'dev' })).toBe(true)
	})

	test('未登记模块一律不可见，新增模块不会默认泄漏', () => {
		expect(isModuleReleased('brand-new-module')).toBe(false)
		// 本地开关也不能解锁未登记模块：开关只对登记表内的 id 生效。
		expect(
			resolveDevEnabledModules(['brand-new-module'], { isPackaged: false }),
		).toEqual([])
		expect(
			isModuleVisible('brand-new-module', {
				isPackaged: false,
				devEnabled: ['brand-new-module'],
			}),
		).toBe(false)
		expect(isModuleVisible('brand-new-module', { isPackaged: true })).toBe(
			false,
		)
	})

	test('打包环境忽略本地开关，改 settings.json 无法解锁未完成功能', () => {
		expect(
			isModuleVisible('proactive', {
				isPackaged: true,
				channel: 'stable',
				devEnabled: ['proactive'],
			}),
		).toBe(false)
		expect(isModuleVisible('proactive', { isPackaged: true, channel: 'dev' })).toBe(true)
		expect(
			resolveDevEnabledModules(['proactive', 'marketing'], {
				isPackaged: true,
			}),
		).toEqual([])
	})

	test('非打包 Dev 可临时开启显式隐藏的模块', () => {
		const module = DEV_GATE_MODULES.find((item) => item.id === 'proactive')!
		const original = module.devAvailability
		module.devAvailability = 'hidden'
		try {
			const options = { channel: 'dev' as const, isPackaged: false }
			expect(isModuleVisible('proactive', options)).toBe(false)
			expect(isModuleVisible('proactive', { ...options, devEnabled: ['proactive'] })).toBe(true)
		} finally {
			module.devAvailability = original
		}
		expect(
			resolveDevEnabledModules(['proactive', 'knowledge'], {
				isPackaged: false,
			}),
		).toEqual(['proactive', 'knowledge'])
	})

	test('调试开关忽略非法输入与重复项', () => {
		expect(
			resolveDevEnabledModules('proactive', { isPackaged: false }),
		).toEqual([])
		expect(
			resolveDevEnabledModules([1, null, 'unknown', 'proactive', 'proactive'], {
				isPackaged: false,
			}),
		).toEqual(['proactive'])
		expect(resolveDevEnabledModules(undefined, { isPackaged: false })).toEqual(
			[],
		)
	})

	test('模块设为 Stable released 后在正式版可见', () => {
		const module = DEV_GATE_MODULES.find((item) => item.id === 'marketing')!
		const original = module.stableAvailability
		try {
			module.stableAvailability = 'released'
			expect(isModuleVisible('marketing', { isPackaged: true, channel: 'stable' })).toBe(true)
		} finally {
			module.stableAvailability = original
		}
	})
	test('生效清单按渠道返回模块', () => {
		expect(resolveEffectiveModules({ isPackaged: true })).toEqual(['knowledge'])
		expect(resolveEffectiveModules({ isPackaged: false })).toEqual([
			'knowledge',
			'marketing',
			'outbound-sourcing',
			'proactive',
			'research',
			'workflow',
		])
		// 打包环境不因本地开关放开未发布模块，但已发布模块始终在内。
		expect(resolveEffectiveModules({ isPackaged: true, channel: 'stable', devEnabled: ['proactive'] })).toEqual(['knowledge'])
	})

	test('生效清单不接受未登记 id，避免渲染层被伪造输入放大', () => {
		expect(resolveEffectiveModules({ isPackaged: false, devEnabled: ['unknown', 'marketing'] })).toEqual([
			'knowledge',
			'marketing',
			'outbound-sourcing',
			'proactive',
			'research',
			'workflow',
		])
	})
})

describe('开发阶段门禁 · 全局调试放开', () => {
	const originalEnv = { ...process.env }

	afterEach(() => {
		__setBuildInjectedUnlockForTest(undefined)
		process.env = { ...originalEnv }
	})

	test('设置放开开关后全部已登记模块生效，无需 enabledDevModules', () => {
		process.env.GRAVITAS_UNLOCK_ALL_CAPABILITIES = '1'
		const module = DEV_GATE_MODULES.find((item) => item.id === 'marketing')!
		const original = module.devAvailability
		module.devAvailability = 'hidden'
		try {
		expect(resolveEffectiveModules({ devEnabled: [], isPackaged: false })).toEqual([
			'knowledge',
			'marketing',
			'outbound-sourcing',
			'proactive',
			'research',
			'workflow',
		])
		expect(isModuleVisible('marketing', { isPackaged: false })).toBe(true)
		} finally {
			module.devAvailability = original
		}
	})

	test('放开不绕过登记表：未登记模块仍不可见', () => {
		process.env.GRAVITAS_UNLOCK_ALL_CAPABILITIES = '1'
		expect(isModuleVisible('brand-new-module', { isPackaged: false })).toBe(false)
	})

	test('打包环境忽略运行时放开开关', () => {
		process.env.GRAVITAS_UNLOCK_ALL_CAPABILITIES = '1'
		expect(resolveEffectiveModules({ devEnabled: [], isPackaged: true })).toEqual(['knowledge'])
	})

	test('构建期注入标记在打包环境也生效', () => {
		// build-mac-app.sh 产出的调试包走这条路径：打包环境 + 构建期标记
		__setBuildInjectedUnlockForTest(true)
		expect(resolveEffectiveModules({ devEnabled: [], isPackaged: true, channel: 'dev' })).toEqual([
			'knowledge',
			'marketing',
			'outbound-sourcing',
			'proactive',
			'research',
			'workflow',
		])
		expect(isModuleVisible('proactive', { isPackaged: true, channel: 'dev' })).toBe(true)
	})

	test('构建期注入标记同样不绕过登记表', () => {
		__setBuildInjectedUnlockForTest(true)
		expect(isModuleVisible('brand-new-module', { isPackaged: true })).toBe(false)
	})
})
