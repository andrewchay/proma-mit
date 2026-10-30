import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { OwnerQualityDecision, ProjectOwnerPlanningContext } from '@gravitas/shared'

function context(): ProjectOwnerPlanningContext {
  const content = '{"files":[{"path":"src/app.ts","content":"return value + 1"}]}'
  const validationEvidence = [{ command: 'bun test src/app.test.ts', validationId: `val-${'a'.repeat(64)}`, attemptState: 'completed' as const,
    freshness: 'fresh' as const, status: 'passed' as const, exitCode: 0, timedOut: false, outputTail: 'pass', outputTruncated: false,
    rawOutputSha256: 'b'.repeat(64), rawOutputByteLength: 4 }]
  return {
    goal: { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1,
      goal: { projectId: 'project-1', goalVersion: 1, objective: '修复并验证代码', constraints: [], acceptanceCriteria: ['包含修复逻辑'] } },
    sources: { project: { id: 'project-1', title: '代码项目', description: '' }, roles: [] }, fingerprint: 'f'.repeat(64),
    conversation: {
      executionObservation: { executionId: 'review-exec', commandId: 'review-cmd', grantId: 'grant-1', sourcePlanRevision: 2,
        businessTaskId: 'task-1', taskTitle: '修复', role: 'reviewer', trigger: 'terminal', executionStatus: 'completed',
        commandState: 'settled', grantState: 'active', resultSummary: '摘要', error: '', actualCostMicros: 1, reservedCostMicros: 1 },
      deliveryReview: { version: 1, qualityDecisionVersion: 1, qualityLimits: { maxRework: 1, remainingRework: 1, remainingRuns: 2, remainingCostMicros: 100 },
        state: 'available', detail: '代码证据已核对', developmentArtifact: { projectId: 'project-1', grantId: 'grant-1', taskId: 'task-1', stepLinkId: 'link-1',
          sourceHash: 'd'.repeat(64), planRevision: 2, reworkOrdinal: 0, executorCommandId: 'exec-cmd', executorExecutionId: 'exec-run',
          contentHash: 'c'.repeat(64), content, validationEvidence },
        review: { reviewerCommandId: 'review-cmd', artifactHash: 'c'.repeat(64), verdict: 'approved',
          criteria: [{ criterion: '包含修复逻辑', status: 'met', evidence: '快照包含修复逻辑', quote: 'return value + 1' }], findings: [], validationEvidence } },
      conversationId: 'conversation-1', throughMessageId: '1'.repeat(64), historyThroughMessageId: '1'.repeat(64),
      messages: [{ id: '1'.repeat(64), role: 'assistant', content: '后台事件：代码评审已返回' }], truncated: false,
      currentPlan: { revision: 2, state: 'confirmed', proposal: { projectId: 'project-1', goalVersion: 1, mode: 'proposal_only',
        summary: '完成修复', assumptions: [], risks: [], steps: [] } }, tasks: [], tasksTruncated: false,
    },
  }
}

function acceptDecision(): Record<string, unknown> {
  return { reviewerCommandId: 'review-cmd', artifactHash: 'c'.repeat(64), verdict: 'accept', reason: '修复和验证证据均符合标准。',
    criteria: [{ criterion: '包含修复逻辑', status: 'met', evidence: '代码快照包含修复逻辑', quote: 'return value + 1' }], findings: [] }
}

test('Given代码快照和全部新鲜成功验证回执 When Owner提出accept Then接受绑定准确快照的判断', async () => {
  const protocol = await import('./project-owner-quality-protocol')
  expect(protocol.parseOwnerQualityDecision(acceptDecision(), context())).toMatchObject({ verdict: 'accept', artifactHash: 'c'.repeat(64) })
})

test('GivenJSON快照含多行源码和引号 WhenOwner逐字引用文件正文 Then按解码原文核对且不接受拼接或虚构', async () => {
  const { parseOwnerQualityDecision } = await import('./project-owner-quality-protocol')
  const c = context(), source = 'const name = "2048";\nscore += gained;'
  c.conversation!.deliveryReview!.developmentArtifact!.content = JSON.stringify({ files: [{ path: 'index.html', oldContent: null, newContent: source }] })
  const decision = acceptDecision()
  const criteria = decision.criteria as OwnerQualityDecision['criteria']
  criteria[0]!.quote = source
  expect(parseOwnerQualityDecision(decision, c).verdict).toBe('accept')
  for (const quote of ['const name = "2048"; … score += gained;', 'score += invented;', 'const name = 2048;']) {
    expect(() => parseOwnerQualityDecision({ ...decision, criteria: [{ ...criteria[0], quote }] }, c)).toThrow('引用不符')
  }
})

