/**
 * 研究协议规则（M3，纯函数无 IO）
 *
 * 门禁语义（方案 §4、§11）：
 * - 批准要求：领域 profile 的必填字段齐全 + 全部启用检查项已阅读确认
 * - 人体数据采集（qualitative/mixed 且涉及资料收集）必须在批准前提供伦理依据
 * - 修订必须说明理由，且新版本从 draft 重新开始（旧批准不得沿用）
 * - 领域与方法路径必须匹配 profile 允许集合
 *
 * 本层不判断研究质量，只判断「流程是否具备可批准的形式条件」。
 */

import type { ResearchDomain, ResearchMethodPath, ResearchProtocol } from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import { assertMethodPathAllowed, checksFor, getDomainProfile, requiredFieldsFor } from './research-profiles'

export interface ProtocolDraftInput {
  methodPath: ResearchMethodPath
  fields: Record<string, string>
  ethicsBasis?: string
}

/** 校验草稿输入：方法路径匹配 + 字段非空结构（必填缺失仅警告，批准时才拦） */
export function validateProtocolDraft(
  domain: ResearchDomain,
  input: ProtocolDraftInput,
): { missingRequiredFields: string[] } {
  assertMethodPathAllowed(domain, input.methodPath)
  const missing = requiredFieldsFor(domain, input.methodPath)
    .filter((f) => !input.fields[f.key]?.trim())
    .map((f) => f.key)

  return { missingRequiredFields: missing }
}

/**
 * 批准前检查（可能有多项未通过，全部返回而非只报第一条）。
 */
export interface ApprovalCheckResult {
  ok: boolean
  blockers: string[]
  /** 需人工确认但可批准时提示的检查项 */
  checkIds: string[]
}

export function evaluateApproval(
  domain: ResearchDomain,
  protocol: Pick<ResearchProtocol, 'methodPath' | 'fields' | 'acknowledgedChecks'>,
): ApprovalCheckResult {
  const blockers: string[] = []
  const profile = getDomainProfile(domain)

  if (!profile.allowedMethodPaths.includes(protocol.methodPath)) {
    blockers.push(`领域「${profile.label}」不支持方法路径「${protocol.methodPath}」`)
  }

  // 必填字段按方法路径解析：涉及人类参与者的领域，伦理依据只在
  // qualitative / mixed-practice 下必填（见 research-profiles 的条件必填）
  for (const field of requiredFieldsFor(domain, protocol.methodPath)) {
    if (!protocol.fields[field.key]?.trim()) {
      blockers.push(`缺少必填协议字段：${field.label}（${field.key}）`)
    }
  }

  const enabledChecks = checksFor(domain, protocol.methodPath)
  const unacknowledged = enabledChecks.filter((c) => !protocol.acknowledgedChecks.includes(c.id))
  if (unacknowledged.length > 0) {
    blockers.push(`以下检查项尚未确认：${unacknowledged.map((c) => c.description).join('；')}`)
  }

  return {
    ok: blockers.length === 0,
    blockers,
    checkIds: enabledChecks.map((c) => c.id),
  }
}

/** 校验修订输入（理由必填，方法路径仍须匹配） */
export function validateProtocolRevision(
  domain: ResearchDomain,
  previous: Pick<ResearchProtocol, 'version' | 'status'>,
  input: { changeReason: string; methodPath: ResearchMethodPath; fields: Record<string, string> },
): void {
  if (!input.changeReason?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, '协议修订必须说明变更理由')
  }
  assertMethodPathAllowed(domain, input.methodPath)
  if (previous.status === 'draft') {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      '草稿应直接修改而非修订；修订用于已批准版本的变更留痕',
    )
  }
}

/** 新版本的首版号 */
export function nextProtocolVersion(existing: Array<Pick<ResearchProtocol, 'version'>>): number {
  return existing.length === 0 ? 1 : Math.max(...existing.map((p) => p.version)) + 1
}
