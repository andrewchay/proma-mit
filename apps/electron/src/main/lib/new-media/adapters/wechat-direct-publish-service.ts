/**
 * 微信公众号发布（freepublish）异步状态机。
 *
 * 核心事实：**提交成功不等于发布成功**。
 * `freepublish/submit` 只表示平台受理，真正结果要靠 `freepublish/get` 查询
 * （普通公众号直连没有发布结果回调），因此状态机必须显式经过 publishing。
 *
 * 设计要点：
 * - 提交前先检查同一草稿是否已有未终结的发布记录，避免重复提交产生多篇发布。
 * - publish_id 一经平台返回立即持久化，用于查询与对账。
 * - 平台 publish_status 数值必须经过显式映射；未映射的取值一律归为 unknown，
 *   绝不能当作成功。
 * - 提交结果未知（网络中断等）时禁止再次提交，必须先人工对账。
 */
import { randomUUID } from 'node:crypto'
import type {
  NewMediaPlatform,
  WechatPublishRecord,
  WechatPublishStatus,
  WechatPublishTransition,
} from '@gravitas/shared'
import { PlatformAdapterError } from '../platform-adapter'
import { getNewMediaRecord, listNewMediaRecords, putNewMediaRecord } from '../new-media-sqlite-store'
import { getEffectiveProxyUrl } from '../../proxy-settings-service'
import { getFetchFn } from '../../proxy-fetch'
import { recordWechatObservedScopes } from '../new-media-account-service'
import { getWechatDraft } from './wechat-direct-draft-service'
import { registerControlledActionExecutor, ControlledExecutionError } from '../new-media-controlled-executor'
import { getNewMediaAccount } from '../new-media-account-service'
import { withWechatAccessToken, type WechatTokenDependencies } from './wechat-direct-token-service'

export const WECHAT_PUBLISH_KIND = 'wechat-publish'

const SUBMIT_URL = 'https://api.weixin.qq.com/cgi-bin/freepublish/submit'
const GET_URL = 'https://api.weixin.qq.com/cgi-bin/freepublish/get'

const REQUEST_TIMEOUT_MS = 20_000

/**
 * 平台 publish_status 映射（本地快照，需在真机验收时重新核对）。
 * 未列出的取值一律映射为 unknown —— 不可当作发布成功。
 */
export const WECHAT_PUBLISH_STATUS_MAP = {
  verifiedAt: '2026-09',
  source: '微信公众平台发布能力接口文档（本地快照，需在真机验收时重新核对）',
  byCode: {
    0: { status: 'published', label: '发布成功' },
    1: { status: 'publishing', label: '发布中' },
    2: { status: 'failed', label: '发布失败（原创校验不通过）' },
    3: { status: 'failed', label: '发布失败（常规失败）' },
    4: { status: 'rejected', label: '平台审核不通过' },
    5: { status: 'deleted', label: '发布成功后已删除' },
    6: { status: 'deleted', label: '已删除' },
  } as Record<number, { status: WechatPublishStatus; label: string }>,
} as const

export function mapPlatformPublishStatus(code: number | undefined): { status: WechatPublishStatus; label: string } {
  if (code === undefined) return { status: 'unknown', label: '平台未返回状态' }
  const mapped = WECHAT_PUBLISH_STATUS_MAP.byCode[code]
  return mapped ?? { status: 'unknown', label: `平台返回未映射状态（${code}）` }
}

/** 未终结状态：处于这些状态时不允许对同一草稿重复提交。 */
const ACTIVE_STATUSES: WechatPublishStatus[] = ['submit_requested', 'publishing']

export interface WechatPublishTransportResponse {
  status: number
  text(): Promise<string>
}

export type WechatPublishTransport = (input: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}) => Promise<WechatPublishTransportResponse>

export interface WechatPublishDependencies {
  publishTransport?: WechatPublishTransport
  token?: WechatTokenDependencies
  now?: () => number
}

export interface WechatPublishContext {
  credentialRef: string
  accountId: string
}

export const WECHAT_PUBLISH_ERROR_CODES: Record<number, { code: string; message: string }> = {
  40007: { code: 'invalid_media_id', message: '草稿 media_id 不存在，可能已被删除' },
  48001: { code: 'insufficient_scope', message: '该账号没有发布接口权限' },
  45009: { code: 'temporarily_unavailable', message: '调用频率超限，请稍后重试' },
  '-1': { code: 'temporarily_unavailable', message: '微信侧系统繁忙，稍后重试' },
}