test('Given联合变量声明源码 When Owner引用同一行 Then完整连续片段可接受而省略前缀的缩写必须拒绝', async () => {
  const { parseOwnerQualityDecision, OWNER_QUALITY_QUOTE_INSTRUCTIONS } = await import('./project-owner-quality-protocol')
  const c = context(), source = "var size = 4, grid, score, bestKey = 'best-score-2048';"
  c.conversation!.deliveryReview!.developmentArtifact!.content = JSON.stringify({ files: [{ path: 'index.html', oldContent: null, newContent: source }] })
  const decision = acceptDecision(), criteria = decision.criteria as OwnerQualityDecision['criteria']
  criteria[0]!.quote = source
  expect(parseOwnerQualityDecision(decision, c).verdict).toBe('accept')
  expect(() => parseOwnerQualityDecision({ ...decision, criteria: [{ ...criteria[0], quote: "var bestKey = 'best-score-2048';" }] }, c)).toThrow('引用不符')
  expect(OWNER_QUALITY_QUOTE_INSTRUCTIONS).toContain('逐字连续的子串')
  expect(OWNER_QUALITY_QUOTE_INSTRUCTIONS).toContain('不得省略同一行前缀')
})

test('Given完整质量判断附加已满足的项目标准 When解析 Then保留准确任务标准并拒绝未知、未满足、重复及错误引用', async () => {
  const { parseOwnerQualityDecision } = await import('./project-owner-quality-protocol')
  const c = context(); c.goal.goal.acceptanceCriteria = ['额外项目标准']
  const base = acceptDecision()
  const extra = { criterion: '额外项目标准', status: 'met', evidence: '完整快照内可核对的额外判断', quote: 'return value + 1' }
  const criteria = base.criteria as OwnerQualityDecision['criteria']
  expect(parseOwnerQualityDecision({ ...base, criteria: [...criteria, extra] }, c).criteria).toEqual(criteria)
  for (const patch of [{ criterion: '未知标准' }, { status: 'not_met' }, { status: 'not_verified' }, { quote: '不存在的正文' }]) {
    expect(() => parseOwnerQualityDecision({ ...base, criteria: [...criteria, { ...extra, ...patch }] }, c)).toThrow()
  }
  expect(() => parseOwnerQualityDecision({ ...base, criteria: [extra] }, c)).toThrow()
  expect(() => parseOwnerQualityDecision({ ...base, criteria: [...criteria, extra, extra] }, c)).toThrow()
})

test('Given某条代码验证缺失、失败、过期或截断 When Owner提出accept Then质量协议拒绝错误验收', async () => {
  const protocol = await import('./project-owner-quality-protocol')
  const c = context()
  const evidence = c.conversation!.deliveryReview!.developmentArtifact!.validationEvidence[0]!
  c.conversation!.deliveryReview!.developmentArtifact!.validationEvidence[0] = { ...evidence, status: 'failed' }
  c.conversation!.deliveryReview!.review!.validationEvidence = c.conversation!.deliveryReview!.developmentArtifact!.validationEvidence
  expect(() => protocol.parseOwnerQualityDecision(acceptDecision(), c)).toThrow('不能在独立检查未通过')
})

