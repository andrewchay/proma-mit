import { randomUUID } from 'node:crypto'
import { appendNewMediaAudit, createNewMediaAuditEntry } from './new-media-audit'
import { clearNewMediaRecordsForTests, getNewMediaRecord, listNewMediaRecords, putNewMediaRecord } from './new-media-sqlite-store'

export type NewMediaPlatform = 'xiaohongshu' | 'wechat-official-account'
export type PublicationStatus = 'draft' | 'scheduled' | 'pending_approval' | 'published' | 'failed'

export interface NewMediaContentDraft {
  id: string
  sourceText: string
  platformCopies: Partial<Record<NewMediaPlatform, { title: string; body: string; hashtags: string[] }>>
  createdAt: number
}

export interface PublicationJob {
  id: string
  draftId: string
  platform: NewMediaPlatform
  accountId: string
  scheduledAt: number
  status: PublicationStatus
  approvalRequired: true
  createdAt: number
}

const DRAFT_KIND = 'content-draft'
const JOB_KIND = 'publication-job'

function normalizeHashtags(text: string): string[] {
  return [...new Set((text.match(/#[^#\s，。！!？?]{1,20}/g) ?? []).map((tag) => tag.trim()))].slice(0, 10)
}

function createPlatformCopy(sourceText: string, platform: NewMediaPlatform): { title: string; body: string; hashtags: string[] } {
  const compact = sourceText.trim().replace(/\s+/g, ' ')
  const titleLimit = platform === 'xiaohongshu' ? 20 : 64
  const title = compact.slice(0, titleLimit) || '待补充标题'
  const suffix = platform === 'xiaohongshu'
    ? '\n\n请结合真实体验补充细节，并在发布前核验商品、价格与功效表述。'
    : '\n\n发布前请补充导读、封面和原文链接，并完成内容审核。'
  return { title, body: `${compact}${suffix}`, hashtags: normalizeHashtags(compact) }
}

export async function createContentDraft(sourceText: string, platforms: NewMediaPlatform[]): Promise<NewMediaContentDraft> {
  if (!sourceText.trim()) throw new Error('内容不能为空')
  if (platforms.length === 0) throw new Error('至少选择一个发布平台')
  if (platforms.some((platform) => platform !== 'xiaohongshu' && platform !== 'wechat-official-account')) throw new Error('不支持的发布平台')
  const uniquePlatforms = [...new Set(platforms)]
  const draft: NewMediaContentDraft = {
    id: randomUUID(), sourceText: sourceText.trim(),
    platformCopies: Object.fromEntries(uniquePlatforms.map((platform) => [platform, createPlatformCopy(sourceText, platform)])),
    createdAt: Date.now(),
  }
  return putNewMediaRecord(DRAFT_KIND, draft)
}

export async function listContentDrafts(): Promise<NewMediaContentDraft[]> {
  return listNewMediaRecords(DRAFT_KIND)
}

export async function schedulePublication(input: { draftId: string; platform: NewMediaPlatform; accountId: string; scheduledAt: number }): Promise<PublicationJob> {
  if (!await getNewMediaRecord<NewMediaContentDraft>(DRAFT_KIND, input.draftId)) throw new Error('内容草稿不存在')
  if (input.platform !== 'xiaohongshu' && input.platform !== 'wechat-official-account') throw new Error('不支持的发布平台')
  if (!input.accountId.trim()) throw new Error('账号标识不能为空')
  if (!Number.isFinite(input.scheduledAt) || input.scheduledAt <= Date.now()) throw new Error('发布时间必须在未来')
  const job: PublicationJob = {
    id: randomUUID(), draftId: input.draftId, platform: input.platform, accountId: input.accountId.trim(),
    scheduledAt: input.scheduledAt, status: 'pending_approval', approvalRequired: true, createdAt: Date.now(),
  }
  // 排程属于状态迁移：与任务记录在同一事务写入审计。
  await appendNewMediaAudit(
    await createNewMediaAuditEntry({
      domain: 'publication',
      event: 'publication_scheduled',
      actor: 'local-user',
      subjectId: job.id,
      detail: '已创建发布排程；仍需人工审批，且当前实现不会连接真实平台。',
      metadata: { platform: job.platform, draftId: job.draftId, accountId: job.accountId, status: job.status },
    }),
    [{ kind: JOB_KIND, value: job }],
  )
  return job
}

export async function listPublicationJobs(): Promise<PublicationJob[]> {
  return listNewMediaRecords(JOB_KIND)
}

export async function getPublicationJob(jobId: string): Promise<PublicationJob | undefined> {
  return getNewMediaRecord(JOB_KIND, jobId)
}

export async function resetContentOperationsForTests(): Promise<void> {
  await clearNewMediaRecordsForTests()
}
