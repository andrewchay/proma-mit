import { expect, test } from 'bun:test'
import { applyChainCommand, assertTaskCompletionAllowed, emptyProjectChain } from './project-chain'

test('DACI 决策只能由指定拍板人确认，确认后才可用于交付', () => {
  expect(() =>
    applyChainCommand(
      emptyProjectChain(),
      {
        kind: 'decision',
        title: '缺少来源的关键决策',
        rationale: '需要拍板',
        evidence: '口头说明',
        daci: {
          driverId: 'driver',
          approverId: 'approver',
          contributorIds: [],
          informedIds: [],
        },
        deadlineAt: Date.now() + 86_400_000,
        sourceRefs: [],
      },
      'driver',
    ),
  ).toThrow('结构化原文定位')
  let chain = applyChainCommand(
    emptyProjectChain(),
    {
      kind: 'decision',
      title: '选择供应商',
      rationale: '需要确定交付方',
      evidence: '报价单 A、B',
      daci: {
        driverId: 'driver',
        approverId: 'approver',
        contributorIds: ['expert'],
        informedIds: ['consumer'],
      },
      deadlineAt: Date.now() + 86_400_000,
      impactTaskIds: ['task-1'],
      alternatives: [{ id: 'a', title: '供应商 A', tradeoffs: '成本较低' }],
      assumptions: ['交付周期不超过 30 天'],
      sourceRefs: [
        {
          sourceType: 'meeting',
          sourceId: 'meeting-2026-09-09',
          locator: 'paragraph:42',
          checksum: 'sha256:abc123',
        },
      ],
    },
    'driver',
  )
  const decisionId = chain.decisions[0]!.id
  expect(chain.decisions[0]!.status).toBe('candidate')
  expect(() =>
    applyChainCommand(chain, { kind: 'approve_decision', decisionId, comment: '同意' }, 'driver'),
  ).toThrow('拍板')
  chain = applyChainCommand(
    chain,
    { kind: 'approve_decision', decisionId, comment: '同意采用 A', selectedAlternativeId: 'a' },
    'approver',
  )
  expect(chain.decisions[0]!.status).toBe('decided')
  expect(chain.decisions[0]!.approvedBy).toBe('approver')
  expect(chain.decisionHistory[0]!.status).toBe('decided')
  chain = applyChainCommand(
    chain,
    {
      kind: 'decision',
      decisionId,
      title: '选择供应商',
      rationale: '补充风险',
      evidence: '报价单 A、B、风险清单',
      changeReason: '新增风险信息',
    },
    'driver',
  )
  expect(chain.decisions[0]!.status).toBe('candidate')
  expect(chain.decisions[0]!.supersedes).toEqual({ id: decisionId, version: 1 })
  expect(chain.decisionHistory.find((item) => item.version === 1)?.status).toBe('superseded')
  expect(chain.decisions[0]!.assumptions).toEqual(['交付周期不超过 30 天'])
  expect(chain.decisions[0]!.sourceRefs).toEqual([
    {
      sourceType: 'meeting',
      sourceId: 'meeting-2026-09-09',
      locator: 'paragraph:42',
      checksum: 'sha256:abc123',
    },
  ])
})

test('启用 DoD 后，任务交付必须逐项验收才能作为完成依据', () => {
  let chain = applyChainCommand(
    emptyProjectChain(),
    { kind: 'set_project_dod', criteria: ['来源可追溯'] },
    'local-user',
  )
  chain = applyChainCommand(
    chain,
    { kind: 'set_task_dod', taskId: 'task-1', criteria: ['交付 PDF'] },
    'local-user',
  )
  chain = applyChainCommand(
    chain,
    { kind: 'decision', title: '范围', rationale: '范围 A', evidence: '会议' },
    'local-user',
  )
  chain = applyChainCommand(
    chain,
    {
      kind: 'draft',
      title: '报告',
      taskId: 'task-1',
      content: '报告说明',
      criteria: '见 DoD',
      recipient: 'local-user',
      responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' },
      decisionIds: [chain.decisions[0]!.id],
    },
    'local-user',
  )
  const draftId = chain.drafts[0]!.id
  chain = applyChainCommand(chain, { kind: 'submit', draftId }, 'local-user')
  expect(() =>
    applyChainCommand(
      chain,
      { kind: 'accept', draftId, comment: '通过', evidence: 'review:1', completedCriteria: ['来源可追溯'] },
      'local-user',
    ),
  ).toThrow('DoD')
  chain = applyChainCommand(
    chain,
    {
      kind: 'accept',
      draftId,
      comment: '逐项通过',
      evidence: 'review:1',
      completedCriteria: ['来源可追溯', '交付 PDF'],
    },
    'local-user',
  )
  expect(chain.drafts[0]!.acceptedCriteria).toEqual(['来源可追溯', '交付 PDF'])
  expect(() => assertTaskCompletionAllowed(chain, 'task-1')).not.toThrow()
  expect(() => assertTaskCompletionAllowed(chain, 'other-task')).toThrow('DoD')
})

