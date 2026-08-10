/**
 * 营销领域包服务层 — Marketing Service
 *
 * 薄封装 marketing-sqlite-store，为 IPC handler 提供统一入口。
 * M0 骨架：订阅就绪 + 各子域 CRUD 透传。
 */
import {
  initMarketingDb,
  listCreativeProjects,
  createCreativeProject,
  listCreativeAssets,
  createCreativeAsset,
  deleteCreativeAsset,
  listInfluencerTalents,
  getInfluencerTalent,
  createInfluencerTalent,
  updateInfluencerTalent,
  deleteInfluencerTalent,
  listInfluencerBriefs,
  createInfluencerBrief,
  listInfluencerDrafts,
  getInfluencerDraft,
  createInfluencerDraft,
  updateInfluencerDraft,
  deleteInfluencerDraft,
  listPaidCampaigns,
  getPaidCampaign,
  createPaidCampaign,
  updatePaidCampaign,
  deletePaidCampaign,
  listPaidControlActions,
  createPaidControlAction,
  listPaidRules,
  createPaidRule,
  updatePaidRule,
} from './marketing-sqlite-store'

/** 确保营销数据库就绪（首次调用时惰性初始化） */
export async function ensureMarketingReady(): Promise<void> {
  await initMarketingDb()
}

export const marketingService = {
  // 共享素材
  listCreativeProjects,
  createCreativeProject,
  listCreativeAssets,
  createCreativeAsset,
  deleteCreativeAsset,

  // 达人 influencer
  listInfluencerTalents,
  getInfluencerTalent,
  createInfluencerTalent,
  updateInfluencerTalent,
  deleteInfluencerTalent,
  listInfluencerBriefs,
  createInfluencerBrief,
  listInfluencerDrafts,
  getInfluencerDraft,
  createInfluencerDraft,
  updateInfluencerDraft,
  deleteInfluencerDraft,

  // 广告投放 paid-media
  listPaidCampaigns,
  getPaidCampaign,
  createPaidCampaign,
  updatePaidCampaign,
  deletePaidCampaign,
  listPaidControlActions,
  createPaidControlAction,
  listPaidRules,
  createPaidRule,
  updatePaidRule,
} as const

export default marketingService
