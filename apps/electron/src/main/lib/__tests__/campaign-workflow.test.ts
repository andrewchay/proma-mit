/**
 * Campaign 工作流测试
 *
 * 测试工作流状态管理：
 * 1. 工作流初始化（目录/todo/history 生成）
 * 2. 产物校验（5 层：目录→文件→非空→字数→语义锚点）
 * 3. 完成步骤（completeStepWithValidation）
 * 4. outputSummary 提取
 * 5. history.md / todo.md 同步
 * 6. Campaign Agent 工具
 * 7. 重置工作流
 *
 * 每个测试用独立步骤 ID，避免文件系统污染。
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import { existsSync, readFileSync, readdirSync, unlinkSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildElectronMock } from '../testing/electron-mock'

// ===== 前置 mock =====

const TEST_DIR = join(tmpdir(), `proma-mit-workflow-test-${Date.now()}`)

mock.module('electron', () => buildElectronMock())

// ===== 类型 =====

interface WorkflowServiceModule {
  loadCampaignWorkflow: (campaignId: string) => import('@gravitas/shared').CampaignWorkflow
  updateWorkflowStep: (input: import('@gravitas/shared').UpdateWorkflowStepInput) => import('@gravitas/shared').CampaignWorkflow
  resetWorkflow: (campaignId: string) => import('@gravitas/shared').CampaignWorkflow
  validateStepArtifacts: (campaignId: string, stepId: string) => {
    valid: boolean
    files: string[]
    totalChars: number
    missing: string[]
    unmetRequirements: import('@gravitas/shared').ArtifactRequirement[]
  }
  extractOutputSummary: (messages: import('@gravitas/shared').AgentMessage[] | undefined) => string
  extractMessageText: (msg: unknown) => string
  isStepExecutionMessage: (
    userMessage: string | undefined,
    step: { title: string },
    stepIndex: number,
  ) => boolean
  completeStepWithValidation: (
    campaignId: string,
    stepId: string,
    messages: import('@gravitas/shared').AgentMessage[] | undefined,
  ) => { success: boolean; workflow: import('@gravitas/shared').CampaignWorkflow; reason?: string }
  getWorkflowProgress: (campaignId: string) => number
}

interface CampaignManagerModule {
  closeCampaignDatabase: () => void
  createCampaign: (input: import('@gravitas/shared').CreateCampaignInput) => import('@gravitas/shared').Campaign
  getCampaignById: (id: string) => import('@gravitas/shared').Campaign | null
  importKOLsToPool: (input: import('@gravitas/shared').ImportKOLsToPoolInput) => { imported: number }
}

interface CampaignAgentToolModule {
  isCampaignAgentToolCall: (toolName: string) => boolean
  executeCampaignAgentTool: (tc: any) => Promise<any>
}

let workflowService: WorkflowServiceModule
let campaignManager: CampaignManagerModule
let campaignAgentTool: CampaignAgentToolModule

describe('Campaign 工作流测试', () => {
  const testCampaignId = 'test-campaign-001'

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true })
    process.env._MAPRO_TEST_CONFIG_DIR = TEST_DIR
    // upstream config-paths 的测试隔离变量（workspace 路径走这一份）
    process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR

    campaignManager = await import('../campaign-manager') as CampaignManagerModule
    workflowService = await import('../campaign-workflow-service') as WorkflowServiceModule
    campaignAgentTool = await import('../marketing/ma-tools/campaign-agent') as CampaignAgentToolModule
  })

  afterAll(() => {
    campaignManager.closeCampaignDatabase()

    const dbPath = join(TEST_DIR, 'campaign-database.sqlite')
    if (existsSync(dbPath)) unlinkSync(dbPath)
    const kolDbPath = join(TEST_DIR, 'kol-database.sqlite')
    if (existsSync(kolDbPath)) unlinkSync(kolDbPath)

    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${testCampaignId}`)
    if (existsSync(workspaceDir)) rmSync(workspaceDir, { recursive: true })

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  })

  // ===== Slice 1: 工作流初始化 =====

  it('Slice 1: 加载工作流时自动创建目录和 todo.md', () => {
    const workflow = workflowService.loadCampaignWorkflow(testCampaignId)

    expect(workflow.campaignId).toBe(testCampaignId)
    expect(workflow.steps).toHaveLength(15)
    expect(workflow.currentStepIndex).toBe(-1)
    expect(workflow.steps[0]?.id).toBe('market_analysis')
    expect(workflow.steps[0]?.status).toBe('pending')

    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${testCampaignId}`)
    const expectedDirs = [
      'market-analysis', 'competitor-analysis', 'user-analysis',
      'brand-dna', 'brand-fact-check', 'brand-concept', 'goal-setting', 'creative-concept',
      'platform-matrix', 'kol-pyramid', 'kol-search', 'briefs', 'ab-test', 'video-assets', '.context',
    ]
    for (const dir of expectedDirs) {
      expect(existsSync(join(workspaceDir, dir))).toBe(true)
    }

    const todoPath = join(workspaceDir, '.context', 'todo.md')
    expect(existsSync(todoPath)).toBe(true)
    const todoContent = readFileSync(todoPath, 'utf-8')
    expect(todoContent).toContain('Campaign 工作流 Todo')
    expect(todoContent).toContain('⏳ 待完成')
    expect(todoContent).toContain('market-analysis')

    const campaignMdPath = join(workspaceDir, '.context', 'campaign.md')
    expect(existsSync(campaignMdPath)).toBe(true)
    expect(readFileSync(campaignMdPath, 'utf-8')).toContain('Campaign 上下文')
  })

  // ===== Slice 2: 产物校验（5 层） =====

  // 每个测试用独立步骤，避免文件污染。

  it('Slice 2a: 空目录 → valid=false，原因=目录不存在', () => {
    // brand_dna 目录已存在（由 init 创建），但仍是空的
    const result = workflowService.validateStepArtifacts(testCampaignId, 'brand_dna')
    expect(result.valid).toBe(false)
    expect(result.files).toHaveLength(0)
    expect(result.missing.some((m) => m.includes('目录不存在') || m.includes('没有可读产物'))).toBe(true)
  })

  it('Slice 2b: 非文本文件 → valid=false，原因=没有可读产物', () => {
    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${testCampaignId}`)
    const dir = join(workspaceDir, 'brand-concept')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'image.jpg'), 'fake-binary', 'utf-8')

    const result = workflowService.validateStepArtifacts(testCampaignId, 'brand_concept')
    expect(result.valid).toBe(false)
    expect(result.files).toHaveLength(0)
    expect(result.missing.some((m) => m.includes('没有可读产物'))).toBe(true)
  })

  it('Slice 2c: 空文本文件 → valid=false，原因=均为空', () => {
    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${testCampaignId}`)
    const dir = join(workspaceDir, 'platform-matrix')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'platform-matrix.md'), '', 'utf-8')

    const result = workflowService.validateStepArtifacts(testCampaignId, 'platform_matrix')
    expect(result.valid).toBe(false)
    expect(result.files).toHaveLength(0)
    expect(result.missing.some((m) => m.includes('均为空'))).toBe(true)
  })

  it('Slice 2d: 语义锚点已降级为软校验（此用例仍失败因缺硬性必需文件 kol-role-matrix.md）', () => {
    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${testCampaignId}`)
    const dir = join(workspaceDir, 'kol-pyramid')
    mkdirSync(dir, { recursive: true })
    // 400+ 字，但缺少 kol-pyramid 的锚点（金字塔、预算、筛选标准）
    writeFileSync(
      join(dir, 'kol-pyramid.md'),
      '这是一份关于KOL合作的文档。' +
        '我们选择了一些合适的达人进行合作。' +
        '合作内容包括内容创作、直播推广和互动活动。' +
        '达人分为不同层级，包括头部和腰部。' +
        '我们希望达成良好的营销效果。' +
        '每个达人都有自己的特色和受众群体。'.repeat(8),
      'utf-8',
    )

    const result = workflowService.validateStepArtifacts(testCampaignId, 'kol_pyramid')
    // 语义锚点已降级为软校验：缺失不再判定失败；此处 valid=false 是因为缺少硬性必需文件 kol-role-matrix.md
    expect(result.valid).toBe(false)
    expect(result.missing.some((m) => m.includes('语义锚点'))).toBe(false)
    expect(result.missing.some((m) => m.includes('kol-role-matrix.md'))).toBe(true)
    expect(result.unmetRequirements.length).toBeGreaterThan(0)
  })

  it('Slice 2d1: 缺少必需产物文件 → valid=false', () => {
    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${testCampaignId}`)
    const dir = join(workspaceDir, 'user-analysis')
    mkdirSync(dir, { recursive: true })
    // 只写 ta-portrait.md，不写 search-habits.md
    writeFileSync(
      join(dir, 'ta-portrait.md'),
      '人口统计、兴趣偏好、痛点需求、搜索习惯等内容的用户分析文档。'.repeat(20),
      'utf-8',
    )

    const result = workflowService.validateStepArtifacts(testCampaignId, 'user_analysis')
    expect(result.valid).toBe(false)
    expect(result.missing.some((m) => m.includes('search-habits.md'))).toBe(true)
  })

  it('Slice 2e: 合格内容（字数够、覆盖所有锚点）→ valid=true', () => {
    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${testCampaignId}`)
    const dir = join(workspaceDir, 'kol-search')
    mkdirSync(dir, { recursive: true })

    // 使用 add_to_pool 步骤（min=100，锚点：导入记录、KOL ID、导入结果）
    const content = [
      '# KOL 导入记录',
      '',
      '## 导入时间',
      '2024-06-15',
      '',
      '## KOL ID 列表',
      '- kol_001: 头部达人，小红书粉丝 50W',
      '- kol_002: 腰部达人，抖音粉丝 20W',
      '- kol_003: 尾部达人，小红书粉丝 5W',
      '',
      '## 导入结果',
      '成功导入 3 位达人，状态更新为 candidate。',
      '已跳过重复达人 0 位。',
      '当前候选池总计 3 位达人。',
    ].join('\n')

    writeFileSync(join(dir, 'pool-import-log.md'), content, 'utf-8')

    const result = workflowService.validateStepArtifacts(testCampaignId, 'add_to_pool')
    expect(result.valid).toBe(true)
    expect(result.files).toContain('pool-import-log.md')
    expect(result.totalChars).toBeGreaterThan(100)
    expect(result.missing).toHaveLength(0)
    expect(result.unmetRequirements).toHaveLength(0)
  })

  // ===== Slice 3: 完成步骤（completeStepWithValidation） =====

  it('Slice 3a: 产物为空 → 标记 failed', () => {
    workflowService.updateWorkflowStep({
      campaignId: testCampaignId,
      stepId: 'generate_briefs',
      status: 'in_progress',
    })

    const result = workflowService.completeStepWithValidation(
      testCampaignId,
      'generate_briefs',
      [],
    )

    expect(result.success).toBe(false)
    expect(result.workflow.steps.find((s) => s.id === 'generate_briefs')?.status).toBe('failed')
    expect(result.reason).toBeDefined()
  })

  it('Slice 3b: 有合格产物 → 标记 completed + outputSummary', () => {
    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${testCampaignId}`)
    const dir = join(workspaceDir, 'ab-test')
    mkdirSync(dir, { recursive: true })

    // ab_test 步骤：锚点=测试变量、分组方案、指标、样本量、数据复盘、调优方案、放量决策
    const planContent = [
      '# A/B 测试方案',
      '',
      '## 测试变量',
      '本次 A/B 测试的核心变量是标题文案。',
      '我们准备了两组不同的标题进行对照：',
      'A 组（对照组）使用品牌原有的标准标题，保持现有风格不变；',
      'B 组（测试组）使用情感向、场景化的标题文案，突出用户体验。',
      '通过对比两组标题在相同投放条件下的表现差异，',
      '评估情感化标题是否能显著提升用户的点击意愿和互动参与度。',
      '测试变量严格控制在标题文案这一个维度，其他投放条件保持一致。',
      '',
      '## 分组方案',
      '将目标受众随机分为两个实验组，每组各分配 50% 的曝光流量。',
      'A 组为对照组，保持现有标题不变；B 组为测试组，使用优化后的情感标题。',
      '为确保结果有效性，两组受众的年龄、性别、地域分布保持一致。',
      '测试周期设定为 7 天，覆盖工作日和周末，避免时间偏差对结果的影响。',
      '每天定时检查两组数据，确保流量分配均匀，无异常波动。',
      '',
      '## 指标',
      '主要指标为点击率（CTR），即广告曝光后的点击比例。',
      '次要指标包括转化率（从点击到购买的比例）、',
      '停留时长（用户在落地页的平均停留时间）、',
      '以及互动率（点赞、评论、分享的比例）。',
      '若 B 组的 CTR 相对 A 组提升超过 15%，',
      '且统计显著性 p<0.05，则判定测试有效并建议全量推广。',
      '',
      '## 样本量',
      '根据统计学原理，设定显著性水平 α=0.05，检验功效 β=0.2。',
      '通过样本量计算公式，每组需要至少 5000 次有效曝光才能达到统计显著性。',
      '预计总曝光量为 200 万次，远超最低样本要求，确保结果具有高度可信度。',
      '测试将在 7 天内完成，每日监控数据变化趋势，及时调整投放策略。',
      '',
      '## 止损线',
      '若前 3 天 CTR 差异 < 1% 或 CPE > 15 元，暂停该组测试并分析原因。',
    ].join('\n')

    const reviewContent = [
      '# 阶段复盘框架',
      '',
      '## 数据回收清单',
      '回收字段：曝光、浏览、点赞、收藏、评论、转发、CPM、CPE、CTR、互动率。',
      '数据源：小红书/抖音平台后台、内容追踪系统、投流数据。',
      '',
      '## 分析维度',
      '- 达人层级：头部 / 腰部 / KOC 各层级表现',
      '- 平台：小红书 vs 抖音',
      '- 内容风格：场景种草 / 产品测评 / 真实体验',
      '- 发布时段：工作日 vs 周末',
      '',
      '## 核心发现模板',
      '- 最佳组合：互动率最高、CPE 最低的组合',
      '- 表现不佳元素：CTR 低或评论区负面率高的组合',
      '- 异常值说明：单个达人异常表现及可能原因',
      '',
      '## 目标达成判定',
      '对比测试计划中的通过阈值，判定 CTR、CPE、互动率是否达成。',
      '测试结束后将调用 ma-phase-reviewer 生成阶段复盘报告。',
    ].join('\n')

    const scaleUpContent = [
      '# 调优与放量方案',
      '',
      '## 调优规则',
      '- 若腰部达人 + 场景种草组合 CPE 最低，则正式投放提高该组合占比 20%',
      '- 若小红书 CTR 显著高于抖音，则小红书预算占比提升至 60%',
      '- 砍掉测试中 CTR < 1% 或 CPE > 15 元的达人/内容组合',
      '',
      '## 放量决策标准',
      'Go / No-go 门槛：',
      '- Go：CPE < 5 元、互动率 > 5%、ROI > 1:3、统计显著 p<0.05',
      '- No-go：CPE > 10 元、互动率 < 2%、ROI < 1:2 或未达显著性',
      '',
      '## 正式投放方案',
      '放量预算：剩余 80% 预算。达人组合：腰部 50%、KOC 40%、头部 10%。',
      '平台分配：小红书 60%、抖音 40%。时间线：第 1 周集中发布，第 2-3 周长尾维护。',
      '',
      '## 风险预案',
      '- 效果稀释：预留 10% 预算作为二次测试',
      '- 达人档期：提前锁定核心达人档期',
      '- 内容同质化：控制同风格内容占比不超过 60%',
    ].join('\n')

    writeFileSync(join(dir, 'ab-test-plan.md'), planContent, 'utf-8')
    writeFileSync(join(dir, 'ab-test-review.md'), reviewContent, 'utf-8')
    writeFileSync(join(dir, 'scale-up-plan.md'), scaleUpContent, 'utf-8')

    workflowService.updateWorkflowStep({
      campaignId: testCampaignId,
      stepId: 'ab_test',
      status: 'in_progress',
    })

    const mockMessages: import('@gravitas/shared').AgentMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'A/B 测试方案设计完成！变量为标题文案，分组为 A/B 两组，样本量各 5000。',
        createdAt: Date.now(),
      },
    ]

    const result = workflowService.completeStepWithValidation(
      testCampaignId,
      'ab_test',
      mockMessages,
    )

    expect(result.success).toBe(true)
    const step = result.workflow.steps.find((s) => s.id === 'ab_test')
    expect(step?.status).toBe('completed')
    expect(step?.outputSummary).toBe('A/B 测试方案设计完成！变量为标题文案，分组为 A/B 两组，样本量各 5000。')
    expect(step?.completedAt).toBeDefined()
  })

  it('Slice 3c: Agent 只输出正文但未写文件 → 自动落盘后完成', () => {
    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${testCampaignId}`)
    const dir = join(workspaceDir, 'brand-dna')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })

    workflowService.updateWorkflowStep({
      campaignId: testCampaignId,
      stepId: 'brand_dna',
      status: 'in_progress',
    })

    const content = [
      '品牌历史：品牌创立于 2018 年，从社区水果店起步，发展至今已有六年历程，传承每日鲜果理念。',
      '产品服务：核心产品线包括鲜切水果盒、季节果篮，功能卖点为当日鲜切、冷链配送，价格带 29-99 元。',
      '品牌阶段：当前品牌处于成长期，已完成从单店到连锁的阶段定位，正向品牌化阶段过渡。',
      '产品现状：产品力稳定，供应链诊断显示冷链成熟，价格带 29-99 元，SKU 约 30 个，产品诊断良好。',
      '核心问题：当前首要解决的是认知问题，目标用户对品牌心智不足，定义为本阶段核心问题。',
      '核心目标：基于成长期阶段和认知问题，首要目标是曝光和破圈拉新，目标优先级为声量优先。',
      '差异化优势：我们的差异化在于鲜切即食加场景化套餐，核心竞争力是供应链稳定，与竞品最核心的差异在场景绑定。',
    ].join('\n')

    const result = workflowService.completeStepWithValidation(
      testCampaignId,
      'brand_dna',
      [{ id: 'msg-brand', role: 'assistant', content, createdAt: Date.now() }],
    )

    expect(result.success).toBe(true)
    expect(existsSync(join(dir, 'agent-output.md'))).toBe(true)
    expect(result.workflow.steps.find((s) => s.id === 'brand_dna')?.status).toBe('completed')
  })

  // ===== Slice 4: outputSummary 提取 =====

  it('Slice 4a: 从消息提取内容', () => {
    const messages: import('@gravitas/shared').AgentMessage[] = [
      { id: '1', role: 'user', content: 'hello', createdAt: 1 },
      { id: '2', role: 'assistant', content: 'This is the summary output', createdAt: 2 },
    ]
    expect(workflowService.extractOutputSummary(messages)).toBe('This is the summary output')
  })

  it('Slice 4b: 空/undefined 消息返回默认', () => {
    expect(workflowService.extractOutputSummary(undefined)).toBe('执行完成，未获取输出摘要')
    expect(workflowService.extractOutputSummary([])).toBe('执行完成，未获取输出摘要')
  })

  // ===== Slice 5: 历史记录 =====

  it('Slice 5: history.md 已创建并记录执行历史', () => {
    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${testCampaignId}`)
    const historyPath = join(workspaceDir, '.context', 'history.md')

    expect(existsSync(historyPath)).toBe(true)
    const content = readFileSync(historyPath, 'utf-8')
    expect(content).toContain('Campaign 执行历史')
    // 前面 Slice 3a/b 的 failed + completed 记录应该已经被写入
    expect(content.length).toBeGreaterThan(50)
  })

  // ===== Slice 6: todo.md 同步 =====

  it('Slice 6: todo.md 随工作流更新同步', () => {
    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${testCampaignId}`)
    const todoContent = readFileSync(join(workspaceDir, '.context', 'todo.md'), 'utf-8')

    // ab_test 已标记 completed，应该出现在已完成区块
    expect(todoContent).toContain('## ✅ 已完成')
    expect(todoContent).toContain('步骤 9')
    expect(todoContent).toContain('[x]')

    // generate_briefs 标记 failed，应该出现在待完成区块
    expect(todoContent).toContain('⏳ 待完成')
  })

  // ===== Slice 7: 进度计算 =====

  it('Slice 7: 进度计算正确', () => {
    const progress = workflowService.getWorkflowProgress(testCampaignId)
    // 15 步中：ab_test completed, add_to_pool completed (校验时写文件), generate_briefs failed
    // 其余 pending
    expect(progress).toBeGreaterThanOrEqual(0)
    expect(progress).toBeLessThanOrEqual(100)
  })

  // ===== Slice 8: Campaign Agent 工具 =====

  it('Slice 8: ma_campaign_kol_add 是 Campaign Agent 工具', () => {
    expect(campaignAgentTool.isCampaignAgentToolCall('ma_campaign_kol_add')).toBe(true)
    expect(campaignAgentTool.isCampaignAgentToolCall('ma_campaign_kol_status')).toBe(true)
    expect(campaignAgentTool.isCampaignAgentToolCall('unknown_tool')).toBe(false)
  })

  it('Slice 8b: 旧版 9 步工作流迁移时按步骤 ID 保留当前步骤', () => {
    const legacyCampaignId = 'legacy-campaign-001'
    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${legacyCampaignId}`)
    mkdirSync(workspaceDir, { recursive: true })

    const legacySteps: import('@gravitas/shared').CampaignWorkflowStep[] = [
      'brand_dna',
      'brand_concept',
      'creative_concept',
      'platform_matrix',
      'kol_pyramid',
      'search_kols',
      'add_to_pool',
      'generate_briefs',
      'ab_test',
    ].map((id, index) => ({
      id: id as import('@gravitas/shared').CampaignWorkflowStepId,
      title: `旧步骤 ${index + 1}`,
      description: '旧版工作流步骤',
      status: id === 'kol_pyramid' ? 'in_progress' : index < 4 ? 'completed' : 'pending',
      agentPrompt: '旧版提示词',
      toolName: 'legacy-tool',
    }))

    const legacyWorkflow: import('@gravitas/shared').CampaignWorkflow = {
      campaignId: legacyCampaignId,
      currentStepIndex: 4,
      steps: legacySteps,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    writeFileSync(join(workspaceDir, 'campaign-workflow.json'), JSON.stringify(legacyWorkflow, null, 2), 'utf-8')

    const migrated = workflowService.loadCampaignWorkflow(legacyCampaignId)

    expect(migrated.steps).toHaveLength(15)
    expect(migrated.steps[migrated.currentStepIndex]?.id).toBe('kol_pyramid')
    expect(migrated.steps.find((step) => step.id === 'market_analysis')?.status).toBe('pending')

    rmSync(workspaceDir, { recursive: true, force: true })
  })

  // ===== Slice 9: 重置工作流 =====

  it('Slice 9: 重置工作流恢复初始状态', () => {
    const workflow = workflowService.resetWorkflow(testCampaignId)

    expect(workflow.steps).toHaveLength(15)
    for (const step of workflow.steps) {
      expect(step.status).toBe('pending')
      expect(step.completedAt).toBeUndefined()
      expect(step.outputSummary).toBeUndefined()
    }
    expect(workflow.currentStepIndex).toBe(-1)
  })

  // ===== Slice 10: 工作流文件损坏恢复（原子写回归） =====

  it('Slice 10: 工作流文件损坏时备份 .corrupt 文件并重建默认工作流', () => {
    const corruptCampaignId = 'test-campaign-corrupt'
    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${corruptCampaignId}`)
    mkdirSync(workspaceDir, { recursive: true })

    // 模拟崩溃导致的截断文件
    writeFileSync(join(workspaceDir, 'campaign-workflow.json'), '{"campaignId":"x","steps":[', 'utf-8')

    const workflow = workflowService.loadCampaignWorkflow(corruptCampaignId)

    // 重建为默认工作流而不是抛错
    expect(workflow.campaignId).toBe(corruptCampaignId)
    expect(workflow.steps).toHaveLength(15)
    expect(workflow.steps[0]?.status).toBe('pending')

    // 损坏原件被保留为 .corrupt-{ts} 备份，不会被静默覆盖
    const corruptBackups = readdirSync(workspaceDir).filter((f) => f.startsWith('campaign-workflow.json.corrupt-'))
    expect(corruptBackups.length).toBe(1)

    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('Slice 10: 二次保存后保留 .bak 备份（原子写）', () => {
    const atomicCampaignId = 'test-campaign-atomic'

    // 首次 load 会创建并保存默认工作流
    workflowService.loadCampaignWorkflow(atomicCampaignId)
    // 第二次写入触发 .bak 备份
    workflowService.resetWorkflow(atomicCampaignId)

    const workspaceDir = join(TEST_DIR, 'agent-workspaces', `campaign-${atomicCampaignId}`)
    expect(existsSync(join(workspaceDir, 'campaign-workflow.json.bak'))).toBe(true)

    rmSync(workspaceDir, { recursive: true, force: true })
  })

  // ===== Slice 11: 消息格式兼容与步骤触发校验（自动闭环回归） =====

  it('Slice 11: extractOutputSummary 兼容 SDKMessage 格式（Phase 4 后 JSONL 实际格式）', () => {
    const sdkMessages = [
      { type: 'user', message: { content: [{ type: 'text', text: '## 步骤 1: 市场分析' }] } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '推理中' },
            { type: 'text', text: '市场规模 100 亿，趋势向好' },
          ],
        },
      },
    ] as unknown as import('@gravitas/shared').AgentMessage[]

    expect(workflowService.extractOutputSummary(sdkMessages)).toBe('市场规模 100 亿，趋势向好')
  })

  it('Slice 11: extractOutputSummary 兼容旧 AgentMessage 格式', () => {
    const legacy = [
      { id: '1', role: 'user', content: '问题', createdAt: 1 },
      { id: '2', role: 'assistant', content: '回答', createdAt: 2 },
    ] as import('@gravitas/shared').AgentMessage[]

    expect(workflowService.extractOutputSummary(legacy)).toBe('回答')
  })

  it('Slice 11: isStepExecutionMessage 区分步骤执行与闲聊', () => {
    const step = { title: '市场分析' }
    // 执行提示词（handleExecuteStep 发送的格式）
    expect(workflowService.isStepExecutionMessage('## 步骤 1: 市场分析\n\n请分析品类趋势...', step, 0)).toBe(true)
    // 调整提示词（handleAdjustStep 发送的格式）
    expect(workflowService.isStepExecutionMessage('## 调整 Campaign 工作流步骤：市场分析\n\n补充内容', step, 0)).toBe(true)
    // 闲聊不触发
    expect(workflowService.isStepExecutionMessage('这个 KOL 报价多少', step, 0)).toBe(false)
    // 其他步骤序号不匹配
    expect(workflowService.isStepExecutionMessage('## 步骤 2: 竞品分析', step, 0)).toBe(false)
    // 空消息
    expect(workflowService.isStepExecutionMessage(undefined, step, 0)).toBe(false)
  })
})
