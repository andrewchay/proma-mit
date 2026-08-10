/**
 * Campaign 项目管理系统类型定义
 *
 * KOL 投放 Campaign 的核心数据模型和 IPC 通道常量。
 */

// ===== Campaign 核心实体 =====

/** 投放平台 */
export type CampaignPlatform = 'xiaohongshu' | 'douyin' | 'dual'

/** Campaign 状态 */
export type CampaignStatus =
  | 'draft'
  | 'strategy'
  | 'kol_selection'
  | 'negotiation'
  | 'content_production'
  | 'live'
  | 'review'
  | 'completed'

/** Campaign 阶段计划 */
export interface CampaignPhasePlan {
  /** 阶段序号 */
  phase: number
  /** 阶段名称 */
  name: string
  /** 阶段月份范围 */
  months: string
  /** 阶段目标 */
  goal: string
  /** 阶段预算（元） */
  budget: number
}

/** Campaign 创意策略 */
export interface CampaignCreativePlan {
  /** 核心创意概念 */
  bigIdea: string
  /** 核心传播信息 */
  coreMessage: string
  /** 内容支柱 */
  contentPillars: string[]
  /** 语气与风格 */
  tone: string
  /** 必须包含的元素 */
  mandatoryElements: string[]
  /** 禁止或规避的元素 */
  forbiddenElements: string[]
}

/** Campaign 项目 */
export interface Campaign {
  /** 唯一标识 */
  id: string
  /** 项目名称（如：VONBON 小红书 20万） */
  name: string
  /** 品牌名 */
  brand: string
  /** 用户指定的本地项目文件夹路径（可选，工作流产物存放于此目录的 campaign-{id}/ 下） */
  projectPath?: string
  /** 投放平台 */
  platform: CampaignPlatform
  /** 总预算（元） */
  budget: number
  /** 投放周期（月） */
  durationMonths: number
  /** 目标城市 */
  targetCity: string[]
  /** 目标人群描述 */
  targetAudience: string
  /** 当前阶段（1-3） */
  currentPhase: number
  /** 阶段计划 */
  phasePlans: CampaignPhasePlan[]
  /** 创意策略 */
  creativePlan: CampaignCreativePlan
  /** 状态 */
  status: CampaignStatus
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 创建 Campaign 输入 */
export interface CreateCampaignInput {
  name: string
  brand: string
  platform?: CampaignPlatform
  /** 用户指定的本地项目文件夹路径（可选） */
  projectPath?: string
  budget?: number
  durationMonths?: number
  targetCity?: string[]
  targetAudience?: string
  phasePlans?: CampaignPhasePlan[]
  creativePlan?: CampaignCreativePlan
}

/** 更新 Campaign 输入 */
export interface UpdateCampaignInput {
  name?: string
  brand?: string
  platform?: CampaignPlatform
  budget?: number
  durationMonths?: number
  targetCity?: string[]
  targetAudience?: string
  currentPhase?: number
  phasePlans?: CampaignPhasePlan[]
  creativePlan?: CampaignCreativePlan
  status?: CampaignStatus
}

// ===== KOL 候选池 =====

/** KOL 在候选池中的状态 */
export type PoolKOLStatus = 'candidate' | 'shortlisted' | 'contacted' | 'confirmed' | 'rejected'

/** Campaign KOL 候选池记录 */
export interface CampaignKOLPoolItem {
  /** Campaign ID */
  campaignId: string
  /** KOL ID（来自 KOL 数据库） */
  kolId: string
  /** KOL 名称 */
  name: string
  /** 平台 */
  platform: string
  /** 粉丝量 */
  followers: string
  /** 互动率 */
  engagement: string
  /** 类目 */
  category: string
  /** 报价 */
  price: string
  /** 城市 */
  city: string
  /** 候选池状态 */
  status: PoolKOLStatus
  /** 备注 */
  notes: string
  /** 加入时间 */
  addedAt: number
}

/** 导入 KOL 到候选池输入 */
export interface ImportKOLsToPoolInput {
  campaignId: string
  kolIds: string[]
}

// ===== KOL 扩展数据 =====

/** KOL 扩展数据（达人内容分析维度，用于投放评估） */
export interface KOLExtendedData {
  // 1. 粉丝量与赞藏比
  likes?: number                    // 点赞数
  saves?: number                    // 收藏数
  likesToSavesRatio?: number       // 赞藏比（1:1.5合格，1:10优秀）

