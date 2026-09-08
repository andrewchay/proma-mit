import { openNativeSqlite } from './native-sqlite'
/** 离线安装包验收：仅在显式烟测模式和新建临时配置目录内运行。 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { SDKMessage } from '@gravitas/shared'
import { getConfigDir, getPluginToolsDir, seedDefaultSkills, seedDefaultTools, seedBundledWorkflowTemplates } from './config-paths'
import {
  createAgentWorkspace,
  DEFAULT_WORKSPACE_SKILL_SLUGS,
  getAllWorkspaceSkills,
  toggleSkillSet,
} from './agent-workspace-manager'
import { collectDirectoryTools } from './tool-definition-store'
import { createCampaign, listCampaigns, closeCampaignDatabase } from './campaign-manager'
import { upsertKOL, getKOLById, closeKolDatabase } from './marketing/ma-tools/kol-data-service'
import { listWorkflowTemplates } from './workflow-template-service'

export async function runPackageSmoke(): Promise<void> {
  assert(app.isPackaged, '必须验证实际安装包')
  assert(process.env.PROMA_TEST_CONFIG_DIR, '必须指定临时配置目录')
  const database = openNativeSqlite(':memory:')
  try {
    database.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id))')
    assert.throws(() => database.exec('INSERT INTO child VALUES (99)'))
  } finally { database.close() }
  const root = getConfigDir()
  assert(existsSync(join(root, '.package-smoke-empty')), '配置目录必须由烟测脚本创建')
  assert(existsSync(join(process.resourcesPath, 'default-tools/marketing/system_config.json')))
  assert(existsSync(join(process.resourcesPath, 'default-skills/find-skills/SKILL.md')))
  seedDefaultSkills()
  seedDefaultTools()
  seedBundledWorkflowTemplates()
  const workspace = createAgentWorkspace('Package Smoke Skills', undefined, 'package-smoke-skills')
  const defaultSkillSlugs = getAllWorkspaceSkills(workspace.slug)
    .filter(skill => skill.enabled)
    .map(skill => skill.slug)
    .sort()
  assert.deepEqual(defaultSkillSlugs, [...DEFAULT_WORKSPACE_SKILL_SLUGS].sort(), '新工作区默认 Skills 不符合核心集合')
  const disabledSkills = ['find-skills', 'proma-coach']
  assert.deepEqual(toggleSkillSet(workspace.slug, disabledSkills, false).sort(), disabledSkills, 'Skill Set 批量停用失败')
  const inactiveSlugs = getAllWorkspaceSkills(workspace.slug)
    .filter(skill => !skill.enabled)
    .map(skill => skill.slug)
  assert(disabledSkills.every(slug => inactiveSlugs.includes(slug)), 'Skill Set 停用状态未落盘')
  const kimiCompaction = await runLiveKimiCompactionSmoke(workspace, root)
  assert(listWorkflowTemplates().some(t => t.id === 'marketing-campaign'), '缺少 Campaign 模板')
  const tools = collectDirectoryTools(id => id === 'marketing')
  assert.equal(tools.length, 26, '内置工具发现不完整')
  const campaign = createCampaign({ name: 'Smoke', brand: 'Synthetic' })
  closeCampaignDatabase()
  assert(listCampaigns().some(c => c.id === campaign.id), 'Campaign 重开丢失')
  const kol = { id: 'smoke-kol', name: 'Synthetic', platform: 'xiaohongshu', followers: '100',
    engagement: '1%', category: 'test', price: '1', city: 'test', avatar: '', source: 'smoke', rawData: '{}' }
  upsertKOL(kol)
  closeKolDatabase()
  assert.equal(getKOLById(kol.id)?.name, kol.name, 'KOL 重开丢失')
  const tool = tools.find(t => t.name === 'ma_campaign_get')
  assert(tool, '未发现 Campaign 工具')
  const result = await tool.execute({ campaign_id: campaign.id }, { cwd: root, sessionId: 'package-smoke' })
  assert(!result.isError, result.content)
  assert(result.content.includes(campaign.id), '目录执行器没有返回真实 Campaign')
  // 同时检查升级旧资产和保护用户更高版本，不能仅验证首次复制。
  const configPath = join(getPluginToolsDir('marketing'), 'system_config.json')
  const bundled = JSON.parse(readFileSync(configPath, 'utf8')) as { version: number }
  writeFileSync(configPath, JSON.stringify({ ...bundled, version: 1 }))
  seedDefaultTools()
  assert.equal((JSON.parse(readFileSync(configPath, 'utf8')) as { version: number }).version, bundled.version)
  writeFileSync(configPath, JSON.stringify({ ...bundled, version: bundled.version + 1 }))
  seedDefaultTools()
  assert.equal((JSON.parse(readFileSync(configPath, 'utf8')) as { version: number }).version, bundled.version + 1)
  closeCampaignDatabase()
  closeKolDatabase()
  console.log(JSON.stringify({
    packageSmoke: 'passed',
    version: app.getVersion(),
    tools: tools.length,
    defaultSkills: defaultSkillSlugs.length,
    skillSetToggle: disabledSkills.length,
    kimiCompaction,
    sqlite: 'node:sqlite',
  }))
}

async function runLiveKimiCompactionSmoke(
  workspace: { id: string; slug: string },
  cwd: string,
): Promise<boolean> {
  const channelId = process.env.GRAVITAS_PACKAGE_SMOKE_KIMI_CHANNEL_ID
  if (!channelId) return false

  const [channelManager, sessionManager, auditService, adapterModule] = await Promise.all([
    import('./channel-manager'),
    import('./agent-session-manager'),
    import('./context-compaction-audit-service'),
    import('./adapters/pi-agent-adapter'),
  ])
  const channel = channelManager.getChannelById(channelId)
  assert(channel, '真实 Kimi 烟测渠道不存在')
  assert.equal(channel.provider, 'kimi-coding', '真实压缩烟测只允许 Kimi Coding 渠道')
  const model = process.env.GRAVITAS_PACKAGE_SMOKE_KIMI_MODEL
    ?? channel.models.find(candidate => candidate.enabled)?.id
    ?? channel.models[0]?.id
  assert(model, 'Kimi Coding 渠道没有可用模型')

  const session = sessionManager.createAgentSession(
    'Package Smoke Kimi Compaction',
    channel.id,
    workspace.id,
    model,
    'pi',
  )
  sessionManager.updateAgentSessionMeta(session.id, {
    lastContextUsage: {
      contextTokens: 231_871,
      modelId: model,
      recordedAt: Date.now(),
    },
  })

  const source = '这是用于验证 Kimi 自动压缩的合成历史，不包含用户数据。'.repeat(60)
  const historyMessages: SDKMessage[] = Array.from({ length: 22 }, (_, index) => ({
    type: index % 2 === 0 ? 'user' : 'assistant',
    message: { content: [{ type: 'text', text: `${source} #${index}` }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage))
  sessionManager.appendSDKMessages(session.id, historyMessages)
  const adapter = new adapterModule.PiAgentAdapter()
  const messages: SDKMessage[] = []
  try {
    for await (const message of adapter.query({
      sessionId: session.id,
      prompt: '请只回复 OK 两个字母，不要解释。',
      agentRuntime: 'pi',
      provider: 'kimi-coding',
      apiKey: channelManager.decryptApiKey(channel.id),
      baseUrl: channel.baseUrl,
      model,
      cwd,
      historyMessages,
      permissionMode: 'safe',
    })) {
      messages.push(message)
    }
  } finally {
    adapter.dispose()
  }

  const metrics = await auditService.getContextCompactionMetrics()
  assert.equal(metrics.total, 1, '隔离烟测应只产生一条上下文压缩审计')
  assert.deepEqual(metrics.byRuntime, [{ key: 'pi', count: 1 }], '真实 Kimi 压缩没有记录 Pi 审计')
  assert.deepEqual(metrics.byTrigger, [{ key: 'automatic', count: 1 }], '231K Kimi 会话没有触发自动压缩')
  const compactedHistory = sessionManager.getAgentSessionSDKMessages(session.id)
  assert.equal(compactedHistory.length, 21, '压缩后应保留边界消息和最近 20 条历史')
  assert.equal(compactedHistory[0]?.type, 'system', '压缩历史缺少边界消息')
  assert.equal(
    (compactedHistory[0] as { subtype?: string } | undefined)?.subtype,
    'compact_boundary',
    '压缩历史首条不是 compact_boundary',
  )
  assert(messages.some(message => message.type === 'assistant'), 'Kimi 压缩后没有继续完成当前回合')
  return true
}
