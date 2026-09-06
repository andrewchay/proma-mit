import { openNativeSqlite } from './native-sqlite'
/** 离线安装包验收：仅在显式烟测模式和新建临时配置目录内运行。 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getConfigDir, getPluginToolsDir, seedDefaultTools, seedBundledWorkflowTemplates } from './config-paths'
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
  seedDefaultTools()
  seedBundledWorkflowTemplates()
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
  console.log(JSON.stringify({ packageSmoke: 'passed', version: app.getVersion(), tools: tools.length, sqlite: 'node:sqlite' }))
}