  // 2. 粉丝画像
  femaleRatio?: number              // 女粉占比%（70%合格，80%优秀）
  maleRatio?: number                // 男粉占比%

  // 3. 粉丝年龄
  age18to35Ratio?: number          // 18-35岁占比%（40%合格，50%优秀）
  ageDistribution?: string           // 年龄分布描述

  // 5-6. 近3月笔记点赞数据
  minLikes3m?: number               // 近3月最低点赞
  maxLikes3m?: number               // 近3月最高点赞
  avgLikes3m?: number              // 近3月平均点赞

  // 7. 更新频率
  monthlyPostCount?: number          // 月更条数（4合格，8-10优秀）
  postsLast30d?: number            // 近30天发布数

  // 8. 爆文率
  viralRate30d?: number            // 30日爆文率%（5%合格，10%优秀）
  viralNotesCount?: number          // 近30天爆文数

  // 9. 近10篇笔记数据趋势（JSON存储，前端展示图表）
  recentNotesTrend?: Array<{
    date: string
    title: string
    exposure: number
    views: number
    likes: number
    comments: number
    saves: number
    isAd: boolean
  }>

  // 10. 评论词云
  negativeCommentRatio?: number     // 负面评论占比%（<10%合格，0%优秀）
  commentWordCloud?: Array<{ word: string; count: number; sentiment: 'positive' | 'negative' | 'neutral' }>

  // 11-12. 投放成本指标
  cpe?: number                      // 单次互动成本=报价÷点赞（5-10元性价比高，10-20元常态，>20元需谨慎）
  cpm?: number                      // 千次曝光成本=报价÷预估阅读×1000
  estimatedPrice?: number           // 预估报价=粉丝量×10%（元）
  priceReasonableness?: 'high' | 'normal' | 'low' | 'excellent' // 报价合理性

  // 13-14. 商业笔记占比
  adNoteRatio?: number              // 广告笔记占比%（30%合格，10%优秀）
  organicNoteRatio?: number         // 日常笔记占比%（60%合格，70%优秀）
  adNotesLast30d?: number          // 近30天广告笔记数
  totalNotesLast30d?: number         // 近30天总笔记数

  // 15. 近10条广告内容数据
  recentAdNotes?: Array<{
    date: string
    title: string
    exposure: number
    views: number
    completionRate?: number          // 完播率
    likes: number
    comments: number
    saves: number
    shares: number
    commentProductRatio?: number    // 评论词云产品相关占比%
    vsOrganic: {                     // 与日常数据对比
      exposureDiff: number           // 曝光差异
      engagementDiff: number        // 互动差异
    }
  }>

  // 汇总标签（由评分系统计算）
  valueTags?: string[]              // 价值标签，如["高性价比","爆文率高","女粉精准"]
  riskFlags?: string[]              // 风险标签，如["CPE过高","广告占比高","更新不稳定"]
}

// ===== KOL 搜索（用于导入弹窗） =====

/** KOL 记录（简化版，用于列表展示） */
export interface KOLListItem {
  id: string
  name: string
  platform: string
  followers: string
  engagement: string
  category: string
  price: string
  city: string
  avatar: string
  source: string
  rawData: string
  baseScore: number       // 基础数据评分（VONBON §4.1）
  contentScore: number     // 内容质量评分
  commercialScore: number // 商业适配评分
  overallScore: number     // 综合评分

