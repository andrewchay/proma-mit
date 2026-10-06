/**
 * 新媒体能力开关、灰度与回滚。
 *
 * 语义：
 * - 默认所有能力 active；flag 是 **kill switch**（关闭用），不是 enable 清单。
 * - 三层作用域从具体到宽泛：账号 > 平台 > 全局；命中最具体的一条。
 * - 灰度用阶段描述：off（全关）/ allowlist（名单内账号可用）/ all（全量）。
 * - 关闭与恢复都写审计；恢复**不删除**历史审计与旧开关记录（tombstone 保留）。
 * - 回滚手册见 docs/new-media-rollback-playbook.md，本模块提供的是手册中的执行机制。
 */
import { randomUUID } from 'node:crypto'
import type {
  NewMediaCapabilityFlag,
  NewMediaCapabilityFlagDecision,
  NewMediaPlatform,
  NewMediaRolloutStage,
} from '@gravitas/shared'
import { appendNewMediaAudit, createNewMediaAuditEntry } from './new-media-audit'
import { getNewMediaRecord, listNewMediaRecords, putNewMediaRecord } from './new-media-sqlite-store'

export const CAPABILITY_FLAG_KIND = 'capability-flag'

/**
 * 进程内开关快照。
 *
 * 插件的同步能力检查（工具注入路径）无法等待异步存储读取，
 * 因此在每次读取/变更开关时刷新快照，插件路径使用最近一次快照。
 * 快照缺失时插件按「未关闭」处理，不放大故障面。
 */
let cachedFlags: NewMediaCapabilityFlag[] | null = null

export function getCachedCapabilityFlags(): NewMediaCapabilityFlag[] {
  return cachedFlags ?? []
}

function refreshCache(flags: NewMediaCapabilityFlag[]): void {
  cachedFlags = flags
}

export interface SetCapabilityFlagInput {
  capability: string
  platform?: NewMediaPlatform
  accountId?: string
  stage: NewMediaRolloutStage
  allowlist?: string[]
  note?: string
  updatedBy: string
}

function flagId(capability: string, platform?: string, accountId?: string): string {
  return [capability, platform ?? '*', accountId ?? '*'].join('::')
}

function validateStage(stage: NewMediaRolloutStage, allowlist: string[]): void {
  if (stage === 'allowlist' && allowlist.length === 0) {
    throw new Error('allowlist 阶段必须提供至少一个账号；如需全关请使用 off')
  }
}

/** 写入（或覆盖同作用域的）能力开关；旧值被替换但审计保留。 */
export async function setCapabilityFlag(input: SetCapabilityFlagInput): Promise<NewMediaCapabilityFlag> {
  refreshCache(await listCapabilityFlagHistoryInternal())
  if (!input.capability.trim()) throw new Error('能力标识不能为空')
  if (!input.updatedBy.trim()) throw new Error('操作人不能为空')
  const allowlist = [...new Set((input.allowlist ?? []).map((item) => item.trim()).filter(Boolean))]
  validateStage(input.stage, allowlist)

  const id = flagId(input.capability, input.platform, input.accountId)
  const existing = await getNewMediaRecord<NewMediaCapabilityFlag>(CAPABILITY_FLAG_KIND, id)
  const flag: NewMediaCapabilityFlag = {
    id,
    capability: input.capability.trim(),
    scope: { platform: input.platform, accountId: input.accountId },
    stage: input.stage,
    allowlist,
    note: input.note?.trim() || undefined,
    updatedBy: input.updatedBy.trim(),
    updatedAt: Date.now(),
  }
  await putNewMediaRecord(CAPABILITY_FLAG_KIND, flag)
  refreshCache(await listCapabilityFlagHistoryInternal())
  const changed = existing?.stage !== flag.stage
    ? `${existing?.stage ?? '默认启用'} → ${flag.stage}`
    : `名单已更新（${allowlist.length} 个账号）`
  await appendNewMediaAudit(await createNewMediaAuditEntry({
    domain: 'governance',
    event: 'automation_triggered',
    actor: flag.updatedBy,
    subjectId: flag.capability,
    detail: `能力开关变更：${flag.capability} @ ${input.platform ?? '全平台'}${input.accountId ? ` / ${input.accountId}` : ''}：${changed}${flag.note ? `。${flag.note}` : ''}`,
    metadata: { capability: flag.capability, stage: flag.stage, scopePlatform: input.platform ?? '', scopeAccountId: input.accountId ?? '' },
  }))
  return flag
}

