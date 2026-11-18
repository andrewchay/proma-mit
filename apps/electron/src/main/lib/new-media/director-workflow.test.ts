import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeNewMediaDb, clearNewMediaRecordsForTests } from './new-media-sqlite-store'
import { createDirectorBrand, updateDirectorBrand, createDirectorPlan, confirmDirectorPlan, createDirectorXiaohongshuDraft, createDirectorWechatDraft, listDirectorBrands, listDirectorPlans } from './director-workflow'
import { prepareXiaohongshuHandoff, buildXiaohongshuHandoffPackage } from './xiaohongshu-handoff'
import AdmZip from 'adm-zip'
import { newMediaPluginRuntime } from '../plugins/new-media-plugin'
import type { ToolContext } from '../agent-runtime/types'
import { delegateDirectorRole, directorRolePermissionMode, getDirectorRoleAgents } from './director-roles'
import { listDirectorRoleResults } from './director-workflow'
import { saveDirectorDesign, getDirectorDesignPreview } from './director-design'
import { validateDirectorSvg } from './director-design-renderer'
import { PNG } from 'pngjs'
import { runGuardedToolCall } from '../agent-runtime/tool-scheduler-service'
import { bindRuntimeSessionIdentity, revokeRuntimeSessionIdentity } from '../agent-runtime/runtime-session-identity'
import { buildBuiltinAgents } from '../agent-prompt-builder'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-director-')); process.env.PROMA_TEST_CONFIG_DIR = testDir; writeFileSync(join(testDir, 'settings.json'), JSON.stringify({ newMediaCapabilities: ['content-operations'] })) })
afterEach(async () => { await clearNewMediaRecordsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })
function boundContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const cwd = overrides.cwd ?? testDir
  const sessionId = overrides.sessionId ?? 'session'
  const owner = {}
  bindRuntimeSessionIdentity(owner, { sessionId, cwd, runtime: 'ai-sdk' })
  return { cwd, sessionId, runtime: 'ai-sdk', boundSession: owner, ...overrides }
}

