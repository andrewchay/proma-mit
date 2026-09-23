import { describe, expect, test } from 'bun:test'
import {
	validateProactiveTarget,
	extractCurrentProactiveOutput,
} from './proactive-target-validation'

const target = {
	sessionId: 's',
	workspaceId: 'w',
	channelId: 'c',
	modelId: 'm',
	runtime: 'proma' as const,
	prompt: '检查变更',
	permissionMode: 'safe' as const,
}
const facts = {
	getChannel: () => ({
		enabled: true,
		defaultModel: 'm',
		models: [{ id: 'm', enabled: true }],
	}),
	getSession: () => ({
		workspaceId: 'w',
		channelId: 'c',
		agentRuntime: 'proma',
	}),
	getWorkspace: () => ({ rootPath: '/project' }),
	isDirectory: () => true,
}
describe('主动任务执行前检查', () => {
	test('有效目标冻结工作区与默认模型', () => {
		expect(
			validateProactiveTarget(
				{ ...target, modelId: undefined, workspaceId: undefined },
				facts,
			),
		).toMatchObject({ modelId: 'm', workspaceId: 'w' })
	})
	test('缺少默认模型时必须先配置，不能自动选第一个', () => {
		expect(() =>
			validateProactiveTarget(
				{ ...target, modelId: undefined },
				{
					...facts,
					getChannel: () => ({
						enabled: true,
						models: [{ id: 'm', enabled: true }],
					}),
				},
			),
		).toThrow('模型')
	})
	test('渠道停用、工作区消失和会话归属变化都在执行前拒绝', () => {
		expect(() =>
			validateProactiveTarget(target, {
				...facts,
				getChannel: () => undefined,
			}),
		).toThrow('渠道')
		expect(() =>
			validateProactiveTarget(target, { ...facts, isDirectory: () => false }),
		).toThrow('目录')
		expect(() =>
			validateProactiveTarget({ ...target, workspaceId: 'other' }, facts),
		).toThrow('工作区不一致')
		expect(() =>
			validateProactiveTarget(target, {
				...facts,
				getSession: () => undefined,
			}),
		).toThrow('会话')
	})
	test('新建会话必须显式指定工作区', () => {
		expect(() =>
			validateProactiveTarget(
				{ ...target, newSession: true, workspaceId: undefined },
				facts,
			),
		).toThrow('工作区')
	})
	test('不会隐式提升权限或开放未验收 runtime', () => {
		expect(() =>
			validateProactiveTarget(
				{ ...target, runtime: 'pi' } as unknown as typeof target,
				facts,
			),
		).toThrow('Runtime')
		expect(() =>
			validateProactiveTarget(
				{
					...target,
					permissionMode: 'bypassPermissions',
				} as unknown as typeof target,
				facts,
			),
		).toThrow('权限')
	})
})
describe('本轮结果快照', () => {
	test('只有旧 assistant 消息时不返回旧结果', () => {
		expect(
			extractCurrentProactiveOutput(
				[{ id: 'old', role: 'assistant', content: '旧结果' }],
				new Set(['old']),
			),
		).toBeUndefined()
	})
	test('仅提取新 assistant 输出，忽略后续 user 消息', () => {
		expect(
			extractCurrentProactiveOutput(
				[
					{ id: 'old', role: 'assistant', content: '旧' },
					{ id: 'new', role: 'assistant', content: ' 本次检查 ' },
					{ id: 'user', role: 'user', content: '忽略' },
				],
				new Set(['old']),
			),
		).toBe('本次检查')
	})
	test('proma runtime SDK 格式消息（uuid + blocks）能提取本轮输出，历史 uuid 被跳过', () => {
		const sdkMessages = [
			{ type: 'user', uuid: 'u-1', message: { content: [{ type: 'text', text: '整理' }] } },
			{
				type: 'assistant',
				uuid: 'a-old',
				message: { content: [{ type: 'text', text: '历史回答' }] },
			},
			{
				type: 'assistant',
				uuid: 'a-new',
				message: {
					content: [
						{ type: 'text', text: '```proma-memory-items\n{"items":[]}\n```' },
					],
				},
			},
		]
		expect(extractCurrentProactiveOutput(sdkMessages, new Set(['a-old']))).toBe(
			'```proma-memory-items\n{"items":[]}\n```',
		)
	})
	test('SDK 格式下无 uuid 的消息不参与身份匹配，不会被误判为历史消息', () => {
		expect(
			extractCurrentProactiveOutput(
				[{ type: 'assistant', message: { content: [{ type: 'text', text: '结果' }] } }],
				new Set(['undefined']),
			),
		).toBe('结果')
	})
})
