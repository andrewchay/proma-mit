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

describe('阶段复盘报告 · 三分决策', () => {
  let testCampaignId: string

  beforeAll(async () => {
    const campaign = campaignManager.createCampaign({
      name: '复盘决策测试 Campaign',
      brand: 'VONBON 甄果',
      platform: 'xiaohongshu',
      budget: 50000,
      durationMonths: 1,
      targetCity: ['上海'],
      targetAudience: '测试人群',
    })
    testCampaignId = campaign.id
  })

  interface PhaseReportModule {
    getPhaseReport: (id: string) => import('@gravitas/shared').CampaignPhaseReport | null
    updatePhaseReport: (
      id: string,
      updates: Partial<Pick<import('@gravitas/shared').CampaignPhaseReport, 'aiDecisions' | 'status'>>
    ) => import('@gravitas/shared').CampaignPhaseReport | null
    deletePhaseReport: (id: string) => boolean
  }
  let phaseModule: PhaseReportModule
  let reportId: string

  const decisions: import('@gravitas/shared').PhaseDecision[] = [
    {
      element: '桌面对决',
      decision: 'keep',
      evidence: '曝光 61,739 全场最高 · CPE ¥3.47 全场最低',
      reason: '场景代入感强，用户愿意停留和讨论',
      nextAction: '下一批主推，人数从 6 扩到 8',
    },
    {
      element: '穿搭撞色',
      decision: 'stop',
      evidence: '曝光 2,380 · CPE ¥3.86 偏高',
      reason: '数据差且投入产出比不合理',
      nextAction: '不再追加',
    },
    {
      element: 'plog 拼图',
      decision: 'start',
      evidence: '互动率 2.74% / 收藏率 0.73% 四项最优，但样本仅 2 人',
      reason: '样本不足不作结论，方向值得小规模再验证',
      nextAction: '下一批分配 4 人小规模验证',
    },
  ]

  beforeAll(async () => {
    phaseModule = (await import('../campaign-manager')) as unknown as PhaseReportModule
  })

  it('Slice A: 人工写入的三分决策总表可落库并回读', () => {
    // 直接经 updatePhaseReport 写入（generatePhaseReport 的 LLM 产出同列存储）
    const db = campaignManager as unknown as { getDb: () => { run: (sql: string, ...v: unknown[]) => void } }
    // 用 INSERT 造一条最小报告行，避免依赖 LLM
    db.getDb().run(
      `INSERT INTO campaign_phase_reports (id, campaign_id, phase, report_type, start_date, end_date, status, generated_by, created_at, updated_at)
       VALUES (?, ?, 1, 'phase', '2026-07-01', '2026-07-31', 'generated', 'manual', ?, ?)`,
      'report_test_decision', testCampaignId, Date.now(), Date.now()
    )
    reportId = 'report_test_decision'

    const updated = phaseModule.updatePhaseReport(reportId, { aiDecisions: decisions })
    expect(updated).not.toBeNull()
    expect(updated!.aiDecisions).toHaveLength(3)
  })

  it('Slice B: 回读报告时三分决策结构完整', () => {
    const report = phaseModule.getPhaseReport(reportId)
    expect(report).not.toBeNull()
    expect(report!.aiDecisions).toEqual(decisions)
    expect(report!.aiDecisions[0]!.decision).toBe('keep')
    expect(report!.aiDecisions[1]!.decision).toBe('stop')
    expect(report!.aiDecisions[2]!.decision).toBe('start')
    expect(report!.aiDecisions[0]!.evidence).toContain('CPE ¥3.47')
  })

  it('Slice C: 无决策的旧报告回读 aiDecisions 为空数组', () => {
    phaseModule.updatePhaseReport(reportId, { aiDecisions: [] })
    const report = phaseModule.getPhaseReport(reportId)
    expect(report!.aiDecisions).toEqual([])
  })

  afterAll(() => {
    phaseModule.deletePhaseReport(reportId)
  })
})

