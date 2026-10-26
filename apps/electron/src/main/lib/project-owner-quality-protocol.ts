/** Owner质量判断纯协议。判断不等于执行，不读文件或改业务状态。 */
import type { OwnerQualityDecision, ProjectOwnerPlanningContext } from '@gravitas/shared'
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) throw new Error('Owner质量决定字段不完整或含未知字段')
  return value as Record<string, unknown>
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Owner质量决定依据无效或超限')
  return value.trim()
}
export function parseOwnerQualityDecision(raw: unknown, context: ProjectOwnerPlanningContext): OwnerQualityDecision {
  const delivery = context.conversation?.deliveryReview, observed = context.conversation?.executionObservation
  const review = delivery?.review, artifact = delivery?.artifact, developmentArtifact = delivery?.developmentArtifact
  const artifactHash = developmentArtifact?.contentHash ?? artifact?.contentSha256
  const artifactContent = developmentArtifact?.content ?? artifact?.content
  if (delivery?.qualityDecisionVersion !== 1 || delivery.state !== 'available' || (!artifact && !developmentArtifact) || (artifact && developmentArtifact) || !review || !artifactHash || !artifactContent || observed?.role !== 'reviewer' || context.conversation?.currentPlan?.state !== 'confirmed' || context.conversation.currentPlan.revision !== observed.sourcePlanRevision || delivery.qualityRecovery && (!/^[a-f0-9]{64}$/.test(delivery.qualityRecovery.conditionFingerprint) || !delivery.qualityRecovery.previousExecutionId || !delivery.qualityRecovery.previousDetail)) throw new Error('Owner质量决定缺少当前方案的完整成果及独立检查')
  const value = object(raw, ['reviewerCommandId', 'artifactHash', 'verdict', 'reason', 'criteria', 'findings'])
  if (value.reviewerCommandId !== observed.commandId || value.reviewerCommandId !== review.reviewerCommandId || value.artifactHash !== artifactHash || !['accept', 'rework', 'escalate'].includes(String(value.verdict)) || !Array.isArray(value.criteria) || value.criteria.length < review.criteria.length || value.criteria.length > review.criteria.length + (context.goal.goal.acceptanceCriteria?.length ?? 0) || !Array.isArray(value.findings) || value.findings.length > 32) throw new Error('Owner质量决定与准确评审/成果不匹配')
  const assessments: OwnerQualityDecision['criteria'] = value.criteria.map(item => {
    const criterion = object(item, ['criterion', 'status', 'evidence', 'quote'])
    if (typeof criterion.criterion !== 'string' || !['met', 'not_met', 'not_verified'].includes(String(criterion.status)) || (criterion.quote !== null && (typeof criterion.quote !== 'string' || !criterion.quote.trim() || criterion.quote.length > 1000 || !artifactContent.includes(criterion.quote))) || criterion.status === 'met' && criterion.quote === null) throw new Error('Owner质量决定未按准确标准逐项判断或引用不符')
    return { criterion: String(criterion.criterion), status: criterion.status as OwnerQualityDecision['criteria'][number]['status'], evidence: text(criterion.evidence), quote: criterion.quote as string | null }
  })
  const required = review.criteria.map(item => item.criterion)
  const criteria = assessments.filter(item => required.includes(item.criterion))
  // 额外的已满足项目标准不改变当前任务验收；未满足/未核验项不能被过滤掉。
  if (new Set(assessments.map(item => item.criterion)).size !== assessments.length
    || JSON.stringify(criteria.map(item => item.criterion)) !== JSON.stringify(required)
    || assessments.some(item => !required.includes(item.criterion) && (item.status !== 'met' || !context.goal.goal.acceptanceCriteria?.includes(item.criterion)))) throw new Error('Owner质量决定与准确评审/成果不匹配')
  const findings: OwnerQualityDecision['findings'] = value.findings.map(item => {
    const finding = object(item, ['severity', 'description', 'requestedChange'])
    if (!['low', 'medium', 'high'].includes(String(finding.severity))) throw new Error('Owner质量决定缺陷等级无效')
    return { severity: finding.severity as OwnerQualityDecision['findings'][number]['severity'], description: text(finding.description), requestedChange: text(finding.requestedChange) }
  })
  if (value.verdict === 'accept' && (review.verdict !== 'approved' || criteria.some(item => item.status !== 'met') || findings.length
    || developmentArtifact && (!review.validationEvidence?.length || review.validationEvidence.some(item => item.attemptState !== 'completed' || item.freshness !== 'fresh' || item.status !== 'passed' || item.exitCode !== 0 || item.timedOut !== false || item.outputTruncated !== false || !item.rawOutputSha256 || !Number.isSafeInteger(item.rawOutputByteLength))))) throw new Error('Owner不能在独立检查未通过或标准未满足时接受成果')
  if (value.verdict === 'rework' && (!criteria.some(item => item.status === 'not_met') || !findings.length)) throw new Error('Owner返工必须指出具体不满足标准及可执行修改')
  return { reviewerCommandId: String(value.reviewerCommandId), artifactHash: String(value.artifactHash), verdict: value.verdict as OwnerQualityDecision['verdict'], reason: text(value.reason), criteria, findings }
}
export const OWNER_QUALITY_INSTRUCTIONS = '本次必须返回quality_decision或真正需要业务决定的needs_clarification，不得仅回复等待、反复总结或让用户验收子任务。quality_decision仅含binding、messageId（throughMessageId）、message及decision。decision={reviewerCommandId:准确reviewer命令,artifactHash:准确成果摘要,verdict:"accept|rework|escalate",reason:"判断依据",criteria:[{criterion:按原顺序逐项复写标准,status:"met|not_met|not_verified",evidence:"你的独立判断",quote:null或准确正文/代码快照原文}],findings:[{severity:"low|medium|high",description:"缺陷",requestedChange:"可执行修改"}]}。met必须引用准确成果。accept须逐项met、无findings且独立Reviewer已approved；代码成果还要求绑定的每条验证证据均为新鲜成功、未超时且未截断；rework须有not_met和具体finding；证据不足或需要业务决定用escalate或必要问题。不得只复述Reviewer意见。qualityLimits给出当前返工、剩余业务请求和费用边界；返工至少需要一次执行及一次复验，额度不足应提出必要协商，不承诺越界续做。若存在qualityRecovery，必须把它视为上次阻断后的新事实提示，重新核对当前全套证据和许可；不能照抄或重放旧决定，仍须输出新的判断。此响应提出判断，主进程将复核当前管理委托、业务许可、版本、预算和依赖后才可能执行；message不要声称已经验收、返工或派发。正常子任务质量判断由你负责，不请用户代签；真正业务取舍集中提问。'
