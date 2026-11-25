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

test('Given文本质量判断仅有引号排版差异 When匹配唯一原文 Then保存真实原文且拒绝虚构或歧义', async () => {
  const { parseOwnerQualityDecision } = await import('./project-owner-quality-protocol')
  const c = context(), delivery = c.conversation!.deliveryReview!
  delete delivery.developmentArtifact
  const content = '设计有"年份占位"并可返回。'
  delivery.artifact = { schemaVersion: 1, projectId: 'project-1', grantId: 'grant-1', commandId: 'executor', executionId: 'exec', sessionId: 'session', taskId: 'task-1', stepLinkId: 'link-1', sourceHash: 'd'.repeat(64), planRevision: 2, reworkOrdinal: 0, messageId: 'message', content, contentSha256: 'c'.repeat(64), byteLength: Buffer.byteLength(content), capturedAt: 1, integrityHash: 'e'.repeat(64) }
  const base = acceptDecision(), criteria = base.criteria as OwnerQualityDecision['criteria']
  criteria[0]!.quote = '设计有“年份占位”并可返回。'
  expect(parseOwnerQualityDecision(base, c).criteria[0]?.quote).toBe(content)
  delivery.artifact.content = `${content}\n${content}`
  expect(() => parseOwnerQualityDecision(base, c)).toThrow('引用不符')
  delivery.artifact.content = content
  criteria[0]!.quote = '设计有“年份占位”但无法返回。'
  expect(() => parseOwnerQualityDecision(base, c)).toThrow('引用不符')
})

function acceptDecision(): Record<string, unknown> {
  return { reviewerCommandId: 'review-cmd', artifactHash: 'c'.repeat(64), verdict: 'accept', reason: '修复和验证证据均符合标准。',
    criteria: [{ criterion: '包含修复逻辑', status: 'met', evidence: '代码快照包含修复逻辑', quote: 'return value + 1' }], findings: [] }
}

test('Given独立评审因缺少运行证据阻断 When Owner请求补验证 Then保留判断但不能作为代码缺陷自动返工', async () => {
  const protocol = await import('./project-owner-quality-protocol')
  const c = context(), review = c.conversation!.deliveryReview!.review!
  review.verdict = 'blocked'
  review.criteria[0] = { criterion: '包含修复逻辑', status: 'not_verified', evidence: '缺少运行回执', quote: null }
  const decision = { ...acceptDecision(), verdict: 'rework', criteria: [{ ...review.criteria[0] }], findings: [{ severity: 'medium', description: '缺少验证', requestedChange: '补充运行验证' }] }
  const parsed = protocol.parseOwnerQualityDecision(decision, c)
  expect(protocol.isOwnerEvidenceGapRework(parsed)).toBe(true)
  expect(() => protocol.parseOwnerQualityDecision({ ...decision, findings: [] }, c)).toThrow()
  review.verdict = 'approved'
  expect(() => protocol.parseOwnerQualityDecision(decision, c)).toThrow()
})

test('Given代码快照和全部新鲜成功验证回执 When Owner提出accept Then接受绑定准确快照的判断', async () => {
  const protocol = await import('./project-owner-quality-protocol')
  expect(protocol.parseOwnerQualityDecision(acceptDecision(), context())).toMatchObject({ verdict: 'accept', artifactHash: 'c'.repeat(64) })
})

