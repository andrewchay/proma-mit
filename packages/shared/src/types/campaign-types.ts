/**
 * 营销 Campaign / KOL 类型（从 ma-proma 迁移）
 *
 * 供 marketing ma-tools（kol-data-service / content-tracker 等）使用。
 * 来源：ma-proma packages/shared/src/types/campaign.ts
 */

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
