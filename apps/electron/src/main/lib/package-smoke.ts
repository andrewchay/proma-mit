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
import { getAgentWorkspacePath, getNewMediaSkillsDir, seedNewMediaSkills } from './config-paths'
import { newMediaPluginRuntime } from './plugins/new-media-plugin'
import {
  closeNewMediaDb,
  getNewMediaRecord,
  getNewMediaSchemaInfo,
  initNewMediaDb,
  putNewMediaRecord,
} from './new-media/new-media-sqlite-store'
import { createContentDraft } from './new-media/content-operations'
import { buildXiaohongshuHandoffPackage, confirmXiaohongshuPublished, prepareXiaohongshuHandoff } from './new-media/xiaohongshu-handoff'
import { listNewMediaAudit } from './new-media/new-media-audit'
import {
  loadNewMediaAccountSecret,
  removeNewMediaAccountSecret,
  saveNewMediaAccountSecret,
} from './new-media/new-media-account-secret-store'

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

  const newMedia = await runNewMediaSmoke()

  console.log(JSON.stringify({
    packageSmoke: 'passed',
    newMedia,
    version: app.getVersion(),
    tools: tools.length,
    defaultSkills: defaultSkillSlugs.length,
    skillSetToggle: disabledSkills.length,
    kimiCompaction,
    sqlite: 'node:sqlite',
    knowledgeEdit: 'passed',
  }))
}

/**
 * 新媒体资源、DB 迁移、凭据隔离、审计脱敏与能力停用的打包验收。
 * 只使用临时配置目录，不产生任何外部平台副作用。
 */
async function runNewMediaSmoke(): Promise<Record<string, unknown>> {
  assert(existsSync(join(process.resourcesPath, 'new-media-skills/nm-content-operator/SKILL.md')), 'new-media-skills 打包缺失')
  seedNewMediaSkills()
  const skillsDir = getNewMediaSkillsDir()
  const bundledSkills = readdirSync(join(process.resourcesPath, 'new-media-skills'))
  assert(bundledSkills.length >= 6, '新媒体 Skill 数量不足')
  assert(bundledSkills.every(slug => existsSync(join(skillsDir, slug, 'SKILL.md'))), '新媒体 Skill 未同步到配置目录')

  await initNewMediaDb()
  const info = await getNewMediaSchemaInfo()
  assert.equal(info.version, info.currentVersion, '新媒体数据库未迁移到最新版本')
  assert(info.unknownKinds.length === 0, `存在未登记的记录类型: ${info.unknownKinds.join(',')}`)
  assert(info.appliedMigrations.length > 0, '缺少迁移记录')

  const draft = await createContentDraft('烟测内容：新品体验分享', ['xiaohongshu'])
  const handoff = await prepareXiaohongshuHandoff(draft.id)
  assert.equal(handoff.status, 'draft_ready', '交接不应直接标记为已发布')
  const pkg = await buildXiaohongshuHandoffPackage(handoff.id)
  assert(pkg.length > 0, '交付包为空')
  await confirmXiaohongshuPublished(handoff.id, 'package-smoke')
  const audit = await listNewMediaAudit()
  assert(audit.length > 0, '缺少统一审计记录')
  assert(audit.every(entry => entry.domain && entry.event && entry.ordinal > 0), '审计信封字段不完整')

  // 凭据只进独立 Secret Store，不得出现在业务数据库或审计里。
  saveNewMediaAccountSecret('package-smoke-ref', { accessToken: 'smoke-secret-value', scopes: ['draft'] })
  const loaded = loadNewMediaAccountSecret('package-smoke-ref')
  assert.equal(loaded?.accessToken, 'smoke-secret-value', '凭据无法读回')
  assert(!JSON.stringify(audit).includes('smoke-secret-value'), '审计出现敏感凭据')

  // DB 重开：记录在进程内关闭并重新初始化后仍然存在。
  closeNewMediaDb()
  await initNewMediaDb()
  assert((await getNewMediaRecord('xiaohongshu-handoff', handoff.id)) !== undefined, '新媒体数据库重开后丢失记录')
  await putNewMediaRecord('content-draft', { id: 'package-smoke-draft', sourceText: '重开验证' })
  removeNewMediaAccountSecret('package-smoke-ref')
  assert(loadNewMediaAccountSecret('package-smoke-ref') === undefined, '凭据未删除')
  closeNewMediaDb()

  // 能力停用：不注入工具与 Skill。
  const runtime = newMediaPluginRuntime()
  updateSettings({ newMediaCapabilities: [] })
  assert(!runtime.isEnabled(), '未订阅能力时插件仍启用')
  updateSettings({ newMediaCapabilities: ['content-operations'] })
  assert(runtime.isEnabled(), '订阅能力后插件未启用')
  assert(runtime.contributeSkills?.().map(item => item.slug).join(',') === 'nm-content-operator', 'Skill 未按能力精确分发')
  assert(runtime.contributeTools?.().every(tool => !tool.name.includes('engagement')), '未订阅的能力注入了工具')
  updateSettings({ newMediaCapabilities: [] })
  assert(runtime.contributeSkills?.().length === 0, '停用能力后仍分发 Skill')

  return { schemaVersion: info.version, migrations: info.appliedMigrations.length, skills: bundledSkills.length, audits: audit.length }
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
