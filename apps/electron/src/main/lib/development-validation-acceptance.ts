/**
 * 运行验证证据的采信规则。
 *
 * 职责：判断一份运行证据能否作为评审/验收依据。
 * 边界：
 * - 只做证据侧的判定，不执行任何命令、不读取工作区文件；
 * - 采信不代表业务质量达标，只说明"这条证据可信且与本成果绑定"；
 * - command 方式沿用既有语义（退出码 0 且未超时）；browser_assertions 必须有逐项断言结果，
 *   不允许"只跑过就算通过"。
 */

import type { DevelopmentValidationEvidence } from '@gravitas/shared'

/** 运行证据有效期：超期须重跑，避免拿旧结果充当新鲜成功。 */
export const DEVELOPMENT_VALIDATION_EVIDENCE_VALIDITY_MS = 30 * 60 * 1000

/** 允许的时钟前偏：超过即视为伪造或时钟错乱的时间戳。 */
export const DEVELOPMENT_VALIDATION_CLOCK_SKEW_MS = 5 * 60 * 1000

export interface DevelopmentValidationVerdict {
  accepted: boolean
  reason?: string
}

function reject(reason: string): DevelopmentValidationVerdict {
  return { accepted: false, reason }
}

/**
 * 判定一份运行证据是否可采信。
 *
 * @param evidence 候选证据（可缺省，缺省即无证据）
 * @param options expectedSnapshotHash 为当前成果指纹，与证据绑定值不一致即失效
 */
export function evaluateDevelopmentValidationEvidence(
  evidence: DevelopmentValidationEvidence | undefined,
  options: { expectedSnapshotHash: string; now?: number },
): DevelopmentValidationVerdict {
  if (!evidence) return reject('缺少运行验证证据')
  const { result, freshness } = evidence
  // freshness 已覆盖身份/配置/变化集漂移，不必在此重复推导。
  if (freshness !== 'fresh') return reject(`证据不是新鲜成功（${freshness}）${evidence.reason ? `：${evidence.reason}` : ''}`)
  if (result.timedOut || result.exitCode === null) return reject('进程未确认退出，不能计为成功')
  if (result.outputTruncated) return reject('输出被截断，不能作为成功依据')
  if (result.snapshotContentHash !== options.expectedSnapshotHash) return reject('证据绑定的成果已变更，须重新验证')
  const now = options.now ?? Date.now()
  // 未来时间会让"是否过期"恒为否，等价于永久有效，必须单独拒绝。
  if (result.finishedAt > now + DEVELOPMENT_VALIDATION_CLOCK_SKEW_MS) return reject('证据完成时间在未来，不能采信')
  if (now - result.finishedAt > DEVELOPMENT_VALIDATION_EVIDENCE_VALIDITY_MS) {
    return reject(`证据已过期（有效期 ${DEVELOPMENT_VALIDATION_EVIDENCE_VALIDITY_MS / 60000} 分钟）`)
  }
  if (result.method === 'browser_assertions') {
    // 断言全通过对齐，但仍须整体状态成功：status 失败或退出码非 0 不得被采信。
    if (result.status !== 'passed' || result.exitCode !== 0) return reject(`验证状态为 ${result.status}（退出码 ${result.exitCode ?? 'null'}），不是成功`)
    const checks = result.checks ?? []
    if (checks.length === 0) return reject('浏览器断言缺少逐项结果，不能只凭退出码采信')
    if (checks.some(check => check.status === 'failed')) return reject('存在失败的断言项')
    if (!checks.some(check => check.status === 'passed')) return reject('没有任何通过的断言项')
    return { accepted: true }
  }
  if (result.status !== 'passed') return reject(`验证状态为 ${result.status}，不是成功`)
  return { accepted: true }
}

/**
 * 判断一条已交接的验证证据是否已过期。
 *
 * 为什么不用交接时写下的 `expired`：那是生成时的快照，评审或验收可能在其后很久才发生。
 * 这里在判定时按 `finishedAt` 重新计算，`expired` 仅作为"生成时就已过期"的额外否决。
 */
export function isOwnerValidationEvidenceExpired(
  item: { finishedAt?: number; expired?: boolean },
  now = Date.now(),
): boolean {
  if (item.expired === true) return true
  if (typeof item.finishedAt !== 'number') return false
  // 未来时间戳视为不可采信（按过期处理），否则超期判断会被绕过。
  if (item.finishedAt > now + DEVELOPMENT_VALIDATION_CLOCK_SKEW_MS) return true
  return now - item.finishedAt > DEVELOPMENT_VALIDATION_EVIDENCE_VALIDITY_MS
}