test('Given完整独立评审上下文与缺kind的质量决定 When解析 Then补全类型但仍拒绝错误绑定、成果、引用及混合响应', async () => {
  const { parseProjectOwnerPlanningResponse, buildProjectOwnerPlanningRequest, resolveProjectOwnerPlanningRequest } = await import('./project-owner-planning-protocol')
  const c = context()
  c.sources.roles = [{ key: 'requirements-analyst', name: '需求分析师', version: '1.0.0', sourceSha256: 'a'.repeat(64), rulesSha256: 'b'.repeat(64) }]
  c.fingerprint = createHash('sha256').update(JSON.stringify({ goalRevision: c.goal.revision, goal: c.goal.goal, sources: c.sources })).digest('hex')
  const response = { binding: { projectId: c.goal.goal.projectId, goalVersion: 1, contextFingerprint: c.fingerprint }, messageId: c.conversation!.throughMessageId, message: '逐项核对后建议接受。', decision: acceptDecision() }
  expect(parseProjectOwnerPlanningResponse(response, c)).toMatchObject({ kind: 'quality_decision', decision: { verdict: 'accept' } })
  for (const patch of [{ messageId: 'wrong' }, { kind: 'conversation_reply' }, { proposal: {} }, { decision: { ...acceptDecision(), artifactHash: 'wrong' } }, { decision: { ...acceptDecision(), criteria: [{ criterion: '包含修复逻辑', status: 'met', evidence: '依据', quote: '不存在的正文' }] } }]) expect(() => parseProjectOwnerPlanningResponse({ ...response, ...patch }, c)).toThrow()
  const oldRequest = buildProjectOwnerPlanningRequest(c, 'envelope', true, false, false)
  expect(resolveProjectOwnerPlanningRequest(c, createHash('sha256').update(JSON.stringify(oldRequest)).digest('hex'))).toEqual(oldRequest)
  const oldEnvelope = buildProjectOwnerPlanningRequest(c, 'envelope', true, true, false)
  expect(resolveProjectOwnerPlanningRequest(c, createHash('sha256').update(JSON.stringify(oldEnvelope)).digest('hex'))).toEqual(oldEnvelope)
  expect(buildProjectOwnerPlanningRequest(c).systemPrompt).toContain('不得省略kind')
  const qualityPrompt = buildProjectOwnerPlanningRequest(c).systemPrompt
  expect(qualityPrompt).not.toContain('信息足够时直接提出结构化计划')
  expect(qualityPrompt).not.toContain('步骤格式示例')
  expect(qualityPrompt).not.toContain('二选一：kind="plan_proposal"')
  expect(qualityPrompt).toContain('本次只进行成果质量判定')
  const hostBound = structuredClone(c)
  hostBound.conversation!.observationMessageBindingVersion = 1
  const withoutMessageId = { ...response, kind: 'quality_decision' }
  delete (withoutMessageId as Partial<typeof response>).messageId
  expect(parseProjectOwnerPlanningResponse(withoutMessageId, hostBound)).toMatchObject({ messageId: c.conversation!.throughMessageId })
  expect(() => parseProjectOwnerPlanningResponse(withoutMessageId, c)).toThrow()
  expect(() => parseProjectOwnerPlanningResponse({ ...withoutMessageId, messageId: 'wrong' }, hostBound)).toThrow()
  expect(() => parseProjectOwnerPlanningResponse({ ...withoutMessageId, messageId: null }, hostBound)).toThrow()
  expect(() => parseProjectOwnerPlanningResponse({ ...withoutMessageId, binding: { ...response.binding, projectId: 'wrong' } }, hostBound)).toThrow()
  expect(buildProjectOwnerPlanningRequest(hostBound).systemPrompt).not.toContain('"messageId":')
  const ordinaryBound = structuredClone(hostBound)
  delete ordinaryBound.conversation!.deliveryReview
  const ordinaryResponse: Record<string, unknown> = { ...withoutMessageId, kind: 'conversation_reply' }
  delete ordinaryResponse.decision
  expect(parseProjectOwnerPlanningResponse(ordinaryResponse, ordinaryBound)).toMatchObject({ kind: 'conversation_reply', messageId: c.conversation!.throughMessageId })
  expect(() => parseProjectOwnerPlanningResponse({ ...ordinaryResponse, messageId: 'wrong' }, ordinaryBound)).toThrow()
  delete ordinaryBound.conversation!.executionObservation
  expect(() => buildProjectOwnerPlanningRequest(ordinaryBound)).toThrow('后台回应消息绑定协议无效')
  const ordinary = structuredClone(c); delete ordinary.conversation!.deliveryReview
  expect(() => parseProjectOwnerPlanningResponse(response, ordinary)).toThrow()
  expect(buildProjectOwnerPlanningRequest(ordinary).systemPrompt).not.toContain('信息足够时直接提出结构化计划')
  expect(buildProjectOwnerPlanningRequest(ordinary).systemPrompt).toContain('本次只分析后台员工事件')
  const oldObservation = buildProjectOwnerPlanningRequest(ordinary, 'envelope', true, true, false)
  expect(resolveProjectOwnerPlanningRequest(ordinary, createHash('sha256').update(JSON.stringify(oldObservation)).digest('hex'))).toEqual(oldObservation)
  delete ordinary.conversation!.executionObservation
  ordinary.conversation!.messages[0]!.role = 'user'
  expect(buildProjectOwnerPlanningRequest(ordinary).systemPrompt).toContain('信息足够时直接提出结构化计划')
})


