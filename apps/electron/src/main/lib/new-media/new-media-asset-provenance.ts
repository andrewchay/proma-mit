/**
 * 素材来源、许可与 AIGC 标识链。
 *
 * 解决的问题：外发素材必须能回答「这素材从哪来、有没有授权、是不是 AI 生成」。
 *
 * 规则：
 * - 没有 provenance 记录的素材视为来源不明，不得外发（no_provenance）；
 * - 许可状态 missing / unknown / 过期都阻断外发；
 * - AIGC 素材未应用平台要求的标识时阻断外发（平台是否强制标识由调用方按平台声明，
 *   本地只提供开关与阻断逻辑，不替平台下结论）；
 * - provenance 本身只是记录与阻断，不自动判定「内容合法」——那是人工与平台的事。
 */
import { randomUUID } from 'node:crypto'
import type {
  NewMediaAssetProvenance,
  NewMediaAssetPublishCheck,
  NewMediaAssetPublishBlockReason,
  NewMediaAssetSourceKind,
} from '@gravitas/shared'
import { getNewMediaRecord, listNewMediaRecords, putNewMediaRecords } from './new-media-sqlite-store'

export const ASSET_PROVENANCE_KIND = 'asset-provenance'

export interface UpsertAssetProvenanceInput {
  assetKey: string
  accountId: string
  source: {
    kind: NewMediaAssetSourceKind
    origin?: string
    uploadedBy?: string
    generatedByModel?: string
    promptRef?: string
  }
  license: {
    status: 'granted' | 'missing' | 'unknown'
    licenseRef?: string
    grantedBy?: string
    expiresAt?: number
  }
  aigc: {
    isAigc: boolean
    model?: string
    labelApplied?: boolean
  }
}

function validateInput(input: UpsertAssetProvenanceInput): void {
  if (!input.assetKey.trim()) throw new Error('素材标识不能为空')
  if (!input.accountId.trim()) throw new Error('账号标识不能为空')
  if (!input.source.kind) throw new Error('素材来源类型不能为空')
  if (input.source.kind === 'generated' && !input.aigc.isAigc) {
    throw new Error('生成素材必须标记为 AIGC')
  }
  if (input.source.kind === 'licensed' && input.license.status !== 'granted') {
    throw new Error('授权来源素材必须提供有效许可')
  }
}