  // 扩展数据：达人内容分析维度（用于投放评估）
  extendedData?: KOLExtendedData
  // 评分细分（用于展示）
  fanScore?: number       // 粉丝质量评分
  engagementScore?: number // 互动质量评分
  valueScore?: number     // 性价比评分（CPE/CPM/报价合理性）
  adQualityScore?: number  // 广告质量评分（广告数据表现）
  riskScore?: number       // 风险评估评分
  // 汇总标签（从 extendedData 提取或独立存储）
  valueTags?: string[]      // 价值标签
  riskFlags?: string[]      // 风险标签
  createdAt: number
  updatedAt: number
}

/** KOL 搜索结果 */
export interface KOLSearchResult {
  kols: KOLListItem[]
  total: number
}

// ===== KOL Brief =====

/** KOL 合作 Brief */
export interface CampaignBrief {
  /** 唯一标识 */
  id: string
  /** Campaign ID */
  campaignId: string
  /** KOL ID */
  kolId: string
  /** KOL 名称 */
  kolName: string
  /** Brief 内容（Markdown） */
  content: string
  /** 是否 AI 生成 */
  aiGenerated: boolean
  /** 状态：draft / final */
  status: 'draft' | 'final'
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 保存 Brief 输入 */
export interface SaveCampaignBriefInput {
  campaignId: string
  kolId: string
  kolName: string
  content: string
  aiGenerated?: boolean
}

// ===== IPC 通道常量 =====

/**
 * Campaign 相关 IPC 通道常量
 */
export const CAMPAIGN_IPC_CHANNELS = {
  /** 获取 Campaign 列表 */
  LIST: 'campaign:list',
  /** 获取单个 Campaign */
  GET: 'campaign:get',
  /** 创建 Campaign */
  CREATE: 'campaign:create',
  /** 更新 Campaign */
  UPDATE: 'campaign:update',
  /** 获取 Campaign 候选池 KOL */
  GET_POOL_KOLS: 'campaign:getPoolKols',
  /** 导入 KOL 到候选池 */
  IMPORT_KOLS: 'campaign:importKols',
  /** 获取 KOL 数据库中可用 KOL（用于导入弹窗） */
  LIST_AVAILABLE_KOLS: 'campaign:listAvailableKols',
  /** 获取 KOL Brief */
  GET_BRIEF: 'campaign:getBrief',
  /** 保存 KOL Brief */
  SAVE_BRIEF: 'campaign:saveBrief',
  /** 推进 Campaign 到下一阶段 */
  ADVANCE_PHASE: 'campaign:advancePhase',
  /** 确保 Campaign Workspace 工具文件存在（旧 Campaign 兼容） */
  ENSURE_WORKSPACE: 'campaign:ensureWorkspace',
  /** 获取 Campaign 工作流 */
  GET_WORKFLOW: 'campaign:getWorkflow',
  /** 更新 Campaign 工作流步骤 */
  UPDATE_WORKFLOW_STEP: 'campaign:updateWorkflowStep',
  /** 重置 Campaign 工作流 */
  RESET_WORKFLOW: 'campaign:resetWorkflow',
} as const

// ===== Campaign 工作流 =====

/** 工作流步骤 ID */
export type CampaignWorkflowStepId =
  | 'market_analysis'
  | 'competitor_analysis'
  | 'user_analysis'
  | 'brand_dna'
  | 'brand_fact_check'
  | 'brand_concept'
  | 'goal_setting'
  | 'creative_concept'
  | 'platform_matrix'
  | 'kol_pyramid'
  | 'search_kols'
  | 'add_to_pool'
  | 'generate_briefs'
  | 'ab_test'
  | 'generate_video_assets'  // 新增：生成视频素材

/** 视频素材类型 */
export type VideoAssetType = 'seedance' | 'minimax-h3' | 'mixed'

/** 视频素材记录 */
export interface CampaignVideoAsset {
  /** 唯一标识 */
  id: string
  /** Campaign ID */
  campaignId: string
  /** 视频名称 */
  name: string
  /** 视频类型 */
  type: VideoAssetType
  /** 投放平台 */
  platform: CampaignPlatform
  /** 时长（秒） */
  duration: number
  /** 分镜脚本 */
  storyboard: string  // JSON string of Storyboard
  /** 视频文件路径 */
  videoPath?: string
  /** 首帧图路径 */
  firstFramePath?: string
  /** 字幕文件路径 */
  subtitlePath?: string
  /** 状态 */
  status: 'pending' | 'generating' | 'completed' | 'failed'
  /** 生成引擎 */
  engine: string
  /** 生成参数 */
  generationParams: string  // JSON string
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 创建视频素材输入 */
export interface CreateVideoAssetInput {
  campaignId: string
  name: string
  platform: CampaignPlatform
  duration: number
  product: string
  sellingPoints: string[]
  targetAudience: string
  style?: string
}

/** 视频素材 IPC 通道 */
export const VIDEO_ASSET_IPC_CHANNELS = {
  LIST: 'videoAsset:list',
  DELETE: 'videoAsset:delete',
  RENAME: 'videoAsset:rename',
} as const

/** 工作流步骤状态 */
export type CampaignWorkflowStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed'

/** 产物校验要求（每步一组） */
export interface ArtifactRequirement {
  /** 语义锚点描述，人类可读 */
  name: string
  /** 可匹配的关键词/短语列表（任一匹配即通过） */
  aliases: string[]
}

/** 单个工作流步骤 */
export interface CampaignWorkflowStep {
  /** 步骤 ID */
  id: CampaignWorkflowStepId
  /** 显示标题 */
  title: string
  /** 描述 */
  description: string
  /** 状态 */
  status: CampaignWorkflowStepStatus
  /** 执行该步骤时向 Agent 发送的提示词 */
  agentPrompt: string
  /** 关联的 Chat Tool 名称 */
  toolName: string
  /** 产物校验要求列表 */
  artifactRequirements?: ArtifactRequirement[]
  /** 产物最低字数阈值（默认 300） */
  minArtifactLength?: number
  /** 必须存在的产物文件名列表（相对于步骤目录） */
  requiredFiles?: string[]
  /** 完成时间（可选） */
  completedAt?: number
  /** 输出结果摘要（可选） */
  outputSummary?: string
  /** 用户备注（可选） */
  notes?: string
}

/** Campaign 工作流定义 */
export interface CampaignWorkflow {
  /** Campaign ID */
  campaignId: string
  /** 当前活跃步骤索引（-1 表示未开始） */
  currentStepIndex: number
  /** 所有步骤 */
  steps: CampaignWorkflowStep[]
  /** 视频素材列表 */
  videoAssets?: CampaignVideoAsset[]
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 更新工作流步骤输入 */
export interface UpdateWorkflowStepInput {
  campaignId: string
  stepId: CampaignWorkflowStepId
  status?: CampaignWorkflowStepStatus
  outputSummary?: string
  notes?: string
}

/** 推进工作流步骤输入 */
export interface AdvanceWorkflowInput {
  campaignId: string
  stepId: CampaignWorkflowStepId
  nextStepId: CampaignWorkflowStepId
}

export interface ContentAudit {
  auditId: string
  campaignId: string
  kolId: string
  kolName: string
  contentUrl: string
  platform: string
  auditStatus: 'pending' | 'reviewing' | 'passed' | 'failed'
  complianceScore: number
  brandAlignmentScore: number
  qualityScore: number
  overallScore: number
  auditReport: string
  auditor: string
  createdAt: number
  updatedAt: number
}

export interface CreateContentAuditInput {
  campaignId: string
  kolId: string
  kolName: string
  brand: string
  product: string
  platform: string
  contentType: string
  contentDescription: string
  contentUrl?: string
}

export const CONTENT_AUDIT_IPC_CHANNELS = {
  LIST: 'contentAudit:list',
  GET: 'contentAudit:get',
  CREATE: 'contentAudit:create',
  UPDATE_STATUS: 'contentAudit:updateStatus',
} as const

// ===== KOL 数据管理 =====

export interface UpdateKOLInput {
  id: string
  name: string
  platform: string
  followers: string
  engagement: string
  category: string
  price: string
  city: string
  // 扩展数据（可选）
  extendedData?: KOLExtendedData
  fanScore?: number
  engagementScore?: number
  valueScore?: number
  adQualityScore?: number
  riskScore?: number
}

export const KOL_DATA_IPC_CHANNELS = {
  LIST_ALL: 'kol:listAll',
  UPDATE: 'kol:update',
  DELETE: 'kol:delete',
  RECALCULATE_SCORES: 'kol:recalculateScores',
} as const

// ===== 内容数据追踪 =====

/** 内容数据追踪 IPC 通道 */
export const CONTENT_TRACKING_IPC_CHANNELS = {
  LIST: 'contentTracking:list',
  GET: 'contentTracking:get',
  CREATE: 'contentTracking:create',
  UPDATE_DATA: 'contentTracking:updateData',
  UPDATE_ANALYSIS: 'contentTracking:updateAnalysis',
  ADD_PAID_DATA: 'contentTracking:addPaidData',
  DELETE: 'contentTracking:delete',
} as const

/** 内容数据追踪记录 */
export interface KOLContentTracking {
  /** 唯一标识 */
  id: string
  /** Campaign ID */
  campaignId: string
  /** KOL ID */
  kolId: string
  /** KOL 名称 */
  kolName: string
  /** 平台 */
  platform: string
  /** 内容链接 */
  contentUrl: string
  /** 内容类型：自然流/付费/混合 */
  contentType: 'organic' | 'paid' | 'mixed'
  /** 发布日期 */
  publishDate: string
  /** 曝光量 */
  exposure: number
  /** 浏览量/小眼睛 */
  views: number
  /** 点赞数 */
  likes: number
  /** 收藏数 */
  saves: number
  /** 评论数 */
  comments: number
  /** 转发数 */
  shares: number
  /** 完播率 */
  completionRate?: number
  /** CPM（千次曝光成本） */
  cpm: number
  /** CPE（单次互动成本） */
  cpe: number
  /** CTR（点击通过率） */
  ctr: number
  /** 互动率 */
  engagementRate: number
  /** 数据来源 */
  dataSource: 'api' | 'manual' | 'screenshot' | 'estimated'
  /** 数据回收时间 */
  collectedAt: number
  /** 性能等级 */
  performanceGrade: 'excellent' | 'good' | 'normal' | 'poor' | 'pending'
  /** 与标准对比（JSON） */
  benchmarkComparison: string
  /** AI 分析结果 */
  aiAnalysis: string
  /** 优化建议 */
  recommendations: string
  /** 投流数据（JSON） */
  paidData: string
  /** 投流花费 */
  paidSpend: number
  /** 投流曝光量 */
  paidExposure: number
  /** 投流浏览量 */
  paidViews: number
  /** 投流点赞数 */
  paidLikes: number
  /** 所属阶段（1/2/3） */
  phase: number
  /** AB 测试分组 */
  testGroup: string
  /** 内容类型（种草/测评/开箱/教程/对比等） */
  noteType: string
  /** 实际花费 */
  cost: number
  /** 是否纯自然流 */
  isOrganic: boolean
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 创建内容追踪记录输入 */
export interface CreateContentTrackingInput {
  campaignId: string
  kolId: string
  kolName: string
  platform: string
  contentUrl: string
  contentType: 'organic' | 'paid' | 'mixed'
  publishDate: string
  exposure: number
  views: number
  likes: number
  saves: number
  comments: number
  shares: number
  completionRate?: number
  dataSource: 'api' | 'manual' | 'screenshot' | 'estimated'
  paidSpend?: number
  phase?: number
  testGroup?: string
  noteType?: string
  cost?: number
  isOrganic?: boolean
}

/** 更新内容追踪数据输入 */
export interface UpdateContentTrackingDataInput {
  id: string
  exposure: number
  views: number
  likes: number
  saves: number
  comments: number
  shares: number
  completionRate?: number
  dataSource: 'api' | 'manual' | 'screenshot' | 'estimated'
}

/** 添加投流数据输入 */
export interface AddPaidDataInput {
  id: string
  paidSpend: number
  paidExposure: number
  paidViews: number
  paidLikes: number
  paidData: string
}

/** 更新分析结果输入 */
export interface UpdateAnalysisInput {
  id: string
  performanceGrade: 'excellent' | 'good' | 'normal' | 'poor' | 'pending'
  benchmarkComparison: string
  aiAnalysis: string
  recommendations: string
}

/** 数据标准基准 */
export interface ContentBenchmark {
  /** 唯一标识 */
  id: string
  /** 平台 */
  platform: string
  /** 价格带 */
  priceTier: 'budget' | 'mid' | 'premium' | 'luxury'
  /** 粉丝范围 */
  followersRange: '1k-10k' | '10k-100k' | '100k-1m' | '1m+'
  /** 指标名称 */
  metricName: 'ctr' | 'engagement_rate' | 'cpm' | 'cpe' | 'exposure_rate'
  /** 优秀阈值 */
  excellentThreshold: number
  /** 良好阈值 */
  goodThreshold: number
  /** 合格阈值 */
  normalThreshold: number
  /** 描述 */
  description: string
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 创建数据标准输入 */
export interface CreateBenchmarkInput {
  platform: string
  priceTier: 'budget' | 'mid' | 'premium' | 'luxury'
  followersRange: '1k-10k' | '10k-100k' | '100k-1m' | '1m+'
  metricName: 'ctr' | 'engagement_rate' | 'cpm' | 'cpe' | 'exposure_rate'
  excellentThreshold: number
  goodThreshold: number
  normalThreshold: number
  description: string
}

// ===== 阶段复盘报告 =====

/** 阶段复盘报告 */
export interface CampaignPhaseReport {
  id: string
  campaignId: string
  phase: number
  reportType: 'phase' | 'weekly' | 'ab_test'
  startDate: string
  endDate: string
  totalKols: number
  totalPosts: number
  totalCost: number
  organicCost: number
  paidCost: number
  totalExposure: number
  totalViews: number
  totalLikes: number
  totalSaves: number
  totalComments: number
  totalShares: number
  avgCpm: number
  avgCpe: number
  avgCtr: number
  avgEngagementRate: number
  roiEstimate: number
  cpmTarget: number
  cpmTargetAchieved: boolean
  engagementTarget: number
  engagementTargetAchieved: boolean
  aiSummary: string
  aiFindings: string[]
  aiRecommendations: string[]
  aiScaleAdvice: string
  status: 'draft' | 'generated' | 'finalized'
  generatedBy: 'ai' | 'manual'
  createdAt: number
  updatedAt: number
}

/** 生成阶段复盘报告输入 */
export interface GeneratePhaseReportInput {
  campaignId: string
  phase: number
  reportType: 'phase' | 'weekly' | 'ab_test'
  startDate: string
  endDate: string
  cpmTarget?: number
  engagementTarget?: number
}

/** 阶段复盘 IPC 通道 */
export const PHASE_REPORT_IPC_CHANNELS = {
  LIST: 'phaseReport:list',
  GET: 'phaseReport:get',
  GENERATE: 'phaseReport:generate',
  UPDATE: 'phaseReport:update',
  DELETE: 'phaseReport:delete',
  FINALIZE: 'phaseReport:finalize',
} as const

// ===== AB 测试 =====

/** AB 测试变量类型 */
export type ABTestVariableType = 'content' | 'kol_tier' | 'platform' | 'timing' | 'creative'

/** Campaign AB 测试 */
export interface CampaignABTest {
  id: string
  campaignId: string
  phase: number
  testName: string
  hypothesis: string
  variableType: ABTestVariableType
  variableDescription: string
  controlGroupDefinition: string
  testGroupDefinition: string
  startDate: string
  endDate: string
  status: 'running' | 'completed' | 'cancelled'
  winnerGroup: string
  winnerReason: string
  scaleRecommendation: string
  createdAt: number
  updatedAt: number
}

/** AB 测试分组结果 */
export interface ABTestResult {
  id: string
  abTestId: string
  groupName: string
  kolCount: number
  postCount: number
  totalCost: number
  totalExposure: number
  totalViews: number
  totalLikes: number
  totalSaves: number
  totalComments: number
  totalShares: number
  avgCpm: number
  avgCpe: number
  avgCtr: number
  avgEngagementRate: number
  conversionCount: number
  conversionRate: number
  significanceScore: number
  isSignificant: boolean
  createdAt: number
  updatedAt: number
}

/** 创建 AB 测试输入 */
export interface CreateABTestInput {
  campaignId: string
  phase: number
  testName: string
  hypothesis: string
  variableType: ABTestVariableType
  variableDescription: string
  controlGroupDefinition: string
  testGroupDefinition: string
  startDate: string
  endDate: string
}

/** 更新 AB 测试分组结果输入 */
export interface UpdateABTestResultInput {
  abTestId: string
  groupName: string
  kolCount: number
  postCount: number
  totalCost: number
  totalExposure: number
  totalViews: number
  totalLikes: number
  totalSaves: number
  totalComments: number
  totalShares: number
  conversionCount: number
  conversionRate: number
}

/** AB 测试 IPC 通道 */
export const AB_TEST_IPC_CHANNELS = {
  LIST: 'abTest:list',
  GET: 'abTest:get',
  CREATE: 'abTest:create',
  UPDATE: 'abTest:update',
  DELETE: 'abTest:delete',
  COMPLETE: 'abTest:complete',
  GET_RESULTS: 'abTest:getResults',
  UPDATE_RESULT: 'abTest:updateResult',
  ANALYZE: 'abTest:analyze',
} as const