test('Given历史接受在回执时有效但当前已过期 When读取历史 Then按回执时间可读而当前验收仍拒绝', async () => {
  const { parseProjectOwnerPlanningResponse } = await import('./project-owner-planning-protocol')
  const c = context(), capturedAt = Date.now() - 60 * 60_000
  c.sources.roles = [{ key: 'requirements-analyst', name: '需求分析师', version: '1.0.0', sourceSha256: 'a'.repeat(64), rulesSha256: 'b'.repeat(64) }]
  c.fingerprint = createHash('sha256').update(JSON.stringify({ goalRevision: c.goal.revision, goal: c.goal.goal, sources: c.sources })).digest('hex')
  c.conversation!.deliveryReview!.review!.validationEvidence![0]!.finishedAt = capturedAt - 1000
  const response = { schemaVersion: 1, kind: 'quality_decision', projectId: 'project-1', goalVersion: 1,
    contextFingerprint: c.fingerprint, messageId: c.conversation!.throughMessageId, message: '原回执中的判断。', decision: acceptDecision() }
  expect(() => parseProjectOwnerPlanningResponse(response, c)).toThrow('不能在独立检查未通过')
  expect(parseProjectOwnerPlanningResponse(response, c, capturedAt)).toMatchObject({ kind: 'quality_decision', decision: { verdict: 'accept' } })
  expect(() => parseProjectOwnerPlanningResponse({ ...response, decision: { ...acceptDecision(), artifactHash: 'wrong' } }, c, capturedAt)).toThrow('准确评审')
  expect(() => parseProjectOwnerPlanningResponse(response, c, capturedAt + 60 * 60_000)).toThrow('不能在独立检查未通过')
})


test('Given研发Reviewer逐字引用解码后的源码 When交接Owner构建请求 Then保留准确引用并拒绝虚构引用', async () => {
  const { buildProjectOwnerPlanningRequest, resolveProjectOwnerPlanningRequest } = await import('./project-owner-planning-protocol')
  const c = context(), source = 'const name = "2048";\nscore += gained;'
  c.sources.roles = [{ key: 'requirements-analyst', name: '需求分析师', version: '1.0.0', sourceSha256: 'a'.repeat(64), rulesSha256: 'b'.repeat(64) }]
  c.fingerprint = createHash('sha256').update(JSON.stringify({ goalRevision: c.goal.revision, goal: c.goal.goal, sources: c.sources })).digest('hex')
  c.conversation!.deliveryReview!.developmentArtifact!.content = JSON.stringify({ files: [{ path: 'index.html', oldContent: null, newContent: source }] })
  c.conversation!.deliveryReview!.review!.criteria[0]!.quote = source
  expect(() => buildProjectOwnerPlanningRequest(c)).not.toThrow()
  expect(buildProjectOwnerPlanningRequest(c).systemPrompt).toContain('不得引用验证命令')
  const legacy = buildProjectOwnerPlanningRequest(c,'envelope',true,true,true,true,false)
  expect(resolveProjectOwnerPlanningRequest(c,createHash('sha256').update(JSON.stringify(legacy)).digest('hex'))).toEqual(legacy)

  for (const quote of ['const name = "2048"; … score += gained;', 'score += invented;', 'const name = 2048;']) {
    c.conversation!.deliveryReview!.review!.criteria[0]!.quote = quote
    expect(() => buildProjectOwnerPlanningRequest(c)).toThrow('逐项检查引用不匹配')
  }
})
