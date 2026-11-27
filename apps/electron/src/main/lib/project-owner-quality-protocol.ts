import { bindOwnerEvidenceRows } from './project-owner-evidence-reference'
/** Owner质量判断纯协议。判断不等于执行，不读文件或改业务状态。 */
import type { OwnerQualityDecision, ProjectOwnerPlanningContext } from '@gravitas/shared'
import { containsOwnerValidationEvidenceQuote, isOwnerValidationEvidenceExpired } from './development-validation-acceptance'
import { ownerSnapshotHasFilePathQuote, readOwnerMetadataQuote, resolveOwnerIndentationQuote, resolveOwnerTypographyQuote } from './project-owner-quote'
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) throw new Error('Owner质量决定字段不完整或含未知字段')
  return value as Record<string, unknown>
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Owner质量决定依据无效或超限')
  return value.trim()
}
/** 快照是JSON容器，源码引用应在解码后的文件正文中核对；仍保留旧容器原文引用的兼容性。 */
export function containsOwnerArtifactQuote(content: string, quote: string, development: boolean): boolean {
  const metadata = development ? readOwnerMetadataQuote(quote) : null
  if (!metadata && content.includes(quote)) return true
  if (!development) return false
  try {
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || !('files' in parsed) || !Array.isArray(parsed.files)) return false
    if (metadata) return metadata.kind === 'path' && metadata.exact === quote && ownerSnapshotHasFilePathQuote(parsed.files, quote)
    return parsed.files.some((file: unknown) => file !== null && typeof file === 'object'
      && ['oldContent', 'newContent'].some(key => key in file && typeof (file as Record<string, unknown>)[key] === 'string'
        && ((file as Record<string, unknown>)[key] as string).includes(quote)))
  } catch { return false }
}
export function isOwnerEvidenceGapRework(decision: OwnerQualityDecision): boolean {
  return decision.verdict === 'rework' && !decision.criteria.some(item => item.status === 'not_met') && decision.criteria.some(item => item.status === 'not_verified')
}
export const OWNER_INCOMPLETE_QUALITY_CRITERIA = 'Owner规划响应未覆盖全部验收标准'
export const OWNER_INVALID_EVIDENCE_REFERENCE = 'Owner规划响应引用了无效的验收证据编号'
export const OWNER_ACCEPT_WITH_FINDINGS = 'Owner选择通过但同时提交了缺陷，请重新判断是否影响验收标准'

