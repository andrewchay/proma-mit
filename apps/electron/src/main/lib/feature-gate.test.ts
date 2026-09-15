import { describe, expect, test } from 'bun:test'
import {
	DEV_GATE_MODULES,
	isModuleReleased,
	isModuleVisible,
	resolveDevEnabledModules,
	resolveEffectiveModules,
} from './feature-gate'

/**
 * 门禁行为测试：验证「未完成功能默认不可见」是机制保证，而不是口头约定。
 */
describe('开发阶段门禁', () => {
	test('登记表覆盖四个受管模块，未发布的仍默认隐藏', () => {
		expect(DEV_GATE_MODULES.map((module) => module.id)).toEqual([
			'knowledge',
			'marketing',
			'outbound-sourcing',
			'proactive',
		])
		// knowledge 已放开为 released；其余三个未完成，必须保持隐藏。
		expect(DEV_GATE_MODULES.filter((module) => module.status === 'hidden').map((module) => module.id)).toEqual([
			'marketing',
			'outbound-sourcing',
			'proactive',
		])
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
				devEnabled: ['proactive'],
			}),
		).toBe(false)
		expect(
			resolveDevEnabledModules(['proactive', 'marketing'], {
				isPackaged: true,
			}),
		).toEqual([])
	})

	test('非打包环境可逐个开启：只开 proactive 时不连带打开其他模块', () => {
		const options = { isPackaged: false, devEnabled: ['proactive'] }
		expect(isModuleVisible('proactive', options)).toBe(true)
		// knowledge 已发布，不受本地开关控制；其余未发布模块不应被连带打开。
		expect(isModuleVisible('knowledge', options)).toBe(true)
		expect(isModuleVisible('marketing', options)).toBe(false)
		expect(isModuleVisible('outbound-sourcing', options)).toBe(false)
		// 未传开关时仍默认关闭
		expect(isModuleVisible('proactive', { isPackaged: false })).toBe(false)
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

	test('模块改为 released 后不再受开发开关影响', () => {
		const module = DEV_GATE_MODULES.find((item) => item.id === 'knowledge')!
		const original = module.status
		try {
			module.status = 'released'
			expect(isModuleVisible('knowledge', { isPackaged: true })).toBe(true)
		} finally {
			module.status = original
		}
	})
	test('生效清单包含已发布模块，未发布的仍需本地开关', () => {
		expect(resolveEffectiveModules({ isPackaged: true })).toEqual(['knowledge'])
		expect(resolveEffectiveModules({ isPackaged: false, devEnabled: ['proactive'] })).toEqual([
			'knowledge',
			'proactive',
		])
		// 打包环境不因本地开关放开未发布模块，但已发布模块始终在内。
		expect(resolveEffectiveModules({ isPackaged: true, devEnabled: ['proactive'] })).toEqual(['knowledge'])
	})

	test('生效清单不接受未登记 id，避免渲染层被伪造输入放大', () => {
		expect(resolveEffectiveModules({ isPackaged: false, devEnabled: ['unknown', 'marketing'] })).toEqual([
			'knowledge',
			'marketing',
		])
	})
})