describe('新媒体总监', () => {
  test('方案确认前不能保存成品，确认后可交接实际文案', async () => {
    const brand = await createDirectorBrand('英语品牌', '受众：大学生和成年人；课程信息待确认')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '口语选题与封面方案')
    const copy = { planId: plan.id, title: '开口练英语', body: '从一个场景开始练习。', hashtags: ['#英语口语'] }
    await expect(createDirectorXiaohongshuDraft(copy)).rejects.toThrow('先确认方案')
    await confirmDirectorPlan(plan.id)
    const draft = await createDirectorXiaohongshuDraft(copy)
    const handoff = await prepareXiaohongshuHandoff(draft.id)
    const zip = new AdmZip(await buildXiaohongshuHandoffPackage(handoff.id))
    const content = zip.readAsText('content.txt')
    expect(content).toContain(copy.title)
    expect(content).toContain(copy.body)
    expect(content).toContain('#英语口语')
    expect(handoff.warnings.join('')).toContain('未关联封面')
    expect(handoff.status).toBe('draft_ready')
  })

  test('确认工具必须取得用户确认后才能放行', async () => {
    const brand = await createDirectorBrand('品牌', '品牌资料')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '先做口语内容')
    const tool = newMediaPluginRuntime().contributeTools?.().find(item => item.name === 'nm_director_confirm_plan')
    expect(tool).toBeDefined()
    const base = boundContext({ abortSignal: new AbortController().signal })
    expect((await tool!.execute({ plan_id: plan.id }, { cwd: testDir, sessionId: 'unbound' })).isError).toBe(true)
    expect((await tool!.execute({ plan_id: plan.id }, base)).isError).toBe(true)
    const rejected = await tool!.execute({ plan_id: plan.id }, { ...base, onAskUser: async () => ({ behavior: 'deny', message: '取消' }) })
    expect(rejected.isError).toBe(true)
    expect((await listDirectorPlans(brand.id))[0]?.status).toBe('proposed')
    const accepted = await tool!.execute({ plan_id: plan.id }, { ...base, onAskUser: async (input) => {
      const questions = input.questions as Array<{ question: string }>
      expect(questions[0]?.question).toContain(plan.proposal)
      expect(questions[0]?.question).toContain('品牌资料')
      return { behavior: 'allow', answers: { [questions[0]!.question]: '确认并开始制作' } }
    } })
    expect(accepted.isError).not.toBe(true)
    expect((await listDirectorPlans(brand.id))[0]?.status).toBe('confirmed')
  })

  test('等待用户确认时不阻塞其他工具，取消后不记录确认', async () => {
    const brand = await createDirectorBrand('品牌', '资料')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '选题方案')
    const tool = newMediaPluginRuntime().contributeTools?.().find(item => item.name === 'nm_director_confirm_plan')
    if (!tool) throw new Error('缺少确认工具')
    let finish: (() => void) | undefined
    const controller = new AbortController()
    const ctx = boundContext({ abortSignal: controller.signal, onAskUser: async () => {
      await new Promise<void>(resolve => { finish = resolve })
      return { behavior: 'deny', message: '取消' }
    } })
    const pending = runGuardedToolCall({ tool, args: { plan_id: plan.id }, ctx, execute: () => tool.execute({ plan_id: plan.id }, ctx) })
    while (!finish) await Bun.sleep(1)
    const other = { name: 'unrelated-tool', description: '', parameters: { type: 'object' as const, properties: {} }, execute: async () => ({ toolCallId: '', content: 'ok' }) }
    const result = await Promise.race([runGuardedToolCall({ tool: other, args: {}, ctx, execute: () => other.execute() }), Bun.sleep(500).then(() => ({ toolCallId: '', content: 'timeout' }))])
    finish()
    expect(result.content).toBe('ok')
    expect((await pending).isError).toBe(true)
    expect((await listDirectorPlans(brand.id))[0]?.status).toBe('proposed')
  })

  test('新媒体能力启用时注册两个角色，停用后不再注册', () => {
    expect(buildBuiltinAgents(false)['new-media-copywriter']).toBeDefined()
    expect(buildBuiltinAgents(false)['new-media-designer']).toBeDefined()
    writeFileSync(join(testDir, 'settings.json'), JSON.stringify({ newMediaCapabilities: [] }))
    try { expect(buildBuiltinAgents(false)['new-media-designer']).toBeUndefined() }
    finally { writeFileSync(join(testDir, 'settings.json'), JSON.stringify({ newMediaCapabilities: ['content-operations'] })) }
  })

  test('能力停用后不注入工具，旧句柄也不能继续写入', async () => {
    const oldTool = newMediaPluginRuntime().contributeTools?.().find(item => item.name === 'nm_director_brand')
    expect(oldTool).toBeDefined()
    writeFileSync(join(testDir, 'settings.json'), JSON.stringify({ newMediaCapabilities: ['community-operations'] }))
    try {
      expect(newMediaPluginRuntime().contributeTools?.().some(item => item.name.startsWith('nm_director_'))).toBe(false)
      const result = await oldTool!.execute({ operation: 'create', name: '品牌', brief: '资料' }, boundContext())
      expect(result.isError).toBe(true)
      expect(await listDirectorBrands()).toHaveLength(0)
    } finally { writeFileSync(join(testDir, 'settings.json'), JSON.stringify({ newMediaCapabilities: ['content-operations'] })) }
  })

  test('写入前复核失败时不会保存品牌或确认状态', async () => {
    await expect(createDirectorBrand('品牌', '资料', () => { throw new Error('权限已撤销') })).rejects.toThrow('权限已撤销')
    expect(await listDirectorBrands()).toHaveLength(0)
    const brand = await createDirectorBrand('品牌', '资料')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '方案')
    await expect(confirmDirectorPlan(plan.id, () => { throw new Error('权限已撤销') })).rejects.toThrow('权限已撤销')
    expect((await listDirectorPlans(brand.id))[0]?.status).toBe('proposed')
  })

  test('等待确认时会话被撤销，用户选择确认也不能写入', async () => {
    const brand = await createDirectorBrand('品牌', '资料')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '方案')
    const tool = newMediaPluginRuntime().contributeTools?.().find(item => item.name === 'nm_director_confirm_plan')!
    const owner = {}
    bindRuntimeSessionIdentity(owner, { sessionId: 'session', cwd: testDir, runtime: 'ai-sdk' })
    const ctx: ToolContext = { cwd: testDir, sessionId: 'session', runtime: 'ai-sdk', boundSession: owner, abortSignal: new AbortController().signal, onAskUser: async input => {
      revokeRuntimeSessionIdentity(owner)
      const question = (input.questions as Array<{ question: string }>)[0]!.question
      return { behavior: 'allow', answers: { [question]: '确认并开始制作' } }
    } }
    const result = await tool.execute({ plan_id: plan.id }, ctx)
    expect(result.isError).toBe(true)
    expect((await listDirectorPlans(brand.id))[0]?.status).toBe('proposed')
  })

  test('只有确认的方案可委派角色，设计角色收到品牌、方案及 OpenDesign 可用性', async () => {
    const brand = await createDirectorBrand('英语品牌', '成人和大学生；价格待确认')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '口语场景内容')
    const calls: Array<{ agentName: string; task: string }> = []
    const ctx = boundContext({ runSubAgent: async input => {
      calls.push({ agentName: input.agentName, task: input.task })
      return '封面设计结果：尚无图片文件'
    } })
    await expect(delegateDirectorRole({ planId: plan.id, role: 'designer', task: '设计封面' }, ctx)).rejects.toThrow('尚未确认')
    expect(calls).toHaveLength(0)
    await confirmDirectorPlan(plan.id)
    await delegateDirectorRole({ planId: plan.id, role: 'designer', task: '设计封面' }, ctx)
    expect(calls[0]?.agentName).toBe('new-media-designer')
    expect(calls[0]?.task).toContain('成人和大学生')
    expect(calls[0]?.task).toContain('口语场景内容')
    expect(calls[0]?.task).toContain('od_missing_resource')
    expect((await listDirectorRoleResults(plan.id))[0]?.result).toContain('尚无图片文件')
    expect(Object.keys(getDirectorRoleAgents())).toEqual(['new-media-copywriter', 'new-media-designer'])
    expect(getDirectorRoleAgents()['new-media-designer']?.tools).not.toContain('Bash')
    expect(directorRolePermissionMode('new-media-designer', 'bypassPermissions')).toBe('safe')
    expect(directorRolePermissionMode('new-media-copywriter', 'bypassPermissions')).toBe('safe')
    expect(directorRolePermissionMode('explorer', 'bypassPermissions')).toBe('bypassPermissions')
    await expect(delegateDirectorRole({ planId: plan.id, role: 'copywriter', task: '写文案' }, boundContext())).rejects.toThrow('无法委派')
    await expect(delegateDirectorRole({ planId: plan.id, role: 'copywriter', task: '写文案' }, boundContext({ runSubAgent: async () => '子代理已完成任务，但未返回文本结果' }))).rejects.toThrow('未返回有效结果')
  })

  test('设计角色收到工作区 OpenDesign 品牌规范和令牌', async () => {
    const workspace = join(testDir, 'design-workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'DESIGN.md'), '# 词汇品牌\n使用柔和的蓝色与清晰的标题层级。')
    writeFileSync(join(workspace, 'tokens.css'), ':root { --brand-blue: #225588; }')
    const brand = await createDirectorBrand('品牌', '资料')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '方案')
    await confirmDirectorPlan(plan.id)
    let prompt = ''
    await delegateDirectorRole({ planId: plan.id, role: 'designer', task: '制作封面' }, boundContext({ cwd: workspace, runSubAgent: async input => { prompt = input.task; return 'SVG' } }))
    expect(prompt).toContain('词汇品牌')
    expect(prompt).toContain('--brand-blue: #225588')
    expect(prompt).toContain('1080 × 1440')
    expect(prompt).toContain('SVG 元素属性')
  })

  test('角色执行期间会话撤销，结果不会写入', async () => {
    const brand = await createDirectorBrand('品牌', '资料')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '方案')
    await confirmDirectorPlan(plan.id)
    const owner = {}
    bindRuntimeSessionIdentity(owner, { sessionId: 'session', cwd: testDir, runtime: 'ai-sdk' })
    const ctx: ToolContext = { cwd: testDir, sessionId: 'session', runtime: 'ai-sdk', boundSession: owner, runSubAgent: async () => { revokeRuntimeSessionIdentity(owner); return '结果' } }
    await expect(delegateDirectorRole({ planId: plan.id, role: 'copywriter', task: '写作' }, ctx)).rejects.toThrow('失效')
    expect(await listDirectorRoleResults(plan.id)).toHaveLength(0)
  })

  test('公众号方案确认后可保存公众号文案，但不能误用小红书方案', async () => {
    const brand = await createDirectorBrand('品牌', '成人英语')
    const plan = await createDirectorPlan(brand.id, 'wechat-official-account', '公众号内容')
    const input = { planId: plan.id, title: '标题', body: '正文' }
    await expect(createDirectorWechatDraft(input)).rejects.toThrow('请先确认方案')
    await confirmDirectorPlan(plan.id)
    const draft = await createDirectorWechatDraft(input)
    expect(draft.platformCopies['wechat-official-account']?.body).toBe('正文')
    const other = await createDirectorPlan(brand.id, 'xiaohongshu', '小红书内容')
    await confirmDirectorPlan(other.id)
    await expect(createDirectorWechatDraft({ ...input, planId: other.id })).rejects.toThrow('不是微信公众号渠道')
  })

  test('品牌更新不会改变已确认方案的品牌依据，新方案使用更新后的资料', async () => {
    const brand = await createDirectorBrand('英语品牌', '初始受众：大学生')
    const oldPlan = await createDirectorPlan(brand.id, 'xiaohongshu', '旧方案')
    await confirmDirectorPlan(oldPlan.id)
    const updated = await updateDirectorBrand(brand.id, '英语品牌', '新受众：职场人')
    const newPlan = await createDirectorPlan(brand.id, 'newsletter', '新方案')
    await confirmDirectorPlan(newPlan.id)
    const prompts: string[] = []
    const ctx = boundContext({ runSubAgent: async input => { prompts.push(input.task); return '文案结果' } })
    await delegateDirectorRole({ planId: oldPlan.id, role: 'copywriter', task: '写作' }, ctx)
    await delegateDirectorRole({ planId: newPlan.id, role: 'copywriter', task: '写作' }, ctx)
    expect(updated.revision).toBe(2)
    expect(prompts[0]).toContain('初始受众：大学生')
    expect(prompts[0]).not.toContain('新受众：职场人')
    expect(prompts[1]).toContain('新受众：职场人')
  })

  test('确认方案后设计随草稿预览和交接，篡改文件不能导出', async () => {
    const brand = await createDirectorBrand('英语品牌', '口语内容')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '封面方案')
    await confirmDirectorPlan(plan.id)
    const draft = await createDirectorXiaohongshuDraft({ planId: plan.id, title: '标题', body: '正文', hashtags: [] })
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1440"><rect width="1080" height="1440" fill="#123456"/></svg>'
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }))
    const asset = await saveDirectorDesign(draft.id, svg, async () => png)
    expect(await getDirectorDesignPreview(draft.id)).toEqual({ assetId: asset.id, dataUrl: `data:image/png;base64,${png.toString('base64')}` })
    const newer = await saveDirectorDesign(draft.id, svg, async () => png)
    await expect(prepareXiaohongshuHandoff(draft.id, asset.id)).rejects.toThrow('封面已变化')
    const handoff = await prepareXiaohongshuHandoff(draft.id, newer.id)
    expect(handoff.designAssetId).toBe(newer.id)
    const zip = new AdmZip(await buildXiaohongshuHandoffPackage(handoff.id))
    expect(zip.readFile('cover.png')?.equals(png)).toBe(true)
    expect(zip.readAsText('cover.svg')).toBe(svg)
    expect(handoff.warnings.join('')).not.toContain('未关联封面')
    await expect(saveDirectorDesign(draft.id, svg, async () => png)).rejects.toThrow('已准备交接')
    writeFileSync(join(testDir, 'new-media', 'director-assets', `${newer.id}.png`), 'tampered')
    await expect(buildXiaohongshuHandoffPackage(handoff.id)).rejects.toThrow('已变更或损坏')
  })

  test('审核时没有封面，但交接前新增封面，必须重新审核', async () => {
    const brand = await createDirectorBrand('品牌', '资料')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '方案')
    await confirmDirectorPlan(plan.id)
    const draft = await createDirectorXiaohongshuDraft({ planId: plan.id, title: '标题', body: '正文', hashtags: [] })
    expect(await getDirectorDesignPreview(draft.id)).toBeNull()
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }))
    const asset = await saveDirectorDesign(draft.id, '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>', async () => png)
    await expect(prepareXiaohongshuHandoff(draft.id, null)).rejects.toThrow('封面已变化')
    expect((await prepareXiaohongshuHandoff(draft.id, asset.id)).designAssetId).toBe(asset.id)
  })

  test('生成封面与准备交接同时发生时，交接等待封面并绑定实际文件', async () => {
    const brand = await createDirectorBrand('品牌', '资料')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '方案')
    await confirmDirectorPlan(plan.id)
    const draft = await createDirectorXiaohongshuDraft({ planId: plan.id, title: '标题', body: '正文', hashtags: [] })
    const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }))
    let finish: (() => void) | undefined
    const saving = saveDirectorDesign(draft.id, svg, async () => { await new Promise<void>(resolve => { finish = resolve }); return png })
    while (!finish) await Bun.sleep(1)
    const preparing = prepareXiaohongshuHandoff(draft.id)
    finish()
    const [asset, handoff] = await Promise.all([saving, preparing])
    expect(handoff.designAssetId).toBe(asset.id)
  })

  test('渲染时会话被撤销，不保存设计素材', async () => {
    const brand = await createDirectorBrand('品牌', '资料')
    const plan = await createDirectorPlan(brand.id, 'xiaohongshu', '方案')
    await confirmDirectorPlan(plan.id)
    const draft = await createDirectorXiaohongshuDraft({ planId: plan.id, title: '标题', body: '正文', hashtags: [] })
    const owner = {}
    bindRuntimeSessionIdentity(owner, { sessionId: 'session', cwd: testDir, runtime: 'ai-sdk' })
    const ctx: ToolContext = { cwd: testDir, sessionId: 'session', runtime: 'ai-sdk', boundSession: owner }
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }))
    await expect(saveDirectorDesign(draft.id, '<svg viewBox="0 0 10 10"></svg>', async () => { revokeRuntimeSessionIdentity(owner); return png }, ctx)).rejects.toThrow('失效')
    expect(await getDirectorDesignPreview(draft.id)).toBeNull()
  })

  test('设计源不能包含外部资源或动态内容', () => {
    expect(() => validateDirectorSvg('<svg viewBox="0 0 10 10"><!-- 标题 --><rect width="10" height="10"/></svg>')).not.toThrow()
    expect(() => validateDirectorSvg('<svg viewBox="0 0 10 10"><!-- 注释 --><script>alert(1)</script></svg>')).toThrow()
    expect(() => validateDirectorSvg('<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>')).toThrow()
    expect(() => validateDirectorSvg('<svg viewBox="0 0 10 10"><image href="file:///etc/passwd"/></svg>')).toThrow()
    expect(() => validateDirectorSvg('<svg viewBox="0 0 10 10"><rect onload="run()"/></svg>')).toThrow()
    expect(() => validateDirectorSvg('<svg viewBox="0 0 10 10"><rect fill="url(https://example.com/a)"/></svg>')).toThrow()
  })

  test('品牌和方案跨数据库重开保留；其他渠道不能误用小红书交接', async () => {
    const brand = await createDirectorBrand('品牌', '待确认')
    const plan = await createDirectorPlan(brand.id, 'newsletter', '内容计划')
    await confirmDirectorPlan(plan.id)
    closeNewMediaDb()
    expect((await listDirectorBrands()).map(item => item.id)).toContain(brand.id)
    expect((await listDirectorPlans(brand.id))[0]?.status).toBe('confirmed')
    await expect(createDirectorXiaohongshuDraft({ planId: plan.id, title: '标题', body: '正文', hashtags: [] })).rejects.toThrow('不是小红书')
  })
})
