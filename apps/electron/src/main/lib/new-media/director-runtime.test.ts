import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'
import { bindAISDKSessionIdentity } from '../agent-runtime/ai-sdk-session-identity'
import type { AISDKRuntimeSessionState, ExecutedAISDKToolResult } from '../agent-runtime/ai-sdk-runtime-core'

mock.module('electron', () => buildElectronMock())
const xhsBrowserCalls: string[] = []
mock.module('./xiaohongshu-draft-browser', () => ({
  revealXiaohongshuDraftBrowser: (id: string) => { xhsBrowserCalls.push(`reveal:${id}`) },
  operateXiaohongshuDraftBrowser: async (id: string, action: 'fill' | 'verify') => { xhsBrowserCalls.push(`${action}:${id}`) },
}))
const directory = mkdtempSync(join(tmpdir(), 'director-runtime-'))
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
writeFileSync(join(directory, 'settings.json'), JSON.stringify({ newMediaCapabilities: ['content-operations'] }))
const { AISDKRuntimeCore } = await import('../agent-runtime/ai-sdk-runtime-core')
const { newMediaPluginRuntime } = await import('../plugins/new-media-plugin')
const { closeNewMediaDb } = await import('./new-media-sqlite-store')
const { initProjectDb, closeProjectDb } = await import('../project-sqlite-store')
initProjectDb()
afterAll(() => { closeProjectDb(); closeNewMediaDb(); if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = originalConfig; rmSync(directory, { recursive: true, force: true }) })

interface Tool { execute(input: Record<string, unknown>, options: { toolCallId: string; messages: unknown[]; context: Record<string, never> }): Promise<ExecutedAISDKToolResult> }

test('AI SDK 工具链可创建品牌、请求确认、委派角色并保存小红书草稿', async () => {
  const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'bypassPermissions', planModeEntered: false }
  bindAISDKSessionIdentity(activeSession, 'director-session', directory)
  const roleCalls: string[] = []
  let accepted = false
  const tools = new AISDKRuntimeCore().createAISDKTools(newMediaPluginRuntime().contributeTools!(), {
    sessionId: 'director-session', cwd: directory, signal: activeSession.controller.signal, activeSession,
    onAskUser: async input => { const question = (input.questions as Array<{ question: string }>)[0]!.question; return { behavior: 'allow', answers: { [question]: accepted ? '确认并开始制作' : '需要修改' } } },
    runSubAgent: async input => { roleCalls.push(input.agentName); return input.agentName === 'new-media-copywriter' ? '笔记文案' : '<svg viewBox="0 0 10 10"></svg>' },
  })
  const invoke = async (name: string, args: Record<string, unknown>) => (tools[name] as unknown as Tool).execute(args, { toolCallId: 'call', messages: [], context: {} })
  const brand = JSON.parse((await invoke('nm_director_brand', { operation: 'create', name: '英语品牌', brief: '大学生与成年人' })).content) as { id: string }
  const plan = JSON.parse((await invoke('nm_director_plan', { operation: 'create', brand_id: brand.id, channel: 'xiaohongshu', proposal: '口语场景选题' })).content) as { id: string }
  expect((await invoke('nm_director_delegate', { plan_id: plan.id, role: 'copywriter', task: '写文案' })).isError).toBe(true)
  expect((await invoke('nm_director_confirm_plan', { plan_id: plan.id })).isError).toBe(true)
  expect(roleCalls).toHaveLength(0)
  accepted = true
  expect((await invoke('nm_director_confirm_plan', { plan_id: plan.id })).isError).not.toBe(true)
  expect((await invoke('nm_director_delegate', { plan_id: plan.id, role: 'copywriter', task: '写文案' })).isError).not.toBe(true)
  expect((await invoke('nm_director_delegate', { plan_id: plan.id, role: 'designer', task: '设计封面' })).isError).not.toBe(true)
  const draft = JSON.parse((await invoke('nm_director_save_xiaohongshu_copy', { plan_id: plan.id, title: '英语口语', body: '笔记文案', hashtags: ['#英语'] })).content) as { platformCopies: { xiaohongshu: { body: string } } }
  expect(draft.platformCopies.xiaohongshu.body).toBe('笔记文案')
  expect(roleCalls).toEqual(['new-media-copywriter', 'new-media-designer'])
})