interface PublishPayload {
  publish_id?: string | number
  publish_status?: number
  article_id?: string
  article_detail?: { count?: number; item?: Array<{ idx?: number; article_url?: string }> }
  fail_idx?: number[]
  errcode?: number
  errmsg?: string
}

async function defaultTransport(input: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}): Promise<WechatPublishTransportResponse> {
  const proxyUrl = await getEffectiveProxyUrl()
  const response = await getFetchFn(proxyUrl)(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    signal: input.signal,
  })
  return { status: response.status, text: () => response.text() }
}

async function callPublishApi(input: {
  credentialRef: string
  endpoint: string
  body: Record<string, unknown>
  dependencies: WechatPublishDependencies
}): Promise<PublishPayload> {
  const transport = input.dependencies.publishTransport ?? defaultTransport
  return withWechatAccessToken(input.credentialRef, async (accessToken) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await transport({
        url: `${input.endpoint}?access_token=${encodeURIComponent(accessToken)}`,
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(input.body),
        signal: controller.signal,
      })
      const raw = await response.text()
      let parsed: PublishPayload
      try {
        parsed = JSON.parse(raw) as PublishPayload
      } catch {
        throw new PlatformAdapterError('temporarily_unavailable', `微信返回了无法解析的响应（HTTP ${response.status}）`)
      }
      if (parsed.errcode && parsed.errcode !== 0) {
        const known = WECHAT_PUBLISH_ERROR_CODES[parsed.errcode]
        throw new PlatformAdapterError(
          (known?.code ?? 'temporarily_unavailable') as 'invalid_media_id' | 'insufficient_scope' | 'temporarily_unavailable',
          known ? `${known.message}（errcode=${parsed.errcode}）` : `微信返回未识别错误（errcode=${parsed.errcode}${parsed.errmsg ? `，errmsg=${parsed.errmsg}` : ''}）`,
        )
      }
      return parsed
    } catch (error) {
      if (error instanceof PlatformAdapterError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PlatformAdapterError('temporarily_unavailable', `发布接口调用超时（${REQUEST_TIMEOUT_MS / 1000}s）`)
      }
      throw new PlatformAdapterError('temporarily_unavailable', `发布接口调用失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }, input.dependencies.token ?? {})
}

function transition(from: WechatPublishStatus | null, to: WechatPublishStatus, at: number, note: string, platformStatus?: number): WechatPublishTransition {
  return { from, to, platformStatus, at, note }
}

/**
 * 权限观察是本地记账行为，不能因为缺少账号档案或写库失败而阻断真实发布。
 * 失败只在控制台留下痕迹，发布结果本身不受影响。
 */
async function observeScopesBestEffort(accountId: string, observation: { grantedScopes?: string[]; deniedScopes?: string[] }): Promise<void> {
  try {
    await recordWechatObservedScopes(accountId, observation)
  } catch {
    // 忽略：权限观察失败不影响本次发布的正确性。
  }
}

/** 进程内提交声明表：并发提交同一草稿只有一个能出网。 */
const submitting = new Set<string>()

export function getSubmittingCount(): number {
  return submitting.size
}

export async function findActivePublishForDraft(accountId: string, draftId: string): Promise<WechatPublishRecord | undefined> {
  const records = await listNewMediaRecords<WechatPublishRecord>(WECHAT_PUBLISH_KIND)
  return records.find((record) => record.accountId === accountId && record.draftId === draftId && ACTIVE_STATUSES.includes(record.status))
}

export interface SubmitWechatPublishInput {
  draftId: string
  /** 仅为保持接口一致；真实发布必须由受控动作审批门控触发。 */
  now?: number
}

/**
 * 提交发布。返回的只是「平台已受理」，状态为 publishing 而非 published。
 */
export async function submitWechatPublish(
  context: WechatPublishContext,
  input: SubmitWechatPublishInput,
  dependencies: WechatPublishDependencies = {},
): Promise<WechatPublishRecord> {
  const draft = await getWechatDraft(input.draftId)
  if (!draft) throw new Error('微信草稿不存在')
  if (draft.accountId !== context.accountId) throw new Error('草稿不属于当前账号')
  if (draft.status === 'deleted') throw new Error('草稿已删除，不能发布')
  if (!draft.platformMediaId) throw new Error('草稿尚未同步到微信，无法发布')

  const existing = await findActivePublishForDraft(context.accountId, input.draftId)
  if (existing) return existing

  const unknownSubmit = (await listNewMediaRecords<WechatPublishRecord>(WECHAT_PUBLISH_KIND))
    .find((record) => record.accountId === context.accountId && record.draftId === input.draftId && record.submitOutcomeUnknown)
  if (unknownSubmit) throw new Error('上次提交结果未知，可能已被平台受理；请先对账确认后再决定是否重新提交')

  if (submitting.has(input.draftId)) throw new Error('该草稿正在提交中，请等待结果')
  submitting.add(input.draftId)

  const now = input.now ?? dependencies.now?.() ?? Date.now()
  const recordId = randomUUID()
  // 标记「已经写过一条未知状态记录」，避免 catch 再用更笼统的错误码覆盖具体原因。
  let unknownPersisted = false
  try {
    const payload = await callPublishApi({
      credentialRef: context.credentialRef,
      endpoint: SUBMIT_URL,
      body: { media_id: draft.platformMediaId },
      dependencies,
    })
    const publishId = payload.publish_id === undefined ? undefined : String(payload.publish_id)
    if (!publishId) {
      // 平台没有给出 publish_id：既不能确认受理也不能确认未受理，按结果未知处理。
      const unknown: WechatPublishRecord = {
        id: recordId,
        accountId: context.accountId,
        draftId: input.draftId,
        platformMediaId: draft.platformMediaId,
        status: 'unknown',
        submittedAt: now,
        submitOutcomeUnknown: true,
        failureCode: 'missing_publish_id',
        transitions: [transition(null, 'unknown', now, '平台未返回 publish_id，无法确认是否受理')],
        createdAt: now,
        updatedAt: now,
      }
      await putNewMediaRecord(WECHAT_PUBLISH_KIND, unknown)
      unknownPersisted = true
      await observeScopesBestEffort(context.accountId, { grantedScopes: ['freepublish'] })
      throw new PlatformAdapterError('temporarily_unavailable', '平台未返回 publish_id，无法确认是否受理发布；请先对账')
    }

    // 提交受理即证明发布接口可用，记录权限观察。
    await observeScopesBestEffort(context.accountId, { grantedScopes: ['freepublish'] })

    const record: WechatPublishRecord = {
      id: recordId,
      accountId: context.accountId,
      draftId: input.draftId,
      platformMediaId: draft.platformMediaId,
      publishId,
      // 提交成功只代表受理，必须先经过 publishing。
      status: 'publishing',
      submittedAt: now,
      transitions: [transition(null, 'publishing', now, '平台已受理发布，等待异步结果（提交成功不等于发布成功）')],
      createdAt: now,
      updatedAt: now,
    }
    return putNewMediaRecord(WECHAT_PUBLISH_KIND, record)
  } catch (error) {
    if (error instanceof PlatformAdapterError && error.code === 'insufficient_scope') {
      await observeScopesBestEffort(context.accountId, { deniedScopes: ['freepublish'] })
    }
    // 明确被平台拒绝（有 errcode）属于已确认失败；网络类失败属于结果未知。
    const platformConfirmed = error instanceof PlatformAdapterError && error.code !== 'temporarily_unavailable'
    if (!platformConfirmed && !unknownPersisted) {
      const unknown: WechatPublishRecord = {
        id: recordId,
        accountId: context.accountId,
        draftId: input.draftId,
        platformMediaId: draft.platformMediaId,
        status: 'unknown',
        submittedAt: now,
        submitOutcomeUnknown: true,
        failureCode: error instanceof PlatformAdapterError ? error.code : 'unexpected_error',
        transitions: [transition(null, 'unknown', now, `提交结果未知：${error instanceof Error ? error.message : String(error)}`)],
        createdAt: now,
        updatedAt: now,
      }
      await putNewMediaRecord(WECHAT_PUBLISH_KIND, unknown)
    }
    throw error
  } finally {
    submitting.delete(input.draftId)
  }
}

/**
 * 轮询平台发布状态。这是发布结果的权威来源；回调（若未来可用）也走同一更新入口。
 */
export async function pollWechatPublishStatus(
  context: WechatPublishContext,
  publishRecordId: string,
  dependencies: WechatPublishDependencies = {},
): Promise<WechatPublishRecord> {
  const record = await getWechatPublish(publishRecordId)
  if (!record) throw new Error('发布记录不存在')
  if (record.accountId !== context.accountId) throw new Error('发布记录不属于当前账号')
  if (!record.publishId) throw new Error('缺少 publish_id，无法查询发布状态；请先对账')

  const payload = await callPublishApi({
    credentialRef: context.credentialRef,
    endpoint: GET_URL,
    body: { publish_id: record.publishId },
    dependencies,
  })
  return applyPlatformPublishState(record, payload, dependencies.now?.() ?? Date.now())
}

/** 把平台返回字段落到状态机上，保留原始数值与转换历史。 */
export async function applyPlatformPublishState(
  record: WechatPublishRecord,
  payload: PublishPayload,
  now: number,
): Promise<WechatPublishRecord> {
  const mapped = mapPlatformPublishStatus(payload.publish_status)
  const articleItem = payload.article_detail?.item?.find((item) => item.article_url)
  const transitions = mapped.status === record.status
    ? record.transitions
    : [...record.transitions, transition(record.status, mapped.status, now, mapped.label, payload.publish_status)]

  const next: WechatPublishRecord = {
    ...record,
    status: mapped.status,
    platformStatus: payload.publish_status,
    articleId: payload.article_id ?? record.articleId,
    articleUrl: articleItem?.article_url ?? record.articleUrl,
    failIndices: payload.fail_idx ?? record.failIndices,
    lastPolledAt: now,
    // 只有平台明确返回成功才写 publishedAt。
    publishedAt: mapped.status === 'published' ? (record.publishedAt ?? now) : record.publishedAt,
    submitOutcomeUnknown: mapped.status === 'unknown' ? record.submitOutcomeUnknown : false,
    failureCode: mapped.status === 'failed' || mapped.status === 'rejected' ? `platform_status_${payload.publish_status ?? 'unknown'}` : record.failureCode,
    transitions,
    updatedAt: now,
  }
  return putNewMediaRecord(WECHAT_PUBLISH_KIND, next)
}

/** 人工对账提交结果：确认平台是否已受理。 */
export async function reconcileWechatSubmit(
  context: WechatPublishContext,
  publishRecordId: string,
  input: { platformAccepted: boolean; publishId?: string; note: string },
): Promise<WechatPublishRecord> {
  const record = await getWechatPublish(publishRecordId)
  if (!record) throw new Error('发布记录不存在')
  if (record.accountId !== context.accountId) throw new Error('发布记录不属于当前账号')
  if (!record.submitOutcomeUnknown) throw new Error('该发布记录不需要对账')
  if (!input.note.trim()) throw new Error('对账说明不能为空')

  const now = Date.now()
  if (input.platformAccepted) {
    // 平台已受理但需要 publish_id 才能查询状态；没有 publish_id 就保持 unknown。
    const next: WechatPublishRecord = {
      ...record,
      publishId: input.publishId?.trim() || record.publishId,
      status: input.publishId?.trim() ? 'publishing' : 'unknown',
      submitOutcomeUnknown: !input.publishId?.trim(),
      transitions: [...record.transitions, transition(record.status, input.publishId?.trim() ? 'publishing' : 'unknown', now, `人工对账确认平台已受理。${input.note.trim()}`)],
      updatedAt: now,
    }
    return putNewMediaRecord(WECHAT_PUBLISH_KIND, next)
  }
  const next: WechatPublishRecord = {
    ...record,
    status: 'failed',
    submitOutcomeUnknown: false,
    failureCode: 'reconciled_not_accepted',
    transitions: [...record.transitions, transition(record.status, 'failed', now, `人工对账确认平台未受理，可重新提交。${input.note.trim()}`)],
    updatedAt: now,
  }
  return putNewMediaRecord(WECHAT_PUBLISH_KIND, next)
}

export async function getWechatPublish(id: string): Promise<WechatPublishRecord | undefined> {
  return getNewMediaRecord<WechatPublishRecord>(WECHAT_PUBLISH_KIND, id)
}

export async function listWechatPublishes(accountId?: string): Promise<WechatPublishRecord[]> {
  const records = await listNewMediaRecords<WechatPublishRecord>(WECHAT_PUBLISH_KIND)
  const scoped = accountId ? records.filter((record) => record.accountId === accountId) : records
  return scoped.sort((left, right) => right.createdAt - left.createdAt)
}

/**
 * 执行器内部依赖覆盖点。
 *
 * 只用于测试：让「审批 → 真实执行器 → 发布状态机」这条链路可以在不出网的情况下被验证。
 * 生产代码从不设置它，缺省走真实代理传输层。
 */
let executorDependencies: WechatPublishDependencies = {}

export function setWechatPublishExecutorDependenciesForTests(dependencies: WechatPublishDependencies): void {
  executorDependencies = dependencies
}

export function resetWechatPublishExecutorDependenciesForTests(): void {
  executorDependencies = {}
}

/**
 * 注册微信发布执行器。
 *
 * 执行成功只代表「平台已受理」；回执里的 platformStatus 保留平台原文，
 * 是否真正发布成功必须由 pollWechatPublishStatus 判断。
 */
export function registerWechatPublishExecutor(): void {
  const platform: NewMediaPlatform = 'wechat-official-account'
  registerControlledActionExecutor({
    kind: 'publish',
    platform,
    describe: () => '微信公众号发布执行器：提交 freepublish 并返回 publish_id；提交受理不等于发布成功，结果需查询发布状态。',
    async execute(input) {
      if (!input.accountId) {
        throw new ControlledExecutionError('not_started', 'account_missing', '该审批未指定账号，无法解析微信凭据；请在创建审批时选择账号')
      }
      const account = await getNewMediaAccount(input.accountId)
      if (!account) throw new ControlledExecutionError('not_started', 'account_missing', '账号不存在或已删除')
      if (account.platform !== platform) throw new ControlledExecutionError('not_started', 'platform_mismatch', '账号平台与审批平台不一致')
      if (account.status !== 'connected') throw new ControlledExecutionError('not_started', 'account_not_connected', '账号尚未通过微信侧校验，不能发布')
      if (!account.credentialRef) throw new ControlledExecutionError('not_started', 'credential_missing', '账号缺少凭据引用')

      // 审批的 targetId 指向本地微信草稿记录。
      const draft = await getWechatDraft(input.targetId)
      if (!draft) throw new ControlledExecutionError('not_started', 'draft_not_found', '未找到对应的微信草稿；请先在公众号草稿链路中创建')
      if (draft.accountId !== input.accountId) throw new ControlledExecutionError('not_started', 'draft_account_mismatch', '草稿不属于该账号')

      // 素材来源与许可检查（P4-09）：封面等素材必须能回答来源与授权，缺许可直接阻断。
      // 该检查发生在任何平台请求之前，因此失败属于 not_started，可补齐许可后重试。
      const { assertAssetsPublishable } = await import('../new-media-asset-provenance')
      const assetKeys = draft.articles
        .map((article) => article.thumbMediaId)
        .filter((mediaId): mediaId is string => Boolean(mediaId))
      try {
        await assertAssetsPublishable({ accountId: input.accountId, assetKeys, aigcLabelRequired: false })
      } catch (error) {
        throw new ControlledExecutionError('not_started', 'asset_provenance_blocked', error instanceof Error ? error.message : String(error))
      }

      try {
        const record = await submitWechatPublish(
          { credentialRef: account.credentialRef, accountId: input.accountId },
          { draftId: input.targetId },
          executorDependencies,
        )
        return {
          platform,
          externalId: record.publishId,
          // 保留平台侧语义：这里只是受理，不是已发布。
          platformStatus: record.status,
          summary: `已提交发布（publish_id=${record.publishId ?? '未知'}），等待平台异步结果`,
          receivedAt: Date.now(),
          details: { publishRecordId: record.id, attemptId: input.attemptId },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // errcode 类错误是平台明确拒绝；超时/网络类错误结果未知。
        const confirmed = error instanceof PlatformAdapterError && error.code !== 'temporarily_unavailable'
        throw new ControlledExecutionError(confirmed ? 'confirmed_failure' : 'unknown', error instanceof PlatformAdapterError ? error.code : 'unexpected_error', message)
      }
    },
  })
}