/** 恢复能力（移除覆盖）。旧的开关记录保留为历史，审计不删除。 */
export async function restoreCapabilityFlag(input: {
  capability: string
  platform?: NewMediaPlatform
  accountId?: string
  updatedBy: string
}): Promise<{ removed: boolean }> {
  const id = flagId(input.capability, input.platform, input.accountId)
  const existing = await getNewMediaRecord<NewMediaCapabilityFlag>(CAPABILITY_FLAG_KIND, id)
  if (!existing) return { removed: false }
  const tombstone: NewMediaCapabilityFlag = { ...existing, stage: 'all', allowlist: [], note: `已恢复（原 ${existing.stage}）`, updatedBy: input.updatedBy.trim(), updatedAt: Date.now() }
  await putNewMediaRecord(CAPABILITY_FLAG_KIND, tombstone)
  refreshCache(await listCapabilityFlagHistoryInternal())
  await appendNewMediaAudit(await createNewMediaAuditEntry({
    domain: 'governance',
    event: 'automation_triggered',
    actor: input.updatedBy.trim(),
    subjectId: input.capability,
    detail: `能力恢复：${input.capability} @ ${input.platform ?? '全平台'}${input.accountId ? ` / ${input.accountId}` : ''} 回到默认启用；历史审计保留。`,
    metadata: { capability: input.capability, previousStage: existing.stage },
  }))
  return { removed: true }
}

export async function listCapabilityFlags(): Promise<NewMediaCapabilityFlag[]> {
  // 注意：账号级 stage 'all' 是有效覆盖（用于在平台级 off 下放行灰度账号），不能过滤。
  const flags = await listCapabilityFlagHistoryInternal()
  refreshCache(flags)
  return flags
}

async function listCapabilityFlagHistoryInternal(): Promise<NewMediaCapabilityFlag[]> {
  const flags = await listNewMediaRecords<NewMediaCapabilityFlag>(CAPABILITY_FLAG_KIND)
  return flags.sort((left, right) => right.updatedAt - left.updatedAt)
}

/** 历史开关记录（含已恢复的），用于审计追溯。 */
export async function listCapabilityFlagHistory(): Promise<NewMediaCapabilityFlag[]> {
  const flags = await listNewMediaRecords<NewMediaCapabilityFlag>(CAPABILITY_FLAG_KIND)
  return flags.sort((left, right) => right.updatedAt - left.updatedAt)
}

interface ScopeMatch {
  capability: string
  platform?: NewMediaPlatform
  accountId?: string
}

function specificity(flag: NewMediaCapabilityFlag): number {
  let score = 0
  if (flag.scope.platform) score += 1
  if (flag.scope.accountId) score += 2
  return score
}

/**
 * 判定能力是否可用。
 * 命中最具体的覆盖：账号级 > 平台级；同一作用域取最近更新。
 * 无覆盖时默认启用。
 */
export function evaluateCapabilityFlag(
  scope: ScopeMatch,
  flags: NewMediaCapabilityFlag[],
): NewMediaCapabilityFlagDecision {
  const candidates = flags
    .filter((flag) => flag.capability === scope.capability)
    .filter((flag) => !flag.scope.platform || flag.scope.platform === scope.platform)
    .filter((flag) => !flag.scope.accountId || flag.scope.accountId === scope.accountId)
    .sort((left, right) => specificity(right) - specificity(left) || right.updatedAt - left.updatedAt)

  const matched = candidates[0]
  if (!matched) {
    return { ...scope, active: true, reason: '无覆盖开关，默认启用。' }
  }

  if (matched.stage === 'off') {
    return { ...scope, active: false, matchedFlagId: matched.id, reason: `能力已被关闭（${matched.note ?? '未注明原因'}，操作人 ${matched.updatedBy}）。` }
  }
  if (matched.stage === 'allowlist') {
    const allowed = scope.accountId !== undefined && matched.allowlist.includes(scope.accountId)
    return {
      ...scope,
      active: allowed,
      matchedFlagId: matched.id,
      reason: allowed
        ? `灰度 allowlist 阶段，当前账号在名单内。`
        : `灰度 allowlist 阶段，当前账号不在名单内（名单 ${matched.allowlist.length} 个账号）。`,
    }
  }
  return { ...scope, active: true, matchedFlagId: matched.id, reason: '开关为全量阶段。' }
}

/**
 * 判定一批账号/平台的组合能力（本地只有单账号，但接口按组合设计以便复用）。
 */
export function isCapabilityActive(scope: ScopeMatch, flags: NewMediaCapabilityFlag[]): boolean {
  return evaluateCapabilityFlag(scope, flags).active
}