test('Pi 桥接的总监工具能完成确认和角色委派', async () => {
  const { createPiToolBridge } = await import('../adapters/pi-tool-bridge')
  const { bindRuntimeSessionIdentity } = await import('../agent-runtime/runtime-session-identity')
  const { validateToolArguments } = await import('@earendil-works/pi-ai')
  const owner = {}
  bindRuntimeSessionIdentity(owner, { sessionId: 'pi-director', cwd: directory, runtime: 'pi' })
  const calls: string[] = []
  const controller = new AbortController()
  const tools = createPiToolBridge({
    toolContext: {
      cwd: directory, sessionId: 'pi-director', runtime: 'pi', boundSession: owner, abortSignal: controller.signal,
      onAskUser: async input => { const question = (input.questions as Array<{ question: string }>)[0]!.question; return { behavior: 'allow', answers: { [question]: '确认并开始制作' } } },
      runSubAgent: async input => { calls.push(input.agentName); return '角色交付' },
    },
    assertToolSession: () => {}, canUseTool: async () => ({ allowed: true }),
  })
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(item => item.name === name)
    if (!tool) throw new Error(`缺少工具 ${name}`)
    const checked = validateToolArguments(tool, { type: 'toolCall', id: 'call', name, arguments: args as never }) as Record<string, unknown>
    const result = await tool.execute('call', checked, undefined, undefined, {} as never)
    const text = result.content.find(item => item.type === 'text')
    if (!text || text.type !== 'text') throw new Error('工具无文本结果')
    return { data: text.text, isError: (result.details as { isError: boolean }).isError }
  }
  const brand = JSON.parse((await invoke('nm_director_brand', { operation: 'create', name: '英语品牌', brief: '口语学习' })).data) as { id: string }
  const plan = JSON.parse((await invoke('nm_director_plan', { operation: 'create', brand_id: brand.id, channel: 'xiaohongshu', proposal: '学习场景' })).data) as { id: string }
  expect((await invoke('nm_director_confirm_plan', { plan_id: plan.id })).isError).toBe(false)
  expect((await invoke('nm_director_delegate', { plan_id: plan.id, role: 'designer', task: '制作封面' })).isError).toBe(false)
  expect(calls).toEqual(['new-media-designer'])
  const draft = await invoke('nm_director_save_xiaohongshu_copy', { plan_id: plan.id, title: '英语', body: '口语练习', hashtags: ['#英语'] })
  expect(draft.isError).toBe(false)
  expect(draft.data).toContain('#英语')
  const wechatPlan = JSON.parse((await invoke('nm_director_plan', { operation: 'create', brand_id: brand.id, channel: 'wechat-official-account', proposal: '公众号内容' })).data) as { id: string }
  expect((await invoke('nm_director_confirm_plan', { plan_id: wechatPlan.id })).isError).toBe(false)
  const wechatDraft = await invoke('nm_director_save_wechat_copy', { plan_id: wechatPlan.id, title: '英语', body: '口语练习' })
  expect(wechatDraft.isError).toBe(false)
  expect(wechatDraft.data).toContain('wechat-official-account')
  expect(tools.some(item => item.name === 'nm_director_xhs_draft_takeover')).toBe(true)
})

test('总监在接管期间暂停，只有用户明确完成后才核对草稿', async () => {
  const { createDirectorBrand, createDirectorPlan, confirmDirectorPlan, createDirectorXiaohongshuDraft } = await import('./director-workflow')
  const { prepareXiaohongshuHandoff } = await import('./xiaohongshu-handoff')
  const brand = await createDirectorBrand('英语品牌', '成人口语')
  const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '口语场景选题')
  await confirmDirectorPlan(plan.id)
  const draft = await createDirectorXiaohongshuDraft({ planId: plan.id, title: '英语口语', body: '口语练习', hashtags: [] })
  const activeSession: AISDKRuntimeSessionState = { controller: new AbortController(), permissionMode: 'bypassPermissions', planModeEntered: false }
  bindAISDKSessionIdentity(activeSession, 'director-takeover', directory)
  let request = Promise.withResolvers<(label: string) => void>()
  const tools = new AISDKRuntimeCore().createAISDKTools(newMediaPluginRuntime().contributeTools!(), {
    sessionId: 'director-takeover', cwd: directory, signal: activeSession.controller.signal, activeSession,
    onAskUser: async input => {
      expect(input.interactionType).toBe('computer_use_takeover')
      const question = (input.questions as Array<{ question: string; options: Array<{ description?: string }> }>)[0]!
      expect(question.options[0]?.description).toContain('暂存离开')
      const response = Promise.withResolvers<string>()
      request.resolve(response.resolve)
      const label = await response.promise
      return { behavior: 'allow', answers: { [question.question]: label } }
    },
  })
  const invoke = () => (tools.nm_director_xhs_draft_takeover as unknown as Tool).execute(
    { draft_id: draft.id }, { toolCallId: 'takeover', messages: [], context: {} },
  )
  expect((await invoke()).content).toContain('预览并准备')
  const handoff = await prepareXiaohongshuHandoff(draft.id)
  const canceled = invoke()
  const cancel = await request.promise
  expect(xhsBrowserCalls).toEqual([`reveal:${handoff.id}`])
  const listBrands = (tools.nm_director_brand as unknown as Tool).execute({ operation: 'list' }, { toolCallId: 'list', messages: [], context: {} })
  // 用户未回到对话时，共享调度器仍可处理其他工具。
  const concurrent = await Promise.race([listBrands, Bun.sleep(500).then(() => undefined)])
  cancel('取消')
  expect(concurrent?.content).toContain(brand.id)
  expect((await canceled).isError).toBe(true)
  expect(xhsBrowserCalls).toHaveLength(1)

  request = Promise.withResolvers()
  const transferred = invoke()
  const complete = await request.promise
  expect(xhsBrowserCalls).toEqual([`reveal:${handoff.id}`, `reveal:${handoff.id}`])
  complete('我已完成，可继续')
  expect((await transferred).content).toContain('与交接内容一致')
  expect(xhsBrowserCalls.at(-1)).toBe(`verify:${handoff.id}`)
})