test('自动验收未通过确定性验证时保持待验收且不能完成任务', () => {
  let chain = applyChainCommand(
    emptyProjectChain(),
    { kind: 'set_task_dod', taskId: 'task-1', criteria: ['存在成果引用'] },
    'local-user',
  )
  expect(() =>
    applyChainCommand(
      chain,
      {
        kind: 'set_task_dod_auto_acceptance',
        taskId: 'task-1',
        enabled: true,
        riskLevel: 'low',
        rules: [],
      },
      'local-user',
    ),
  ).toThrow('每项 DoD')
  chain = applyChainCommand(
    chain,
    {
      kind: 'set_task_dod_auto_acceptance',
      taskId: 'task-1',
      enabled: true,
      riskLevel: 'low',
      rules: [{ criterion: '存在成果引用', verifier: 'artifact_reference_present' }],
    },
    'local-user',
  )
  chain = applyChainCommand(
    chain,
    { kind: 'decision', title: '范围', rationale: '范围 A', evidence: '需求单' },
    'local-user',
  )
  chain = applyChainCommand(
    chain,
    {
      kind: 'draft',
      taskId: 'task-1',
      title: '未附成果的报告',
      content: '报告说明',
      criteria: '按 DoD',
      recipient: 'local-user',
      responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' },
      decisionIds: [chain.decisions[0]!.id],
    },
    'local-user',
  )
  chain = applyChainCommand(
    chain,
    { kind: 'submit', draftId: chain.drafts[0]!.id },
    'local-user',
  )
  expect(chain.drafts[0]!.status).toBe('submitted')
  expect(chain.drafts[0]!.dodCheckResults?.[0]).toMatchObject({
    criterion: '存在成果引用',
    status: 'failed',
    mode: 'automatic',
    verifier: 'artifact_reference_present',
  })
  expect(() => assertTaskCompletionAllowed(chain, 'task-1')).toThrow('DoD')
})

test('项目管理员可以配置用于流动监控的服务水平预期', () => {
  const chain = applyChainCommand(
    emptyProjectChain(),
    { kind: 'set_flow_policy', serviceLevelDays: 5 },
    'local-user',
  )
  expect(chain.serviceLevelDays).toBe(5)
  expect(() =>
    applyChainCommand(chain, { kind: 'set_flow_policy', serviceLevelDays: 0 }, 'local-user'),
  ).toThrow('服务水平')
})

test('依赖交接契约要约和接收分别由上下游责任人确认', () => {
  let chain = applyChainCommand(
    emptyProjectChain(),
    {
      kind: 'define_dependency_handoff',
      dependencyId: 'dep-1',
      upstreamTaskId: 'build',
      downstreamTaskId: 'test',
      need: '可测试构建包',
      providerId: 'provider',
      consumerId: 'consumer',
      dueAt: Date.now() + 86_400_000,
      criteria: ['包含发布说明'],
    },
    'provider',
  )
  expect(() =>
    applyChainCommand(
      chain,
      { kind: 'accept_dependency_handoff', dependencyId: 'dep-1', comment: '收到' },
      'consumer',
    ),
  ).toThrow('要约')
  chain = applyChainCommand(
    chain,
    { kind: 'offer_dependency_handoff', dependencyId: 'dep-1', comment: 'build:42 可供测试' },
    'provider',
  )
  expect(() =>
    applyChainCommand(
      chain,
      { kind: 'accept_dependency_handoff', dependencyId: 'dep-1', comment: '收到', completedCriteria: ['包含发布说明'] },
      'provider',
    ),
  ).toThrow('下游')
  expect(() =>
    applyChainCommand(
      chain,
      { kind: 'accept_dependency_handoff', dependencyId: 'dep-1', comment: '收到' },
      'consumer',
    ),
  ).toThrow('接收标准')
  chain = applyChainCommand(
    chain,
    { kind: 'accept_dependency_handoff', dependencyId: 'dep-1', comment: '校验发布说明后接收', completedCriteria: ['包含发布说明'] },
    'consumer',
  )
  expect(chain.dependencyHandoffs[0]!.status).toBe('accepted')
  expect(chain.dependencyHandoffs[0]!.acceptedCriteria).toEqual(['包含发布说明'])
})

