import { describe, expect, test } from 'bun:test'
import {
	moduleOfView,
	isViewVisible,
	resolveVisibleView,
	FALLBACK_DEV_MODULES,
} from './dev-gate'

describe('渲染层开发门禁', () => {
	test('四个模块对应的视图默认全部不可见', () => {
		const gated = [
			'knowledge',
			'influencer',
			'paid-media',
			'capabilities',
			'outbound-sourcing',
			'proactive',
		]
		for (const view of gated)
			expect(isViewVisible(view, FALLBACK_DEV_MODULES)).toBe(false)
	})

	test('项目管理与分析引擎不受门禁影响', () => {
		for (const view of ['projects', 'analysis', 'conversations', 'workflow']) {
			expect(moduleOfView(view)).toBeUndefined()
			expect(isViewVisible(view, [])).toBe(true)
		}
	})

	test('只开启一个模块不连带放开同一模块外的视图', () => {
		expect(isViewVisible('influencer', ['marketing'])).toBe(true)
		expect(isViewVisible('paid-media', ['marketing'])).toBe(true)
		expect(isViewVisible('knowledge', ['marketing'])).toBe(false)
		expect(isViewVisible('proactive', ['marketing'])).toBe(false)
	})

	test('旧持久化状态停在未发布模块时回落到对话视图，避免白屏', () => {
		expect(resolveVisibleView('proactive', FALLBACK_DEV_MODULES)).toBe(
			'conversations',
		)
		expect(resolveVisibleView('knowledge', [])).toBe('conversations')
		expect(resolveVisibleView('projects', [])).toBe('projects')
		expect(resolveVisibleView('proactive', ['proactive'])).toBe('proactive')
	})

	test('视图到模块的映射覆盖全部受管视图', () => {
		expect(moduleOfView('knowledge')).toBe('knowledge')
		expect(moduleOfView('influencer')).toBe('marketing')
		expect(moduleOfView('paid-media')).toBe('marketing')
		expect(moduleOfView('capabilities')).toBe('marketing')
		expect(moduleOfView('outbound-sourcing')).toBe('outbound-sourcing')
		expect(moduleOfView('proactive')).toBe('proactive')
	})
})
