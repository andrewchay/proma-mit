import { randomUUID } from 'node:crypto'
import type {
  ProjectChain,
  ProjectChainCommand,
  ProjectDecision,
  ProjectDecisionSourceRef,
  ProjectDodCheckResult,
  ProjectDodAutomationRule,
  ProjectDeliverable,
} from '@gravitas/shared'

const STRUCTURED_SOURCE_TYPES = new Set(['document', 'meeting', 'message', 'task', 'url', 'other'])

function structuredSourceRefs(refs: ProjectDecisionSourceRef[], requiredForDaci: boolean): ProjectDecisionSourceRef[] {
  if (requiredForDaci && !refs.length) throw new Error('关键决策必须提供结构化原文定位')
  const unique = new Map<string, ProjectDecisionSourceRef>()
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object' || !STRUCTURED_SOURCE_TYPES.has(ref.sourceType))
      throw new Error('结构化原文定位的来源类型无效')
    required(ref.sourceId, '原文来源 ID')
    required(ref.locator, '原文定位符')
    if (ref.checksum !== undefined) required(ref.checksum, '原文校验值')
    const normalized = {
      sourceType: ref.sourceType,
      sourceId: ref.sourceId.trim(),
      locator: ref.locator.trim(),
      ...(ref.checksum?.trim() ? { checksum: ref.checksum.trim() } : {}),
    }
    unique.set(`${normalized.sourceType}\u0000${normalized.sourceId}\u0000${normalized.locator}`, normalized)
  }
  return [...unique.values()]
}

export function emptyProjectChain(): ProjectChain {
  return {
    revision: 0,
    decisions: [],
    drafts: [],
    decisionHistory: [],
    draftHistory: [],
    events: [],
    projectDefinitionOfDone: [],
    taskDefinitionOfDone: {},
    taskDodAutoAcceptance: {},
    dependencyHandoffs: [],
    serviceLevelDays: 7,
  }
}

