import { openNativeSqlite } from './native-sqlite'
/** 安装包验收：仅在显式烟测模式和新建临时配置目录内运行。 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { resolveModelContextCapability, type AgentRuntime, type SDKMessage } from '@gravitas/shared'
import { getConfigDir, getPluginToolsDir, seedDefaultSkills, seedDefaultTools, seedBundledWorkflowTemplates, seedMarketingSkills } from './config-paths'
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
import { getMarketingPluginDir, syncMarketingSkillsForWorkspace } from './marketing-skills-sync'
import { updateSettings } from './settings-service'
import { readdirSync } from 'node:fs'
import { createNoteFile, updateNoteFile, renameNoteFile, deleteNoteFile, readNoteFile, noteFileVersion } from './knowledge-write-service'
import { createKnowledgeVault, indexKnowledgeVault, listKnowledgeNotes } from './knowledge-service'
import { hasCapability } from './entitlement-gate'
import { getAgentWorkspacePath } from './config-paths'

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
  assert(existsSync(join(process.resourcesPath, 'marketing-skills/ma-kol-scraper/SKILL.md')), 'marketing-skills 打包缺失')
  seedDefaultSkills()
  seedMarketingSkills()
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
  // 营销 skills 订阅分发烟测：订阅 influencer → 工作区出现 22 个营销 skill
  // 注意：偏好（settings）与权益（签名快照）缺一不可。签名快照由
  // scripts/package-smoke.ts 用临时密钥签发并经环境变量传入公钥。
  updateSettings({ marketingCapabilities: ['influencer'] })
  syncMarketingSkillsForWorkspace(workspace.slug)
  const mktPluginSkills = join(getAgentWorkspacePath(workspace.slug), '.marketing-plugin', 'skills')
  assert(existsSync(mktPluginSkills), '营销 skills 未分发到工作区')
  assert.equal(readdirSync(mktPluginSkills).length, 22, '营销 skills 分发数量不符')
  updateSettings({ marketingCapabilities: [] })
  syncMarketingSkillsForWorkspace(workspace.slug)
  assert(!existsSync(getMarketingPluginDir(workspace.slug)), '清空订阅后未清理营销 skills')
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

  // ===== 知识库编辑链路（Knowledge Pro，打包环境严格验签下的端到端验证） =====
  const smokeVaultDir = join(root, 'smoke-vault')
  const smokeVault = createKnowledgeVault({ name: 'Smoke Vault', path: smokeVaultDir, type: 'folder', enabled: true })
  assert(hasCapability('knowledge-pro'), '打包环境 knowledge-pro 门禁未通过（验签链路异常）')

  // 新建 → 磁盘应有标准 Markdown
  const created = createNoteFile({ vaultId: smokeVault.id, title: '烟测笔记', content: '第一段 [[关联]]', frontmatter: { tags: ['smoke'] } })
  const createdRaw = readFileSync(created.absolutePath, 'utf-8')
  assert(createdRaw.includes('# 烟测笔记'), '新建笔记缺少一级标题')
  assert(createdRaw.includes('tags: [smoke]'), 'frontmatter 数组未正确序列化')

  // 编辑 → 内容更新且标题保留
  updateNoteFile({ vaultId: smokeVault.id, relativePath: created.relativePath, content: '更新后的正文' })
  const afterEdit = readNoteFile(smokeVault.id, created.relativePath)
  assert(afterEdit !== null && afterEdit.parsed.content.includes('更新后的正文'), '编辑后正文未更新')

  // 并发编辑防护 → 主进程按内容版本拒绝覆盖外部修改（Obsidian 场景）
  const versionBefore = noteFileVersion(smokeVault.id, created.relativePath)
  assert(versionBefore !== null, '未能读取笔记版本')
  writeFileSync(created.absolutePath, '# 烟测笔记\n\n外部编辑器写入\n', 'utf-8')
  let conflictBlocked = false
  try {
    updateNoteFile({
      vaultId: smokeVault.id,
      relativePath: created.relativePath,
      content: '静默覆盖',
      expectedVersion: versionBefore!,
    })
  } catch { conflictBlocked = true }
  assert(conflictBlocked, '外部修改后仍允许保存，冲突检测未生效')
  assert(
    readFileSync(created.absolutePath, 'utf-8').includes('外部编辑器写入'),
    '冲突拒绝后磁盘内容被覆盖',
  )

  // 重命名 → 旧文件消失、新文件带新标题
  const renamed = renameNoteFile({ vaultId: smokeVault.id, relativePath: created.relativePath, newTitle: '改名笔记' })
  assert(!existsSync(created.absolutePath), '重命名后旧文件仍存在')
  assert(existsSync(join(smokeVaultDir, renamed.relativePath)), '重命名后新文件缺失')

  // 索引两次 → 稳定 id（同一文件两次索引 id 必须一致，否则「打开→索引→保存」会失败）
  await indexKnowledgeVault(smokeVault.id)
  const firstIndex = listKnowledgeNotes(smokeVault.id).find(n => n.title === '改名笔记')
  assert(firstIndex, '索引后未找到笔记')
  await indexKnowledgeVault(smokeVault.id)
  const secondIndex = listKnowledgeNotes(smokeVault.id).find(n => n.title === '改名笔记')
  assert(secondIndex && secondIndex.id === firstIndex!.id, '笔记 id 在两次索引间不稳定')

  // 删除 → 文件消失（放在门禁撤销前，删除本身也是写操作）
  deleteNoteFile(smokeVault.id, renamed.relativePath)
  assert(!existsSync(join(smokeVaultDir, renamed.relativePath)), '删除后文件仍存在')

  // 门禁：撤销权益后写操作必须被拒绝，且磁盘文件不被触碰
  rmSync(join(root, 'subscription'), { recursive: true, force: true })
  assert(!hasCapability('knowledge-pro'), '撤销权益后门禁仍放行')
  let gateBlocked = false
  try { createNoteFile({ vaultId: smokeVault.id, title: '越权笔记' }) } catch { gateBlocked = true }
  assert(gateBlocked, '无权益时新建笔记未被拒绝')

  console.log(JSON.stringify({
    packageSmoke: 'passed',
    version: app.getVersion(),
    tools: tools.length,
    defaultSkills: defaultSkillSlugs.length,
    skillSetToggle: disabledSkills.length,
    kimiCompaction,
    sqlite: 'node:sqlite',
    knowledgeEdit: 'passed',
  }))
}

interface KimiCompactionSmokeResult {
  contextWindow: number
  runtimes: AgentRuntime[]
}

async function runLiveKimiCompactionSmoke(
  workspace: { id: string; slug: string },
  cwd: string,
): Promise<KimiCompactionSmokeResult | false> {
  const channelId = process.env.GRAVITAS_PACKAGE_SMOKE_KIMI_CHANNEL_ID
  if (!channelId) return false

  const [channelManager, sessionManager, auditService, piAdapterModule, promaAdapterModule] = await Promise.all([
    import('./channel-manager'),
    import('./agent-session-manager'),
    import('./context-compaction-audit-service'),
    import('./adapters/pi-agent-adapter'),
    import('./adapters/provider-agnostic-agent-adapter'),
  ])
  const channel = channelManager.getChannelById(channelId)
  assert(channel, '真实 Kimi 烟测渠道不存在')
  assert.equal(channel.provider, 'kimi-coding', '真实压缩烟测只允许 Kimi Coding 渠道')
  const model = process.env.GRAVITAS_PACKAGE_SMOKE_KIMI_MODEL
    ?? channel.models.find(candidate => candidate.enabled)?.id
    ?? channel.models[0]?.id
  assert(model, 'Kimi Coding 渠道没有可用模型')
  const capability = resolveModelContextCapability({ provider: 'kimi-coding', modelId: model })
  assert.equal(capability.contextWindow, 256_000, `P3 只验收 Kimi 256K 模型，当前 ${model}=${capability.contextWindow}`)

  const source = '这是用于验证 Kimi 自动压缩的合成长会话，不包含用户数据。'.repeat(60)
  const apiKey = channelManager.decryptApiKey(channel.id)
  const runtimes: AgentRuntime[] = ['pi', 'proma']
  for (const runtime of runtimes) {
    const session = sessionManager.createAgentSession(
      `Package Smoke Kimi Compaction ${runtime}`,
      channel.id,
      workspace.id,
      model,
      runtime,
    )
    sessionManager.updateAgentSessionMeta(session.id, {
      lastContextUsage: { contextTokens: 231_871, modelId: model, recordedAt: Date.now() },
    })
    const historyMessages: SDKMessage[] = Array.from({ length: 22 }, (_, index) => ({
      type: index % 2 === 0 ? 'user' : 'assistant',
      message: { content: [{ type: 'text', text: `${source} #${index}` }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage))
    sessionManager.appendSDKMessages(session.id, historyMessages)
    const adapter = runtime === 'pi'
      ? new piAdapterModule.PiAgentAdapter()
      : new promaAdapterModule.ProviderAgnosticAgentAdapter()
    const messages: SDKMessage[] = []
    const lifecycle: string[] = []
    try {
      for await (const message of adapter.query({
        sessionId: session.id,
        prompt: '请只回复 OK 两个字母，不要解释。',
        agentRuntime: runtime,
        provider: 'kimi-coding',
        apiKey,
        baseUrl: channel.baseUrl,
        model,
        cwd,
        historyMessages,
        permissionMode: 'safe',
        workspaceSlug: workspace.slug,
        onAgentEvent: (event) => {
          if (event.type === 'compaction_status') lifecycle.push(event.status)
        },
      })) {
        messages.push(message)
      }
    } finally {
      adapter.dispose()
    }
    assert.deepEqual(lifecycle.slice(0, 2), ['started', 'succeeded'], `${runtime} 压缩生命周期没有闭合`)
    const compactedHistory = sessionManager.getAgentSessionSDKMessages(session.id)
    assert.equal(compactedHistory[0]?.type, 'system', `${runtime} 压缩历史缺少边界消息`)
    assert.equal((compactedHistory[0] as { subtype?: string }).subtype, 'compact_boundary', `${runtime} 压缩边界类型错误`)
    assert(messages.some(message => message.type === 'assistant'), `${runtime} 压缩后没有继续完成当前回合`)
  }

  const metrics = await auditService.getContextCompactionMetrics()
  assert.equal(metrics.total, 2, 'Pi 与 Proma 应各产生一条上下文压缩审计')
  assert.deepEqual(metrics.byRuntime, [{ key: 'pi', count: 1 }, { key: 'proma', count: 1 }], '双 runtime 压缩审计不完整')
  assert.deepEqual(metrics.byTrigger, [{ key: 'automatic', count: 2 }], '双 runtime 自动触发审计不完整')
  return { contextWindow: capability.contextWindow, runtimes }
}
