import { randomUUID } from 'node:crypto'
import type { NewMediaContentDraft, WechatDraftArticle, WechatDraftRecord } from '@gravitas/shared'
import { getNewMediaRecord, listNewMediaRecords, putNewMediaRecord } from './new-media-sqlite-store'
import { getNewMediaAccount } from './new-media-account-service'
import { getDirectorPlan } from './director-workflow'
import { getLatestDirectorDesign, readDirectorDesign } from './director-design'
import { withDirectorDraftLock } from './director-draft-lock'
import { isWechatAccountRevoking, withWechatAccountLock } from './wechat-account-lock'
import { ensureWechatMedia, precheckWechatMedia } from './adapters/wechat-direct-media-service'
import { createWechatDraft, precheckWechatDraftArticles, WechatDraftPreflightError } from './adapters/wechat-direct-draft-service'

interface SyncAttempt {
  id: string
  draftId: string
  accountId: string
  assetId: string
  status: 'uploading' | 'creating' | 'upload_failed' | 'not_created' | 'synced'
  remoteDraftId?: string
  resolutionCount?: number
  lastResolvedAt?: number
  createdAt: number
  updatedAt: number
}

class SyncRevokedBeforeRequest extends WechatDraftPreflightError {}

interface SyncDependencies {
  upload?: typeof ensureWechatMedia
  createDraft?: typeof createWechatDraft
}

function toWechatHtml(text: string): string {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
  return escaped.split(/\n{2,}/).map(paragraph => `<p>${paragraph.replaceAll('\n', '<br/>')}</p>`).join('')
}