test('责任未明确的历史交付物不能提交验收', () => {
  let chain = applyChainCommand(
    emptyProjectChain(),
    { kind: 'decision', title: '范围', rationale: '范围 A', evidence: '会议' },
    'local-user',
  )
  chain = applyChainCommand(
    chain,
    {
      kind: 'draft',
      title: '交付',
      taskId: 'task',
      content: '说明',
      criteria: '通过测试',
      recipient: '接收人',
      decisionIds: [chain.decisions[0]!.id],
    },
    'local-user',
  )
  expect(() =>
    applyChainCommand(chain, { kind: 'submit', draftId: chain.drafts[0]!.id }, 'local-user'),
  ).toThrow('责任')
})

test('交接必须先由负责人发起，接收人不能跳过发起直接确认', () => {
  let chain = applyChainCommand(
    emptyProjectChain(),
    { kind: 'decision', title: '范围', rationale: '范围 A', evidence: '会议' },
    'owner',
  )
  chain = applyChainCommand(
    chain,
    {
      kind: 'draft',
      title: '交付',
      taskId: 'task',
      content: '说明',
      criteria: '通过测试',
      recipient: '接收人',
      responsibilities: { ownerId: 'owner', reviewerId: 'reviewer', recipientId: 'receiver' },
      decisionIds: [chain.decisions[0]!.id],
    },
    'owner',
  )
  const draftId = chain.drafts[0]!.id
  expect(() => applyChainCommand(chain, { kind: 'submit', draftId }, 'reviewer')).toThrow('权限')
  chain = applyChainCommand(chain, { kind: 'submit', draftId }, 'owner')
  expect(() =>
    applyChainCommand(chain, { kind: 'accept', draftId, comment: '口头通过' }, 'reviewer'),
  ).toThrow('验收依据')
  chain = applyChainCommand(
    chain,
    { kind: 'accept', draftId, comment: '逐项符合', evidence: 'test-run:123' },
    'reviewer',
  )
  expect(() => applyChainCommand(chain, { kind: 'handoff', draftId, comment: '收到' }, 'receiver')).toThrow(
    '发起',
  )
  chain = applyChainCommand(chain, { kind: 'request_handoff', draftId, comment: '交付包 v1' }, 'owner')
  expect(() => applyChainCommand(chain, { kind: 'handoff', draftId, comment: '收到' }, 'owner')).toThrow(
    '权限',
  )
  chain = applyChainCommand(chain, { kind: 'handoff', draftId, comment: '核对交付包并接收' }, 'receiver')
  expect(chain.drafts[0]!.status).toBe('handed_off')
  expect(chain.events.find((event) => event.action === 'accept')?.evidence).toBe('test-run:123')
  const saved = chain.drafts[0]!
  expect(() =>
    applyChainCommand(
      chain,
      { kind: 'draft', draftId, ...saved, decisionIds: saved.decisions.map((item) => item.id) },
      'owner',
    ),
  ).toThrow('变更原因')
  chain = applyChainCommand(
    chain,
    {
      kind: 'draft',
      draftId,
      ...saved,
      changeReason: '修复遗漏',
      decisionIds: saved.decisions.map((item) => item.id),
    },
    'owner',
  )
  chain = applyChainCommand(chain, { kind: 'submit', draftId }, 'owner')
  chain = applyChainCommand(chain, { kind: 'reject', draftId, comment: '遗漏边界情况' }, 'reviewer')
  expect(() => applyChainCommand(chain, { kind: 'submit', draftId }, 'owner')).toThrow('不能提交')
  expect(chain.events.find((event) => event.action === 'handoff')?.version).toBe(1)
  expect(chain.drafts[0]!.version).toBe(2)
})