/** 登记或更新素材 provenance。assetKey 已存在时更新，保留创建时间。 */
export async function upsertAssetProvenance(input: UpsertAssetProvenanceInput, now = Date.now()): Promise<NewMediaAssetProvenance> {
  validateInput(input)
  const existing = (await listNewMediaRecords<NewMediaAssetProvenance>(ASSET_PROVENANCE_KIND))
    .find((entry) => entry.assetKey === input.assetKey && entry.accountId === input.accountId)
  const record: NewMediaAssetProvenance = {
    id: existing?.id ?? randomUUID(),
    assetKey: input.assetKey.trim(),
    accountId: input.accountId.trim(),
    source: { ...input.source },
    license: { ...input.license },
    aigc: { ...input.aigc },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  return putNewMediaRecords([{ kind: ASSET_PROVENANCE_KIND, value: record }]).then(() => record)
}

export async function getAssetProvenance(assetKey: string, accountId: string): Promise<NewMediaAssetProvenance | undefined> {
  const rows = await listNewMediaRecords<NewMediaAssetProvenance>(ASSET_PROVENANCE_KIND)
  return rows.find((entry) => entry.assetKey === assetKey && entry.accountId === accountId)
}

export async function listAssetProvenances(accountId?: string): Promise<NewMediaAssetProvenance[]> {
  const rows = await listNewMediaRecords<NewMediaAssetProvenance>(ASSET_PROVENANCE_KIND)
  const scoped = accountId ? rows.filter((entry) => entry.accountId === accountId) : rows
  return scoped.sort((left, right) => right.updatedAt - left.updatedAt)
}

const BLOCK_EXPLANATION: Record<NewMediaAssetPublishBlockReason, string> = {
  no_provenance: '素材没有来源记录：无法回答素材从哪来、是否有授权，禁止外发。请先登记来源与许可。',
  license_missing: '素材许可状态为 missing：未取得使用授权，禁止外发。',
  license_unknown: '素材许可状态未知：需要人工确认授权后再外发。',
  license_expired: '素材授权已过期：需要续期许可后才能继续使用。',
  aigc_unlabeled: 'AIGC 素材尚未应用平台要求的生成内容标识，禁止外发。',
}

/** 检查单个素材是否可外发，返回具体阻断原因。 */
export function checkAssetPublishable(provenance: NewMediaAssetProvenance | undefined, assetKey: string, options: { aigcLabelRequired: boolean }, now = Date.now()): NewMediaAssetPublishCheck {
  if (!provenance) {
    return { assetKey, publishable: false, reason: 'no_provenance', explanation: BLOCK_EXPLANATION.no_provenance }
  }
  if (provenance.license.status === 'missing') {
    return { assetKey, publishable: false, reason: 'license_missing', explanation: BLOCK_EXPLANATION.license_missing }
  }
  if (provenance.license.status === 'unknown') {
    return { assetKey, publishable: false, reason: 'license_unknown', explanation: BLOCK_EXPLANATION.license_unknown }
  }
  if (provenance.license.expiresAt !== undefined && provenance.license.expiresAt <= now) {
    return { assetKey, publishable: false, reason: 'license_expired', explanation: BLOCK_EXPLANATION.license_expired }
  }
  if (provenance.aigc.isAigc && options.aigcLabelRequired && !provenance.aigc.labelApplied) {
    return { assetKey, publishable: false, reason: 'aigc_unlabeled', explanation: BLOCK_EXPLANATION.aigc_unlabeled }
  }
  return { assetKey, publishable: true, explanation: '来源、许可与 AIGC 标识检查通过。' }
}

export interface AssertAssetsPublishableInput {
  accountId: string
  assetKeys: string[]
  /** 平台是否强制 AIGC 生成内容标识（由调用方按平台声明决定）。 */
  aigcLabelRequired: boolean
}

/**
 * 断言一批素材全部可外发；任一被阻断即抛错并列出全部问题。
 * 供发布执行器与审批入口调用，实现「缺许可禁止进入发布审批」。
 */
export async function assertAssetsPublishable(input: AssertAssetsPublishableInput, now = Date.now()): Promise<NewMediaAssetPublishCheck[]> {
  if (input.assetKeys.length === 0) throw new Error('发布内容必须声明素材清单；无法确认素材来源时不得外发')
  const checks: NewMediaAssetPublishCheck[] = []
  for (const assetKey of input.assetKeys) {
    const provenance = await getAssetProvenance(assetKey, input.accountId)
    checks.push(checkAssetPublishable(provenance, assetKey, { aigcLabelRequired: input.aigcLabelRequired }, now))
  }
  const blocked = checks.filter((check) => !check.publishable)
  if (blocked.length > 0) {
    const summary = blocked.map((check) => `${check.assetKey}：${check.explanation}`).join('；')
    throw new Error(`以下素材未通过外发检查，已阻断：${summary}`)
  }
  return checks
}

/** 便捷构造：为已上传素材登记来源（例如来自 P2-03 的上传）。 */
export function provenanceForUploadedAsset(input: { assetKey: string; accountId: string; uploadedBy: string; licenseStatus: 'granted' | 'missing' | 'unknown'; licenseRef?: string }): UpsertAssetProvenanceInput {
  return {
    assetKey: input.assetKey,
    accountId: input.accountId,
    source: { kind: 'uploaded', uploadedBy: input.uploadedBy },
    license: { status: input.licenseStatus, licenseRef: input.licenseRef, grantedBy: input.uploadedBy },
    aigc: { isAigc: false },
  }
}

/** 便捷构造：为 AI 生成素材登记来源（模型与提示词引用必须记录）。 */
export function provenanceForGeneratedAsset(input: { assetKey: string; accountId: string; model: string; promptRef?: string; labelApplied: boolean }): UpsertAssetProvenanceInput {
  return {
    assetKey: input.assetKey,
    accountId: input.accountId,
    source: { kind: 'generated', generatedByModel: input.model, promptRef: input.promptRef },
    license: { status: 'granted', grantedBy: 'local-generation', licenseRef: `aigc:${input.model}` },
    aigc: { isAigc: true, model: input.model, labelApplied: input.labelApplied },
  }
}