export function parseOwnerQualityDecision(raw: unknown, context: ProjectOwnerPlanningContext, validationTime = Date.now(), sharedReviewerCriteria = false): OwnerQualityDecision {
  const delivery = context.conversation?.deliveryReview, observed = context.conversation?.executionObservation
  const review = delivery?.review, artifact = delivery?.artifact, developmentArtifact = delivery?.developmentArtifact
  const artifactHash = developmentArtifact?.contentHash ?? artifact?.contentSha256
  const artifactContent = developmentArtifact?.content ?? artifact?.content
  const freshValidation = delivery?.validationRefresh ?? review?.validationEvidence
  if (delivery?.qualityDecisionVersion !== 1 || delivery.state !== 'available' || (!artifact && !developmentArtifact) || (artifact && developmentArtifact) || !review || !artifactHash || !artifactContent || observed?.role !== 'reviewer' || context.conversation?.currentPlan?.state !== 'confirmed' || context.conversation.currentPlan.revision !== observed.sourcePlanRevision || delivery.qualityRecovery && (!/^[a-f0-9]{64}$/.test(delivery.qualityRecovery.conditionFingerprint) || !delivery.qualityRecovery.previousExecutionId || !delivery.qualityRecovery.previousDetail)) throw new Error('Owner质量决定缺少当前方案的完整成果及独立检查')
  const bound = delivery.qualityDecisionBindingVersion !== undefined && raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { reviewerCommandId: observed.commandId, artifactHash, ...raw } : raw
  const value = object(bound, ['reviewerCommandId', 'artifactHash', 'verdict', 'reason', 'criteria', 'findings'])
  // 采用同一独立评审的整组标准时，仍核对每条证据；返工也须携带 Owner 自己的明确修改意见。
  if (delivery.qualityDecisionBindingVersion === 2 && review.verdict === 'blocked' && value.verdict === 'blocked') {
    value.verdict = 'escalate'
  }
  const agreesWithReview = value.verdict === 'accept' && review.verdict === 'approved' && review.criteria.every(item => item.status === 'met')
    || value.verdict === 'rework' && review.verdict === 'changes_requested' && review.criteria.some(item => item.status === 'not_met')
    || value.verdict === 'escalate' && review.verdict !== 'approved'
    || value.verdict === 'rework' && Boolean(developmentArtifact) && review.verdict === 'blocked'
      && review.criteria.some(item => item.status === 'not_verified')
  if (sharedReviewerCriteria && value.criteria === 'reviewer' && delivery.qualityDecisionBindingVersion === 2
    && agreesWithReview && review.criteria.length > 0
    && review.criteria.every(item => item.status !== 'met' || typeof item.quote === 'string' && item.quote.trim())) {
    value.criteria = review.criteria.map(item => ({
      criterion: item.criterion, status: item.status, evidence: item.evidence,
      quote: item.status === 'met' ? { from: 'reviewer' } : item.quote ?? null,
    }))
  }
  if (value.reviewerCommandId !== observed.commandId || value.reviewerCommandId !== review.reviewerCommandId || value.artifactHash !== artifactHash || !['accept', 'rework', 'escalate'].includes(String(value.verdict)) || !Array.isArray(value.criteria) || value.criteria.length > review.criteria.length + (context.goal.goal.acceptanceCriteria?.length ?? 0) || !Array.isArray(value.findings) || value.findings.length > 32) throw new Error('Owner质量决定与准确评审/成果不匹配')
  if (value.criteria.length < review.criteria.length) {
    const numbered = delivery.qualityDecisionBindingVersion === 2 && value.criteria.length > 0
      && value.criteria.every((row: unknown) => row && typeof row === 'object' && Object.hasOwn(row, 'criterionId'))
    throw new Error(numbered ? OWNER_INCOMPLETE_QUALITY_CRITERIA : 'Owner质量决定与准确评审/成果不匹配')
  }
  let rows: readonly unknown[] = value.criteria
  if (delivery.qualityDecisionBindingVersion === 2) {
    try {
      rows = bindOwnerEvidenceRows(rows, review.criteria.map(item => item.criterion), {
        content: artifactContent, development: Boolean(developmentArtifact),
        validation: freshValidation ?? developmentArtifact?.validationEvidence,
      }, review.criteria)
    } catch (cause) {
      throw new Error(OWNER_INVALID_EVIDENCE_REFERENCE, { cause })
    }
  }
  const assessments: OwnerQualityDecision['criteria'] = rows.map(item => {
    const criterion = object(item, ['criterion', 'status', 'evidence', 'quote'])
    const independent = review.criteria.find(item => item.criterion === criterion.criterion)
    const independentQuote = independent?.quote
    let quote = criterion.quote
    if (delivery.qualityDecisionBindingVersion === 2 && criterion.status === 'met' && independent?.status === 'met'
      && quote && typeof quote === 'object' && !Array.isArray(quote)
      && Object.keys(quote).length === 1 && Object.hasOwn(quote, 'from') && 'from' in quote && quote.from === 'reviewer') {
      quote = independentQuote
    }
    if (!developmentArtifact && typeof quote === 'string' && !artifactContent.includes(quote)) quote = resolveOwnerTypographyQuote(artifactContent, quote) ?? quote
    if (developmentArtifact) {
      // 只复用同一标准的独立引用，且明确要求的命令已有绑定的完整成功回执。
      if (quote === null && criterion.status === 'met' && independent?.status === 'met' && typeof independentQuote === 'string' && typeof criterion.criterion === 'string') {
        const commands: string[] = criterion.criterion.match(/\bbrowser:[a-z0-9.-]+(?:\+[a-z0-9.-]+)*/g) ?? []
        if (developmentArtifact.validationEvidence.some(item => commands.includes(item.command)
          && Number.isSafeInteger(item.finishedAt) && !isOwnerValidationEvidenceExpired(item, validationTime)
          && containsOwnerValidationEvidenceQuote([item], independentQuote))) quote = independentQuote
      }
      // 只有逐字的独立评审源码引用才能解除一次 JSON 反斜杠重复编码。
      if (typeof quote === 'string' && typeof independentQuote === 'string' && independentQuote.includes('\\')
        && quote === independentQuote.replace(/\\/g, '\\\\') && containsOwnerArtifactQuote(artifactContent, independentQuote, true)) quote = independentQuote
      if (typeof quote === 'string' && !containsOwnerArtifactQuote(artifactContent, quote, true)
        && !(criterion.status === 'met' && containsOwnerValidationEvidenceQuote(developmentArtifact.validationEvidence, quote))) {
        const metadata = readOwnerMetadataQuote(quote)
        if (metadata && (metadata.kind === 'path' ? containsOwnerArtifactQuote(artifactContent, metadata.exact, true)
          : criterion.status === 'met' && containsOwnerValidationEvidenceQuote(developmentArtifact.validationEvidence, metadata.exact))) quote = metadata.exact
        else quote = resolveOwnerIndentationQuote(quote, candidate => containsOwnerArtifactQuote(artifactContent, candidate, true)) ?? quote
      }
    }
    const runtimeQuote = criterion.status === 'met' && typeof quote === 'string'
      && (containsOwnerValidationEvidenceQuote(freshValidation ?? developmentArtifact?.validationEvidence, quote)
        || Boolean(delivery.validationRefresh && quote === independentQuote && independent?.status === 'met'
          && containsOwnerValidationEvidenceQuote(review.validationEvidence, quote)))
    if (typeof criterion.criterion !== 'string' || !['met', 'not_met', 'not_verified'].includes(String(criterion.status)) || (quote !== null && (typeof quote !== 'string' || !quote.trim() || quote.length > 1000 || !runtimeQuote && !containsOwnerArtifactQuote(artifactContent, quote, Boolean(developmentArtifact)))) || criterion.status === 'met' && quote === null) throw new Error('Owner质量决定未按准确标准逐项判断或引用不符')
    return { criterion: String(criterion.criterion), status: criterion.status as OwnerQualityDecision['criteria'][number]['status'], evidence: text(criterion.evidence), quote: quote as string | null }
  })
  const required = review.criteria.map(item => item.criterion)
  const requiredNames = new Set(required)
  const byCriterion = new Map(assessments.map(item => [item.criterion, item]))
  const matched = assessments.filter(item => requiredNames.has(item.criterion))
  // 新协议按准确标准名绑定，再恢复冻结顺序；重复、缺失与未通过的额外标准仍拒绝。
  if (byCriterion.size !== assessments.length || required.some(criterion => !byCriterion.has(criterion))
    || (delivery.qualityDecisionBindingVersion !== 2 && matched.some((item, index) => item.criterion !== required[index]))
    || assessments.some(item => !requiredNames.has(item.criterion) && (item.status !== 'met' || !context.goal.goal.acceptanceCriteria?.includes(item.criterion)))) throw new Error('Owner质量决定与准确评审/成果不匹配')
  const criteria = delivery.qualityDecisionBindingVersion === 2 ? required.map(criterion => byCriterion.get(criterion)!) : matched
  const findings: OwnerQualityDecision['findings'] = value.findings.map(item => {
    const finding = object(item, ['severity', 'description', 'requestedChange'])
    const severity = delivery.qualityDecisionBindingVersion === 2 && ['major', 'blocker'].includes(String(finding.severity))
      ? 'high' : finding.severity
    if (severity !== 'low' && severity !== 'medium' && severity !== 'high') throw new Error('Owner质量决定缺陷等级无效')
    return { severity, description: text(finding.description), requestedChange: text(finding.requestedChange) }
  })
  if (value.verdict === 'accept' && (review.verdict !== 'approved' || criteria.some(item => item.status !== 'met')
    || developmentArtifact && (!freshValidation?.length || freshValidation.some(item => item.attemptState !== 'completed' || item.freshness !== 'fresh' || isOwnerValidationEvidenceExpired(item, validationTime) || item.status !== 'passed' || item.exitCode !== 0 || item.timedOut !== false || item.outputTruncated !== false || !item.rawOutputSha256 || !Number.isSafeInteger(item.rawOutputByteLength))))) throw new Error('Owner不能在独立检查未通过或标准未满足时接受成果')
  if (value.verdict === 'accept' && findings.length) throw new Error(OWNER_ACCEPT_WITH_FINDINGS)
  const evidenceGap = Boolean(developmentArtifact && review.verdict === 'blocked' && criteria.some(item => item.status === 'not_verified'))
  if (value.verdict === 'rework' && ((!criteria.some(item => item.status === 'not_met') && !evidenceGap) || !findings.length)) throw new Error('Owner返工必须指出具体不满足标准及可执行修改')
  return { reviewerCommandId: String(value.reviewerCommandId), artifactHash: String(value.artifactHash), verdict: value.verdict as OwnerQualityDecision['verdict'], reason: text(value.reason), criteria, findings }
}
export const OWNER_QUALITY_INSTRUCTIONS = '本次必须返回quality_decision或真正需要业务决定的needs_clarification，不得仅回复等待、反复总结或让用户验收子任务。quality_decision仅含binding、messageId（throughMessageId）、message及decision。decision={reviewerCommandId:准确reviewer命令,artifactHash:准确成果摘要,verdict:"accept|rework|escalate",reason:"判断依据",criteria:[{criterion:按原顺序逐项复写标准,status:"met|not_met|not_verified",evidence:"你的独立判断",quote:null或准确正文/代码快照原文}],findings:[{severity:"low|medium|high",description:"缺陷",requestedChange:"可执行修改"}]}。met必须引用准确成果。accept须逐项met、无findings且独立Reviewer已approved；代码成果还要求绑定的每条验证证据均为新鲜成功、未超时且未截断；rework须有not_met和具体finding；证据不足或需要业务决定用escalate或必要问题。不得只复述Reviewer意见。qualityLimits给出当前返工、剩余业务请求和费用边界；返工至少需要一次执行及一次复验，额度不足应提出必要协商，不承诺越界续做。若存在qualityRecovery，必须把它视为上次阻断后的新事实提示，重新核对当前全套证据和许可；不能照抄或重放旧决定，仍须输出新的判断。此响应提出判断，主进程将复核当前管理委托、业务许可、版本、预算和依赖后才可能执行；message不要声称已经验收、返工或派发。正常子任务质量判断由你负责，不请用户代签；真正业务取舍集中提问。'

export const OWNER_QUALITY_QUOTE_INSTRUCTIONS = 'criteria.quote只能引用成果正文或快照文件源码，不得引用验证命令、回执、日志或判断说明。quote必须是成果中逐字连续的子串；不得省略同一行前缀、拼接片段、补写声明或规范化代码。可以选用更短但实际连续的唯一片段。验证命令和结果写入evidence；not_met/not_verified缺少源码引用时quote用null，met引用准确源码。'