/** 由用户确认预览后显式同步；网络结果不明时保留开始记录，不自动重试。 */
export async function syncDirectorWechatDraft(input: { draftId: string; accountId: string; assetId: string }, dependencies: SyncDependencies = {}): Promise<WechatDraftRecord> {
  return withWechatAccountLock(input.accountId, () => withDirectorDraftLock(input.draftId, async () => {
    const draft = await getNewMediaRecord<NewMediaContentDraft>('content-draft', input.draftId)
    const copy = draft?.platformCopies['wechat-official-account']
    if (!draft?.directorPlanId || !copy) throw new Error('草稿不属于公众号总监方案')
    const plan = await getDirectorPlan(draft.directorPlanId)
    if (plan.status !== 'confirmed' || plan.channel !== 'wechat-official-account') throw new Error('请先确认公众号方案')
    if (isWechatAccountRevoking(input.accountId)) throw new Error('账号正在断开，不能同步草稿')
    const account = await getNewMediaAccount(input.accountId)
    if (!account || account.platform !== 'wechat-official-account' || account.status !== 'connected' || !account.credentialRef || account.credentialProtection !== 'encrypted') throw new Error('请先安全连接公众号账号')
    if (!account.wechatDirect?.ipWhitelistConfigured) throw new Error('请先配置公众号出口 IP 白名单')
    const asset = await getLatestDirectorDesign(input.draftId)
    if (!asset || asset.id !== input.assetId) throw new Error('封面已变化或不存在，请刷新后重新检查')
    const design = await readDirectorDesign(asset.id)
    const mediaCheck = precheckWechatMedia({ fileName: 'cover.png', bytes: design.png, type: 'image', mode: 'permanent' })
    if (!mediaCheck.ok) throw new Error(`封面不符合素材要求：${mediaCheck.problems.join('；')}`)
    const article: WechatDraftArticle = { title: copy.title, content: toWechatHtml(copy.body), thumbMediaId: 'pending' }
    const draftCheck = precheckWechatDraftArticles([article])
    if (!draftCheck.ok) throw new Error(`草稿预检未通过：${draftCheck.problems.join('；')}`)
    const previous = (await listNewMediaRecords<SyncAttempt>('wechat-director-sync')).find(item => item.draftId === draft.id && item.accountId === account.id)
    if (previous?.status === 'creating') throw new Error('上次同步结果未确认，请先到公众号草稿箱核对，避免重复创建')
    if (previous?.status === 'synced') {
      if (previous.assetId !== asset.id) throw new Error('同步封面与当前预览不一致，请新建草稿')
      const record = previous.remoteDraftId ? await getNewMediaRecord<WechatDraftRecord>('wechat-draft', previous.remoteDraftId) : undefined
      if (!record) throw new Error('同步记录不完整，请先到公众号草稿箱核对')
      return record
    }
    const now = Date.now()
    const attempt: SyncAttempt = { id: previous?.id ?? randomUUID(), draftId: draft.id, accountId: account.id, assetId: asset.id, status: 'uploading', createdAt: previous?.createdAt ?? now, updatedAt: now, resolutionCount: previous?.resolutionCount, lastResolvedAt: previous?.lastResolvedAt }
    await putNewMediaRecord('wechat-director-sync', attempt)
    let mediaId: string
    try {
      const uploaded = await (dependencies.upload ?? ensureWechatMedia)({ credentialRef: account.credentialRef, accountId: account.id, fileName: 'cover.png', bytes: design.png, type: 'image', mode: 'permanent', dependencies: { beforeRequest: () => { if (isWechatAccountRevoking(account.id)) throw new SyncRevokedBeforeRequest() } } })
      if (!uploaded.asset.currentMediaId) throw new Error('封面上传未返回素材 ID，请到公众号后台核对')
      if (isWechatAccountRevoking(account.id)) throw new Error('账号正在断开，未提交草稿')
      mediaId = uploaded.asset.currentMediaId
    } catch {
      await putNewMediaRecord('wechat-director-sync', { ...attempt, status: 'upload_failed', updatedAt: Date.now() })
      throw new Error('封面上传未完成，尚未提交公众号草稿；请核对账号权限及素材后重试。')
    }
    await putNewMediaRecord('wechat-director-sync', { ...attempt, status: 'creating', updatedAt: Date.now() })
    let record: WechatDraftRecord
    try {
      const beforeRequest = (): void => { if (isWechatAccountRevoking(account.id)) throw new SyncRevokedBeforeRequest() }
      beforeRequest()
      record = await (dependencies.createDraft ?? createWechatDraft)({ credentialRef: account.credentialRef, accountId: account.id }, { localDraftId: draft.id, articles: [{ ...article, thumbMediaId: mediaId }] }, { beforeRequest })
    } catch (error) {
      if (error instanceof SyncRevokedBeforeRequest) {
        await putNewMediaRecord('wechat-director-sync', { ...attempt, status: 'not_created', updatedAt: Date.now() })
        throw new Error('账号正在断开，未提交公众号草稿。')
      }
      throw new Error('草稿提交结果未确认，请先到公众号草稿箱核对，避免重复创建。')
    }
    await putNewMediaRecord('wechat-director-sync', { ...attempt, status: 'synced', remoteDraftId: record.id, updatedAt: Date.now() })
    return record
  }))
}

/** 状态只反映本地记录；creating 不推断平台是否创建。 */
export async function getWechatDirectorSyncStatus(draftId: string, accountId: string): Promise<SyncAttempt['status'] | null> {
  const attempt = (await listNewMediaRecords<SyncAttempt>('wechat-director-sync')).find(item => item.draftId === draftId && item.accountId === accountId)
  return attempt?.status ?? null
}

/** 用户在微信后台独立核对后，明确记录未创建并允许再次提交。 */
export async function confirmWechatDraftNotCreated(draftId: string, accountId: string): Promise<void> {
  await withWechatAccountLock(accountId, () => withDirectorDraftLock(draftId, async () => {
    const attempt = (await listNewMediaRecords<SyncAttempt>('wechat-director-sync')).find(item => item.draftId === draftId && item.accountId === accountId)
    if (!attempt || attempt.status !== 'creating') throw new Error('当前没有需要核对的同步请求')
    const now = Date.now()
    await putNewMediaRecord('wechat-director-sync', { ...attempt, status: 'not_created', resolutionCount: (attempt.resolutionCount ?? 0) + 1, lastResolvedAt: now, updatedAt: now })
  }))
}