test('Given Owner已判断明确验证命令通过且quote为空 When独立评审已引用同条完整成功回执 Then 复用真实引用', async () => {
  const { parseOwnerQualityDecision } = await import('./project-owner-quality-protocol')
  const c = context(), delivery = c.conversation!.deliveryReview!, check = delivery.developmentArtifact!.validationEvidence[0]!
  check.rawOutputSha256 = createHash('sha256').update(check.outputTail!).digest('hex')
  check.command = 'browser:html.loads+text-counter.behavior'
  check.finishedAt = Date.now()
  const criterion = check.command + ' 成功回执'
  delivery.review!.criteria[0] = { criterion, status: 'met', evidence: '命令已通过', quote: check.command }
  const decision = { ...acceptDecision(), criteria: [{ criterion, status: 'met', evidence: '核对命令终态及全部输出', quote: null }] }
  expect(parseOwnerQualityDecision(decision, c).criteria[0]?.quote).toBe(check.command)
  delivery.review!.criteria[0]!.quote = '虚构回执'
  expect(() => parseOwnerQualityDecision(decision, c)).toThrow('引用不符')
  delivery.review!.criteria[0]!.quote = 'browser:html.loads'
  delivery.developmentArtifact!.validationEvidence.push({ ...check, command: 'browser:html.loads' })
  expect(() => parseOwnerQualityDecision(decision, c)).toThrow('引用不符')
  delivery.review!.criteria[0]!.quote = check.command
  delete check.finishedAt
  expect(() => parseOwnerQualityDecision(decision, c)).toThrow('引用不符')
  check.finishedAt = Date.now()
  check.outputTruncated = true
  expect(() => parseOwnerQualityDecision(decision, c)).toThrow('引用不符')
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

test('Given返工决定引用原评审的说明缺陷和成功验证 When输出转义重复 Then只恢复可逐字验证的证据', async () => {
  const { parseOwnerQualityDecision } = await import('./project-owner-quality-protocol')
  const c = context(), delivery = c.conversation!.deliveryReview!
  const source = String.raw`输入 \`甲\n\n乙\n\n\n\` → 5 行`
  const output = '实际点击清空后输入为空且三项归零'
  const artifact = delivery.developmentArtifact!
  artifact.content = JSON.stringify({ files: [{ path: 'README.md', oldContent: null, newContent: source }] })
  artifact.validationEvidence = [{ ...artifact.validationEvidence[0]!, outputTail: output, rawOutputByteLength: Buffer.byteLength(output),
    rawOutputSha256: createHash('sha256').update(output).digest('hex') }]
  delivery.review!.verdict = 'changes_requested'
  delivery.review!.validationEvidence = artifact.validationEvidence
  const findings = [{ severity: 'medium', description: '示例多出一次换行', requestedChange: '修正示例' }]
  delivery.review!.criteria = [
    { criterion: '说明与实现一致', status: 'not_met', evidence: '说明有误', quote: source },
    { criterion: '实际浏览器验证通过', status: 'met', evidence: '验证成功', quote: output },
  ]
  const first = { ...delivery.review!.criteria[0]!, quote: source.replaceAll('\\', '\\\\') }
  const second = delivery.review!.criteria[1]!
  const decision = { ...acceptDecision(), verdict: 'rework', findings, criteria: [first, second] }
  expect(parseOwnerQualityDecision(decision, c).criteria.map(item => item.quote)).toEqual([source, output])
  expect(() => parseOwnerQualityDecision({ ...decision, criteria: [{ ...first, quote: first.quote.replace('5', '6') }, second] }, c)).toThrow('引用不符')
  artifact.validationEvidence[0]!.outputTruncated = true
  expect(() => parseOwnerQualityDecision(decision, c)).toThrow('引用不符')
})

test('Given签到牌评审已逐字引用JSON文件路径 When Owner独立判断并选择该条评审证据 Then 核实原路径而不重抄转义引号', async () => {
  const { parseOwnerQualityDecision } = await import('./project-owner-quality-protocol')
  const { buildOwnerObservationPrompt } = await import('./project-owner-observation-prompt')
  const c = context(), delivery = c.conversation!.deliveryReview!
  const criterion = '只交付一个自包含的 index.html'
  const pathQuote = '"path":"index.html"'
  delivery.developmentArtifact!.content = JSON.stringify({ files: [{ file: { path: 'index.html' }, oldContent: null, newContent: '<title>培训签到</title>' }] })
  delivery.review!.criteria = [{ criterion, status: 'met', evidence: '唯一交付是自包含签到牌', quote: pathQuote }]
  const decision = { ...acceptDecision(), criteria: [{ criterion, status: 'met', evidence: '读取快照后确认只有一个页面且资源自包含', quote: { from: 'reviewer' } }] }

  expect(() => parseOwnerQualityDecision(decision, c)).toThrow()
  delivery.qualityDecisionBindingVersion = 2
  expect(buildOwnerObservationPrompt(c)).toContain('{"from":"reviewer"}')
  const { buildProjectOwnerPlanningRequest, resolveProjectOwnerPlanningRequest } = await import('./project-owner-planning-protocol')
  c.sources.roles = [{ key: 'requirements-analyst', name: '需求分析师', version: '1.0.0', sourceSha256: 'a'.repeat(64), rulesSha256: 'b'.repeat(64) }]
  c.fingerprint = createHash('sha256').update(JSON.stringify({ goalRevision: c.goal.revision, goal: c.goal.goal, sources: c.sources })).digest('hex')
  const current = buildProjectOwnerPlanningRequest(c)
  expect(current.systemPrompt).toContain('{"from":"reviewer"}')
  const legacy = structuredClone(c)
  legacy.conversation!.deliveryReview!.qualityDecisionBindingVersion = 1
  const historical = buildProjectOwnerPlanningRequest(legacy)
  expect(historical.systemPrompt).not.toContain('{"from":"reviewer"}')
  expect(resolveProjectOwnerPlanningRequest(legacy, createHash('sha256').update(JSON.stringify(historical)).digest('hex'))).toEqual(historical)
  expect(() => parseOwnerQualityDecision(decision, legacy)).toThrow('引用不符')
  expect(parseOwnerQualityDecision(decision, c).criteria[0]?.quote).toBe(pathQuote)
  for (const quote of [{ from: 'reviewer', path: 'other.html' }, { from: 'other-reviewer' }, '"path":"other.html"']) {
    expect(() => parseOwnerQualityDecision({ ...decision, criteria: [{ ...decision.criteria[0], quote }] }, c)).toThrow()
  }
  expect(() => parseOwnerQualityDecision({ ...decision, criteria: [{ ...decision.criteria[0], criterion: '另一条标准' }] }, c)).toThrow()
  expect(() => parseOwnerQualityDecision({ ...decision, findings: [{ severity: 'high', description: '有缺陷', requestedChange: '需修复' }] }, c)).toThrow()
  delivery.review!.criteria[0]!.quote = '"path":"other.html"'
  expect(() => parseOwnerQualityDecision(decision, c)).toThrow()
})

test('Given新版完整决策将原标准分组重排 When核验 Then按准确名称恢复冻结顺序且拒绝遗漏与重复', async () => {
  const { parseOwnerQualityDecision } = await import('./project-owner-quality-protocol')
  const c = context(), delivery = c.conversation!.deliveryReview!, review = delivery.review!
  const revisedCriterion = { ...review.criteria[0]!, criterion: '合计行在标题后且原位置已删除' }
  review.criteria.unshift(revisedCriterion)
  const decision = { ...acceptDecision(), criteria: [review.criteria[1]!, revisedCriterion] }
  delivery.qualityDecisionBindingVersion = 1
  expect(() => parseOwnerQualityDecision(decision, c)).toThrow('与准确评审/成果不匹配')
  delivery.qualityDecisionBindingVersion = 2
  expect(parseOwnerQualityDecision(decision, c).criteria.map(item => item.criterion)).toEqual(review.criteria.map(item => item.criterion))
  for (const criteria of [[revisedCriterion], [revisedCriterion, revisedCriterion], [revisedCriterion, { ...review.criteria[1]!, criterion: '未知标准' }]]) {
    expect(() => parseOwnerQualityDecision({ ...decision, criteria }, c)).toThrow()
  }
})
