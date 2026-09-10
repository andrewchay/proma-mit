/**
 * Campaign 数据层集成测试（批次 2 移植自 ma-proma + upstream 扩展）
 *
 * 自动验证：
 * 1. Campaign CRUD（创建、列表、获取、持久化更新）
 * 2. KOL 候选池导入与查询
 * 3. Brief 携带 JTBD 结构化字段落库并回读（jobSpec/forcesMap COALESCE 保留语义）
 * 4. 归档 / 回收站（软删除）/ 恢复 / 彻底删除
 * 5. 构建过程记录（BuildLog：创建事件 + 手动追加）
 * 6. content_audits 五维评分列迁移（奥格威框架）
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database as BunDatabase } from 'bun:sqlite'
import { buildElectronMock } from '../testing/electron-mock'
import type {
  Campaign,
  CampaignBrief,
  CampaignBuildLog,
  CampaignKOLPoolItem,
  CreateCampaignInput,
  ImportKOLsToPoolInput,
  KOLSearchResult,
  SaveCampaignBriefInput,
} from '@gravitas/shared'

mock.module('electron', () => buildElectronMock())

const TEST_DIR = join(tmpdir(), `proma-mit-campaign-test-${Date.now()}`)

interface CampaignManagerModule {
  closeCampaignDatabase: () => void
  listCampaigns: (options?: { includeArchived?: boolean }) => Campaign[]
  listTrashedCampaigns: () => Campaign[]
  createCampaign: (input: CreateCampaignInput) => Campaign
  getCampaignById: (id: string) => Campaign | null
  updateCampaign: (
    id: string,
    input: Partial<Pick<Campaign, 'phasePlans' | 'creativePlan'>>
  ) => Campaign | null
  setCampaignArchived: (id: string, archived: boolean) => Campaign | null
  deleteCampaign: (id: string) => boolean
  restoreCampaign: (id: string) => Campaign | null
  purgeCampaign: (id: string) => boolean
  addCampaignBuildLog: (input: import('@gravitas/shared').AddCampaignBuildLogInput) => CampaignBuildLog
  listCampaignBuildLogs: (campaignId: string) => CampaignBuildLog[]
  getPoolKOLs: (campaignId: string) => CampaignKOLPoolItem[]
  importKOLsToPool: (input: ImportKOLsToPoolInput) => { imported: number }
  listAvailableKOLs: (filters?: { limit?: number }) => KOLSearchResult
  getBrief: (campaignId: string, kolId: string) => CampaignBrief | null
  saveBrief: (input: SaveCampaignBriefInput) => CampaignBrief
  listAllKOLs: () => unknown[]
}

let campaignManager: CampaignManagerModule

beforeAll(async () => {
  mkdirSync(TEST_DIR, { recursive: true })
  // campaign-manager 的 DB 路径走 _MAPRO_TEST_CONFIG_DIR，
  // agent workspace 等配置路径走 upstream config-paths 的 PROMA_TEST_CONFIG_DIR。
  process.env._MAPRO_TEST_CONFIG_DIR = TEST_DIR
  process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR
  campaignManager = await import('../campaign-manager') as CampaignManagerModule
})

afterAll(() => {
  campaignManager.closeCampaignDatabase()
  const dbPath = join(TEST_DIR, 'campaign-database.sqlite')
  if (existsSync(dbPath)) unlinkSync(dbPath)
  const kolDbPath = join(TEST_DIR, 'kol-database.sqlite')
  if (existsSync(kolDbPath)) unlinkSync(kolDbPath)
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('Campaign 数据层集成测试', () => {
  let testCampaignId: string

  it('Slice 1: 创建 Campaign', () => {
    const input: CreateCampaignInput = {
      name: 'VONBON 小红书 20万',
      brand: 'VONBON 甄果',
      platform: 'xiaohongshu',
      budget: 200000,
      durationMonths: 3,
      targetCity: ['上海', '杭州'],
      targetAudience: '25-35岁沪杭都市女性，追求品质生活',
    }

    const campaign = campaignManager.createCampaign(input)

    expect(campaign.id).toBeDefined()
    expect(campaign.name).toBe(input.name)
    expect(campaign.currentPhase).toBe(1)
    expect(campaign.phasePlans).toHaveLength(3)
    expect(campaign.phasePlans[0]?.budget).toBeGreaterThan(0)
    expect(campaign.creativePlan.bigIdea).toContain(input.brand)
    expect(campaign.status).toBe('draft')
    expect(campaign.archived).toBe(false)
    expect(campaign.deletedAt).toBeUndefined()

    testCampaignId = campaign.id
  })

  it('Slice 1: 列表包含新 Campaign', () => {
    const list = campaignManager.listCampaigns()
    expect(list.length).toBeGreaterThan(0)
    const found = list.find((c) => c.id === testCampaignId)
    expect(found).toBeDefined()
    expect(found!.name).toBe('VONBON 小红书 20万')
  })

  it('Slice 2: 获取单个 Campaign', () => {
    const campaign = campaignManager.getCampaignById(testCampaignId)
    expect(campaign).toBeDefined()
    expect(campaign!.id).toBe(testCampaignId)
  })

  it('Slice 2: 可持久化更新阶段预算', () => {
    const campaign = campaignManager.getCampaignById(testCampaignId)
    expect(campaign).toBeDefined()

    const nextPhasePlans = campaign!.phasePlans.map((phase) =>
      phase.phase === 1 ? { ...phase, budget: 50000 } : phase,
    )
    const updated = campaignManager.updateCampaign(testCampaignId, { phasePlans: nextPhasePlans })

    expect(updated?.phasePlans.find((phase) => phase.phase === 1)?.budget).toBe(50000)
    expect(campaignManager.getCampaignById(testCampaignId)?.phasePlans.find((phase) => phase.phase === 1)?.budget).toBe(50000)
  })

  it('Slice 2: 可持久化更新创意策略', () => {
    const campaign = campaignManager.getCampaignById(testCampaignId)
    expect(campaign).toBeDefined()

    const updated = campaignManager.updateCampaign(testCampaignId, {
      creativePlan: {
        ...campaign!.creativePlan,
        bigIdea: '夏日轻盈通勤',
        tone: '清爽、可信、都市感',
      },
    })

    expect(updated?.creativePlan.bigIdea).toBe('夏日轻盈通勤')
    expect(campaignManager.getCampaignById(testCampaignId)?.creativePlan.tone).toBe('清爽、可信、都市感')
  })

  it('Slice 3: 候选池初始为空', () => {
    const pool = campaignManager.getPoolKOLs(testCampaignId)
    expect(pool).toEqual([])
  })

  it('Slice 3: 导入 KOL（gracious 处理空 DB）', () => {
    const result = campaignManager.importKOLsToPool({
      campaignId: testCampaignId,
      kolIds: ['mock_小红书_美妆达人小美'],
    })

    expect(typeof result.imported).toBe('number')
    // 如果 KOL DB 无数据，imported 为 0，不应抛错
    expect(result.imported).toBeGreaterThanOrEqual(0)
  })

  it('Slice 3: 获取可用 KOL 列表', () => {
    const result = campaignManager.listAvailableKOLs({ limit: 10 })
    expect(Array.isArray(result.kols)).toBe(true)
    expect(typeof result.total).toBe('number')
  })

  it('Slice 4: Brief 携带 JTBD 结构化字段落库并回读', () => {
    const jobSpec = JSON.stringify({
      functional: '快速获得新鲜即食的水果甜点',
      emotional: '缓解疲惫与自责感',
      social: '呈现精致自律的生活态度',
      competing_solutions: ['奶茶', '蛋糕', '代餐奶昔'],
      anxieties: ['担心糖分', '担心不新鲜'],
      tradeoffs: '愿意为新鲜支付溢价，不愿牺牲便捷',
    })
    const forcesMap = JSON.stringify({
      push: '放大"想吃甜又怕负担"的场景痛点',
      pull: '突出"下班路上顺手犒赏"的憧憬',
      inertia: '强调和点奶茶一样方便',
      anxiety: '用冷链溯源与明码标价消解担忧',
    })

    const saved = campaignManager.saveBrief({
      campaignId: testCampaignId,
      kolId: 'mock_小红书_美妆达人小美',
      kolName: '美妆达人小美',
      content: '# 测试 Brief\nJTBD 任务陈述与四力分析。',
      jobSpec,
      forcesMap,
      aiGenerated: true,
    })

    expect(saved.jobSpec).toBe(jobSpec)
    expect(saved.forcesMap).toBe(forcesMap)

    const fetched = campaignManager.getBrief(testCampaignId, 'mock_小红书_美妆达人小美')
    expect(fetched).not.toBeNull()
    expect(fetched!.jobSpec).toBe(jobSpec)
    expect(fetched!.forcesMap).toBe(forcesMap)
    expect(JSON.parse(fetched!.jobSpec!).competing_solutions).toContain('奶茶')
  })

  it('Slice 4: 更新 Brief 时不传 JTBD 字段则保留原值', () => {
    const before = campaignManager.getBrief(testCampaignId, 'mock_小红书_美妆达人小美')
    expect(before).not.toBeNull()

    const updated = campaignManager.saveBrief({
      campaignId: testCampaignId,
      kolId: 'mock_小红书_美妆达人小美',
      kolName: '美妆达人小美',
      content: '# 更新后的 Brief 内容',
    })

    expect(updated.content).toBe('# 更新后的 Brief 内容')
    expect(updated.jobSpec).toBe(before!.jobSpec)
    expect(updated.forcesMap).toBe(before!.forcesMap)
  })

  it('构建史: 创建 Campaign 自动写入 campaign_created 构建记录', () => {
    const logs = campaignManager.listCampaignBuildLogs(testCampaignId)
    const created = logs.find((log) => log.kind === 'campaign_created')
    expect(created).toBeDefined()
    expect(created!.actor).toBe('user')
    expect(created!.title).toContain('VONBON 小红书 20万')
    expect(created!.meta?.brand).toBe('VONBON 甄果')
  })

  it('构建史: 可追加自定义记录并按时间正序返回', () => {
    campaignManager.addCampaignBuildLog({
      campaignId: testCampaignId,
      kind: 'user_request',
      actor: 'agent',
      step: 'market_analysis',
      title: '用户补充预算信息',
      content: '预算从 20 万上调至 25 万',
      sessionId: 'session-abc',
    })

    const logs = campaignManager.listCampaignBuildLogs(testCampaignId)
    expect(logs.length).toBeGreaterThanOrEqual(2)
    expect(logs[logs.length - 1]!.kind).toBe('user_request')
    expect(logs[logs.length - 1]!.sessionId).toBe('session-abc')
    // 按时间正序：campaign_created 在最前
    expect(logs[0]!.kind).toBe('campaign_created')
  })

  it('归档: 归档后默认列表不含，includeArchived 可见，取消归档恢复', () => {
    const archived = campaignManager.setCampaignArchived(testCampaignId, true)
    expect(archived?.archived).toBe(true)
    expect(campaignManager.listCampaigns().some((c) => c.id === testCampaignId)).toBe(false)
    expect(campaignManager.listCampaigns({ includeArchived: true }).some((c) => c.id === testCampaignId)).toBe(true)

    const restored = campaignManager.setCampaignArchived(testCampaignId, false)
    expect(restored?.archived).toBe(false)
    expect(campaignManager.listCampaigns().some((c) => c.id === testCampaignId)).toBe(true)
  })

  it('回收站: 软删除后进回收站，可恢复', () => {
    expect(campaignManager.deleteCampaign(testCampaignId)).toBe(true)
    expect(campaignManager.listCampaigns().some((c) => c.id === testCampaignId)).toBe(false)
    expect(campaignManager.getCampaignById(testCampaignId)?.deletedAt).toBeDefined()
    expect(campaignManager.listTrashedCampaigns().some((c) => c.id === testCampaignId)).toBe(true)

    const restored = campaignManager.restoreCampaign(testCampaignId)
    expect(restored?.deletedAt).toBeUndefined()
    expect(campaignManager.listCampaigns().some((c) => c.id === testCampaignId)).toBe(true)
  })

  it('回收站: 已软删除的记录不可二次软删除', () => {
    expect(campaignManager.deleteCampaign(testCampaignId)).toBe(true)
    expect(campaignManager.deleteCampaign(testCampaignId)).toBe(false)
    // 清理：恢复供后续 purge 用例使用
    campaignManager.restoreCampaign(testCampaignId)
  })

  it('彻底删除: purge 后记录与构建史全部清除', () => {
    expect(campaignManager.purgeCampaign(testCampaignId)).toBe(true)
    expect(campaignManager.getCampaignById(testCampaignId)).toBeNull()
    expect(campaignManager.listCampaigns().some((c) => c.id === testCampaignId)).toBe(false)
    expect(campaignManager.listCampaignBuildLogs(testCampaignId)).toEqual([])
  })

  it('五维审核: content_audits 表包含奥格威五维评分列', async () => {
    // content_audits 由 kol-data-service 的初始化建表（campaign-manager.getKolDb 只建 kols 系列）；
    // 动态 import 保证 electron mock 先注册，调用其 DB 入口触发初始化后再校验 schema。
    const kolDataService = await import('../marketing/ma-tools/kol-data-service') as {
      getKOLStats: () => unknown
    }
    kolDataService.getKOLStats()

    const kolDb = new BunDatabase(join(TEST_DIR, 'kol-database.sqlite'))
    try {
      const columns = (kolDb.query('PRAGMA table_info(content_audits)').all() as Array<{ name: string }>)
        .map((col) => col.name)
      expect(columns).toContain('brand_image_score')
      expect(columns).toContain('data_verifiability_score')
      expect(columns).toContain('overall_score')
    } finally {
      kolDb.close()
    }
  })
})