describe('营销全链路（数据层端到端）', () => {
  let e2eCampaignId: string

  it('全链路: 创建 → 导入 KOL → Brief 模板 → 追踪 → 复盘 → 审核兜底', async () => {
    // 1. 创建 Campaign
    const campaign = campaignManager.createCampaign({
      name: '端到端链路测试',
      brand: '忘本果切',
      platform: 'xiaohongshu',
      budget: 100000,
      durationMonths: 2,
      targetCity: ['杭州'],
      targetAudience: '都市白领女性',
    })
    e2eCampaignId = campaign.id
    expect(campaign.id).toBeDefined()

    // 2. 导入 KOL（空库时 imported=0，gracious）
    const imported = await Promise.resolve(campaignManager.importKOLsToPool({
      campaignId: e2eCampaignId,
      kolIds: ['mock_小红书_美食博主阿暖'],
    }))
    expect(imported.imported).toBeGreaterThanOrEqual(0)

    // 3. Brief 模板含 JTBD 与四力分析骨架
    const kol = (await window_electronAPI_getPool(e2eCampaignId))[0]
    if (kol) {
      const template = await Promise.resolve(
        (campaignManager as unknown as { generateBriefTemplate: (c: Campaign, k: typeof kol) => string })
          .generateBriefTemplate(campaign, kol),
      )
      expect(template).toContain('JTBD 任务陈述')
      expect(template).toContain('四力分析')
    }

    // 4. 内容追踪：创建记录并回读
    const trackingModule = campaignManager as unknown as {
      createContentTracking: (input: Record<string, unknown>) => Promise<{ id: string } | null>
      listContentTracking: (campaignId: string) => Promise<unknown[]>
    }
    const tracking = await trackingModule.createContentTracking({
      campaignId: e2eCampaignId,
      kolId: 'mock_小红书_美食博主阿暖',
      kolName: '美食博主阿暖',
      platform: 'xiaohongshu',
      contentUrl: 'https://www.xiaohongshu.com/explore/test',
      contentType: 'organic',
      publishDate: '2026-09-11',
    })
    expect(tracking).not.toBeNull()
    const trackingList = await trackingModule.listContentTracking(e2eCampaignId)
    expect(trackingList.length).toBeGreaterThanOrEqual(1)

    // 5. 复盘报告：人工写入决策 + 定稿（不依赖 LLM）
    const db = campaignManager as unknown as { getDb: () => { run: (sql: string, ...v: unknown[]) => void } }
    db.getDb().run(
      `INSERT INTO campaign_phase_reports (id, campaign_id, phase, report_type, start_date, end_date, status, generated_by, created_at, updated_at)
       VALUES (?, ?, 1, 'phase', '2026-09-01', '2026-09-30', 'generated', 'manual', ?, ?)`,
      'report_e2e_link', e2eCampaignId, Date.now(), Date.now(),
    )
    const updated = await Promise.resolve(
      (campaignManager as unknown as {
        updatePhaseReport: (id: string, updates: Record<string, unknown>) => Promise<unknown> | null
      }).updatePhaseReport('report_e2e_link', {
        aiDecisions: [{ element: '测评形式', decision: 'keep', evidence: 'CPE ¥2.9', reason: '机制通', nextAction: '放大到 8 人' }],
      }),
    )
    expect(updated).not.toBeNull()

    // 6. 内容审核：测试环境无 LLM 渠道，验证优雅降级（落库为 failed 且有报告）
    const audit = await (campaignManager as unknown as {
      createContentAudit: (input: Record<string, unknown>) => Promise<{ auditId: string; auditStatus: string; auditReport: string } | null>
    }).createContentAudit({
      campaignId: e2eCampaignId,
      kolId: 'mock_小红书_美食博主阿暖',
      kolName: '美食博主阿暖',
      brand: '忘本果切',
      product: '鲜切果盒',
      platform: 'xiaohongshu',
      contentType: '图文',
      contentDescription: '实测三天，果切真的很新鲜，酸奶 barbarie 搭配绝了',
    })
    expect(audit).not.toBeNull()
    // 无 LLM 时审核降级为 failed，但记录与报告落库，五维列可读
    expect(audit!.auditStatus).toBe('failed')
    expect(audit!.auditReport).toContain('审核失败')

    // 7. 清理
    expect(campaignManager.purgeCampaign(e2eCampaignId)).toBe(true)
  })

  afterAll(() => {
    // 兜底清理（正常路径已在用例内 purge）
    if (e2eCampaignId) {
      campaignManager.purgeCampaign(e2eCampaignId)
    }
  })
})

/** 辅助：读取候选池（规避顶部 interface 类型收窄） */
async function window_electronAPI_getPool(campaignId: string): Promise<import('@gravitas/shared').CampaignKOLPoolItem[]> {
  return (campaignManager as unknown as {
    getPoolKOLs: (campaignId: string) => import('@gravitas/shared').CampaignKOLPoolItem[]
  }).getPoolKOLs(campaignId)
}