/** 仅在配置了 DoD 时阻止任务完成，避免把旧项目无提示地改成不可完成。 */
export function assertTaskCompletionAllowed(chain: ProjectChain, taskId: string): void {
  const pendingHandoffs = (chain.dependencyHandoffs ?? []).filter(
    (handoff) => handoff.downstreamTaskId === taskId && handoff.status !== 'accepted',
  )
  if (pendingHandoffs.length) throw new Error('关键依赖交接尚未被下游接收，不能标记完成')
  const requiredCriteria = [
    ...new Set([...(chain.projectDefinitionOfDone ?? []), ...(chain.taskDefinitionOfDone?.[taskId] ?? [])]),
  ]
  if (!requiredCriteria.length) return
  const accepted = chain.drafts.some(
    (draft) =>
      draft.taskId === taskId &&
      (draft.status === 'accepted' || draft.status === 'handoff_pending' || draft.status === 'handed_off') &&
      requiredCriteria.every(
        (criterion) =>
          draft.definitionOfDone?.includes(criterion) && draft.acceptedCriteria?.includes(criterion),
      ),
  )
  if (!accepted) throw new Error('任务 DoD 尚未由验收交付物逐项满足，不能标记完成')
}
function required(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200_000)
    throw new Error(`${label}不能为空或过长`)
}
/** 纯状态转换：失败时不修改原状态，验收绑定交付物版本。 */
export function applyChainCommand(
  source: ProjectChain,
  command: ProjectChainCommand,
  actor: string,
): ProjectChain {
  required(actor, '操作人')
  if (!command || typeof command !== 'object') throw new Error('无效的链路操作')
  const chain = structuredClone(source)
  const at = Date.now()
  let entityId: string
  let version: number
  const extraEvents: ProjectChain['events'] = []
  if (command.kind === 'decision') {
    required(command.title, '决策标题')
    required(command.rationale, '决定与理由')
    required(command.evidence, '证据来源')
    const previous = chain.decisions.find((item) => item.id === command.decisionId)
    if (command.decisionId !== undefined && !previous) throw new Error('决策不存在')
    if (previous) {
      required(command.changeReason, '变更原因')
      if (previous.actor !== actor) throw new Error('只有原决策责任人能修订决策')
    }
    const daci = command.daci ?? previous?.daci
    const deadlineAt = command.deadlineAt ?? previous?.deadlineAt
    if (daci) {
      for (const id of [daci.driverId, daci.approverId, ...daci.contributorIds, ...daci.informedIds])
        required(id, 'DACI 身份 ID')
      if (daci.driverId !== actor) throw new Error('只有 DACI 推进人能提交候选决策')
      if (!Number.isSafeInteger(deadlineAt) || deadlineAt! <= at)
        throw new Error('关键决策必须设置未来的最迟决定时间')
    }
    const sourceRefs = structuredSourceRefs(
      command.sourceRefs ?? previous?.sourceRefs ?? [],
      Boolean(daci),
    )
    const decision: ProjectDecision = {
      id: previous?.id ?? randomUUID(),
      version: (previous?.version ?? 0) + 1,
      title: command.title,
      rationale: command.rationale,
      evidence: command.evidence,
      actor,
      at,
      status: daci ? 'candidate' : 'decided',
      ...(daci ? { daci: structuredClone(daci), deadlineAt } : {}),
      impactTaskIds: [...new Set(command.impactTaskIds ?? previous?.impactTaskIds ?? [])],
      alternatives: structuredClone(command.alternatives ?? previous?.alternatives ?? []),
      assumptions: [...new Set(command.assumptions ?? previous?.assumptions ?? [])],
      sourceRefs,
      ...(previous ? { supersedes: { id: previous.id, version: previous.version } } : {}),
    }
    if (previous) {
      const priorHistory = chain.decisionHistory.find(
        (item) => item.id === previous.id && item.version === previous.version,
      )
      if (priorHistory) {
        priorHistory.status = 'superseded'
        priorHistory.supersededBy = { id: decision.id, version: decision.version }
      }
    }
    chain.decisions = [...chain.decisions.filter((item) => item.id !== decision.id), decision]
    chain.decisionHistory.push(structuredClone(decision))
    for (const draft of chain.drafts) {
      if (draft.decisions.some((ref) => ref.id === decision.id)) draft.status = 'needs_review'
    }
    entityId = decision.id
    version = decision.version
  } else if (command.kind === 'approve_decision') {
    const decision = chain.decisions.find((item) => item.id === command.decisionId)
    if (!decision?.daci || decision.status !== 'candidate') throw new Error('只能确认 DACI 候选决策')
    if (decision.daci.approverId !== actor) throw new Error('只有 DACI 拍板人能确认决策')
    required(command.comment, '决策确认意见')
    structuredSourceRefs(decision.sourceRefs, true)
    if (
      command.selectedAlternativeId &&
      !decision.alternatives.some((item) => item.id === command.selectedAlternativeId)
    )
      throw new Error('所选方案不属于该决策')
    decision.status = 'decided'
    decision.approvedBy = actor
    decision.approvedAt = at
    decision.selectedAlternativeId = command.selectedAlternativeId
    const history = chain.decisionHistory.find(
      (item) => item.id === decision.id && item.version === decision.version,
    )
    if (history) Object.assign(history, structuredClone(decision))
    entityId = decision.id
    version = decision.version
  } else if (command.kind === 'set_task_dod_auto_acceptance') {
    if (actor !== 'local-user') throw new Error('只有本机项目管理员能配置自动验收')
    required(command.taskId, '任务')
    if (command.riskLevel !== 'low') throw new Error('自动验收仅允许明确标记的低风险任务')
    const requiredCriteria = [
      ...new Set([...chain.projectDefinitionOfDone, ...(chain.taskDefinitionOfDone[command.taskId] ?? [])]),
    ]
    const supportedVerifiers = new Set(['artifact_reference_present', 'completed_execution'])
    if (command.enabled) {
      if (!requiredCriteria.length) throw new Error('配置自动验收前必须先定义 DoD')
      if (!Array.isArray(command.rules) || command.rules.length !== requiredCriteria.length)
        throw new Error('自动验收必须为每项 DoD 配置一个验证器')
      const configured = new Set<string>()
      for (const rule of command.rules) {
        required(rule.criterion, '自动验收 DoD 条目')
        if (!requiredCriteria.includes(rule.criterion) || configured.has(rule.criterion))
          throw new Error('自动验收规则必须与当前 DoD 逐项唯一对应')
        if (!supportedVerifiers.has(rule.verifier)) throw new Error('自动验收验证器不受支持')
        configured.add(rule.criterion)
      }
    }
    chain.taskDodAutoAcceptance[command.taskId] = {
      taskId: command.taskId,
      enabled: command.enabled,
      riskLevel: 'low',
      rules: structuredClone(command.rules),
    }
    entityId = command.taskId
    version = chain.revision + 1
  } else if (command.kind === 'set_flow_policy') {
    if (actor !== 'local-user') throw new Error('只有本机项目管理员能配置服务水平')
    if (
      !Number.isFinite(command.serviceLevelDays) ||
      command.serviceLevelDays <= 0 ||
      command.serviceLevelDays > 365
    )
      throw new Error('服务水平天数必须在 0 到 365 天之间')
    chain.serviceLevelDays = command.serviceLevelDays
    entityId = 'flow-policy'
    version = chain.revision + 1
  } else if (command.kind === 'set_project_dod' || command.kind === 'set_task_dod') {
    if (actor !== 'local-user') throw new Error('只有本机项目管理员能配置完成定义')
    if (
      !Array.isArray(command.criteria) ||
      command.criteria.some((item) => typeof item !== 'string' || !item.trim())
    )
      throw new Error('完成定义必须为非空条目')
    if (command.kind === 'set_project_dod') {
      chain.projectDefinitionOfDone = [...new Set(command.criteria.map((item) => item.trim()))]
      entityId = 'project-dod'
    } else {
      required(command.taskId, '任务')
      chain.taskDefinitionOfDone[command.taskId] = [...new Set(command.criteria.map((item) => item.trim()))]
      entityId = command.taskId
    }
    version = chain.revision + 1
  } else if (command.kind === 'define_dependency_handoff') {
    for (const [label, value] of Object.entries({
      依赖: command.dependencyId,
      上游任务: command.upstreamTaskId,
      下游任务: command.downstreamTaskId,
      需要内容: command.need,
      提供人: command.providerId,
      接收人: command.consumerId,
    }))
      required(value, label)
    if (command.providerId !== actor) throw new Error('只有上游提供人能定义依赖交接契约')
    if (!Number.isSafeInteger(command.dueAt) || command.dueAt <= at)
      throw new Error('交接契约必须设置未来交付时间')
    if (
      !Array.isArray(command.criteria) ||
      command.criteria.some((item) => typeof item !== 'string' || !item.trim())
    )
      throw new Error('接收标准必须为非空条目')
    const handoff = {
      dependencyId: command.dependencyId,
      upstreamTaskId: command.upstreamTaskId,
      downstreamTaskId: command.downstreamTaskId,
      need: command.need,
      providerId: command.providerId,
      consumerId: command.consumerId,
      dueAt: command.dueAt,
      criteria: [...new Set(command.criteria.map((item) => item.trim()))],
      status: 'planned' as const,
      updatedAt: at,
    }
    chain.dependencyHandoffs = [
      ...chain.dependencyHandoffs.filter((item) => item.dependencyId !== command.dependencyId),
      handoff,
    ]
    entityId = handoff.dependencyId
    version = chain.revision + 1
  } else if (
    command.kind === 'offer_dependency_handoff' ||
    command.kind === 'accept_dependency_handoff' ||
    command.kind === 'return_dependency_handoff'
  ) {
    const handoff = chain.dependencyHandoffs.find((item) => item.dependencyId === command.dependencyId)
    if (!handoff) throw new Error('依赖交接契约不存在')
    required(command.comment, '交接意见')
    if (command.kind === 'offer_dependency_handoff') {
      if (actor !== handoff.providerId) throw new Error('只有上游提供人能发出交接要约')
      if (handoff.status !== 'planned' && handoff.status !== 'returned')
        throw new Error('当前依赖不能发出交接要约')
      handoff.status = 'offered'
      handoff.offerComment = command.comment
    } else {
      if (actor !== handoff.consumerId) throw new Error('只有下游接收人能确认依赖交接')
      if (handoff.status !== 'offered') throw new Error('依赖交接尚未发出要约')
      if (command.kind === 'accept_dependency_handoff') {
        const completed = command.completedCriteria ?? []
        if (!handoff.criteria.every((criterion) => completed.includes(criterion)))
          throw new Error('接收标准尚未逐项确认')
        handoff.acceptedCriteria = [...new Set(completed)]
      } else {
        delete handoff.acceptedCriteria
      }
      handoff.status = command.kind === 'accept_dependency_handoff' ? 'accepted' : 'returned'
      handoff.receiptComment = command.comment
    }
    handoff.updatedAt = at
    entityId = handoff.dependencyId
    version = chain.revision + 1
  } else if (command.kind === 'draft') {
    if (command.artifactRef !== undefined && command.artifactRef !== '')
      required(command.artifactRef, '成果引用')
    for (const [label, value] of Object.entries({
      标题: command.title,
      交付说明: command.content,
      任务: command.taskId,
      验收标准: command.criteria,
      接收人: command.recipient,
    }))
      required(value, label)
    if (
      !Array.isArray(command.decisionIds) ||
      !command.decisionIds.length ||
      command.decisionIds.some((id) => typeof id !== 'string')
    )
      throw new Error('请选择关联决策')
    const decisions = [...new Set(command.decisionIds)].map((id) => {
      const decision = chain.decisions.find((item) => item.id === id)
      if (!decision) throw new Error('关联决策不存在')
      if (decision.status !== 'decided') throw new Error('关联决策尚未由 DACI 拍板人确认')
      return { id, version: decision.version }
    })
    const previous = chain.drafts.find((item) => item.id === command.draftId)
    if (command.draftId !== undefined && !previous) throw new Error('交付物不存在')
    if (previous) {
      required(command.changeReason, '变更原因')
      if (previous.taskId !== command.taskId) throw new Error('交付版本不能转移到其他任务')
    }
    if (command.responsibilities) {
      for (const id of [
        command.responsibilities.ownerId,
        command.responsibilities.reviewerId,
        command.responsibilities.recipientId,
      ])
        required(id, '责任人 ID')
      if (actor !== command.responsibilities.ownerId) throw new Error('只有负责人能保存交付版本')
    }
    const draft: ProjectDeliverable = {
      id: previous?.id ?? randomUUID(),
      version: (previous?.version ?? 0) + 1,
      taskId: command.taskId,
      title: command.title,
      content: command.content,
      ...(command.artifactRef ? { artifactRef: command.artifactRef } : {}),
      ...(command.executionId ? { executionId: command.executionId } : {}),
      criteria: command.criteria,
      recipient: command.recipient,
      definitionOfDone: [
        ...new Set([...chain.projectDefinitionOfDone, ...(chain.taskDefinitionOfDone[command.taskId] ?? [])]),
      ],
      dodCheckResults: [],
      ...(command.responsibilities ? { responsibilities: structuredClone(command.responsibilities) } : {}),
      decisions,
      status: 'draft',
      actor,
      at,
    }
    chain.drafts = [...chain.drafts.filter((item) => item.id !== draft.id), draft]
    chain.draftHistory.push(structuredClone(draft))
    entityId = draft.id
    version = draft.version
  } else if (
    command.kind === 'submit' ||
    command.kind === 'accept' ||
    command.kind === 'reject' ||
    command.kind === 'request_handoff' ||
    command.kind === 'handoff' ||
    command.kind === 'reject_handoff'
  ) {
    const draft = chain.drafts.find((item) => item.id === command.draftId)
    if (!draft) throw new Error('交付物不存在')
    const current = draft.decisions.every((ref) =>
      chain.decisions.some((item) => item.id === ref.id && item.version === ref.version),
    )
    if (!current) throw new Error('决策已变更，请复核交付说明并保存新版本')
    const roles = draft.responsibilities
    if (!roles || !roles.ownerId?.trim() || !roles.reviewerId?.trim() || !roles.recipientId?.trim())
      throw new Error('责任未明确，请保存包含负责人、验收人和接收人 ID 的新版本')
    const expectedActor =
      command.kind === 'accept' || command.kind === 'reject'
        ? roles.reviewerId
        : command.kind === 'handoff' || command.kind === 'reject_handoff'
          ? roles.recipientId
          : roles.ownerId
    if (actor !== expectedActor) throw new Error('当前操作人不具备此步骤的责任权限')
    switch (command.kind) {
      case 'submit':
        if (draft.status !== 'draft') throw new Error('当前交付物不能提交')
        draft.status = 'submitted'
        {
          const policy = chain.taskDodAutoAcceptance[draft.taskId]
          if (policy?.enabled && policy.riskLevel === 'low') {
            const ruleByCriterion = new Map(policy.rules.map((rule) => [rule.criterion, rule]))
            const results: ProjectDodCheckResult[] = draft.definitionOfDone.map((criterion) => {
              const rule = ruleByCriterion.get(criterion)
              const evaluation = rule ? evaluateDodRule(rule, draft) : undefined
              return {
                criterion,
                status: evaluation?.passed ? 'passed' : 'failed',
                mode: 'automatic',
                ...(rule ? { verifier: rule.verifier } : {}),
                evidenceRef: evaluation?.evidenceRef ?? 'verifier:not-configured',
                checkedBy: 'system:dod-verifier',
                checkedAt: at,
              }
            })
            draft.dodCheckResults = results
            if (results.length > 0 && results.every((result) => result.status === 'passed')) {
              draft.acceptedCriteria = results.map((result) => result.criterion)
              draft.status = 'accepted'
              extraEvents.push({
                id: randomUUID(),
                action: 'auto_accept',
                entityId: draft.id,
                version: draft.version,
                actor: 'system:dod-verifier',
                at,
                comment: '低风险任务按预配置确定性验证器自动验收',
                evidence: results.map((result) => `${result.criterion}=${result.evidenceRef}`).join(';'),
              })
            }
          }
        }
        break
      case 'accept':
      case 'reject':
        required(command.comment, '验收意见')
        if (draft.status !== 'submitted') throw new Error('只能验收已提交交付物')
        if (command.kind === 'accept') {
          required(command.evidence, '验收依据')
          const completed = command.completedCriteria ?? []
          if (
            !Array.isArray(completed) ||
            !draft.definitionOfDone.every((criterion) => completed.includes(criterion))
          )
            throw new Error('DoD 未逐项确认')
          draft.acceptedCriteria = [...new Set(completed)]
          draft.dodCheckResults = draft.definitionOfDone.map((criterion) => ({
            criterion,
            status: 'passed',
            mode: 'manual',
            evidenceRef: command.evidence!,
            checkedBy: actor,
            checkedAt: at,
          }))
        }
        draft.status = command.kind === 'accept' ? 'accepted' : 'changes_requested'
        break
      case 'request_handoff':
        required(command.comment, '交接范围与说明')
        if (draft.status !== 'accepted') throw new Error('交接前必须完成验收')
        draft.status = 'handoff_pending'
        break
      case 'handoff':
      case 'reject_handoff':
        required(command.comment, '接收回执')
        if (draft.status !== 'handoff_pending') throw new Error('请先由负责人发起交接')
        draft.status = command.kind === 'handoff' ? 'handed_off' : 'changes_requested'
        break
      default:
        throw new Error('未知链路操作')
    }
    entityId = draft.id
    version = draft.version
  } else {
    throw new Error('未知链路操作')
  }
  chain.revision++
  chain.events.push({
    id: randomUUID(),
    action: command.kind,
    entityId,
    version,
    actor,
    at,
    ...('comment' in command ? { comment: command.comment } : {}),
    ...('evidence' in command ? { evidence: command.evidence } : {}),
    ...('changeReason' in command ? { changeReason: command.changeReason } : {}),
  })
  chain.events.push(...extraEvents)
  return chain
}

function evaluateDodRule(
  rule: ProjectDodAutomationRule,
  draft: ProjectDeliverable,
): { passed: boolean; evidenceRef?: string } {
  if (rule.verifier === 'artifact_reference_present') {
    return { passed: Boolean(draft.artifactRef?.trim()), evidenceRef: draft.artifactRef }
  }
  if (rule.verifier === 'completed_execution') {
    return { passed: Boolean(draft.execution?.completedAt), evidenceRef: draft.execution?.id }
  }
  return { passed: false }
}
