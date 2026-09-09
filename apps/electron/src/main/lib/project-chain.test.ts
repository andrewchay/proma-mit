import { expect, test } from 'bun:test'
import { applyChainCommand, emptyProjectChain } from './project-chain'

test('代码交付保留成果引用与说明，验收及交接不要求写作正文', () => {
  let chain = applyChainCommand(
    emptyProjectChain(),
    {
      kind: 'decision',
      changeReason: '范围调整',
      title: '实现方案',
      rationale: '按方案 B 实现',
      evidence: '评审记录 7',
    },
    'local-user',
  )
  const command = {
    kind: 'draft' as const,
    title: '接口实现',
    taskId: 'task-code',
    content: '已实现接口并通过集成测试',
    artifactRef: 'git:commit-a#src/api.ts',
    criteria: '接口契约与测试通过',
    recipient: '测试负责人',
    responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' },
    decisionIds: [chain.decisions[0]!.id],
  }
  chain = applyChainCommand(chain, command, 'local-user')
  const draftId = chain.drafts[0]!.id
  chain = applyChainCommand(chain, { kind: 'submit', draftId }, 'local-user')
  chain = applyChainCommand(
    chain,
    { kind: 'accept', evidence: 'test-run:123', draftId, comment: '契约测试通过' },
    'local-user',
  )
  chain = applyChainCommand(chain, { kind: 'request_handoff', draftId, comment: '交接说明' }, 'local-user')
  chain = applyChainCommand(
    chain,
    { kind: 'handoff', draftId, comment: '测试负责人已接收提交 commit-a' },
    'local-user',
  )
  expect(chain.drafts[0]!.artifactRef).toBe(command.artifactRef)
  chain = applyChainCommand(
    chain,
    { ...command, draftId, changeReason: '复核变更', artifactRef: 'git:commit-b#src/api.ts' },
    'local-user',
  )
  expect(chain.draftHistory[0]!.artifactRef).toBe(command.artifactRef)
  expect(chain.drafts[0]!.status).toBe('draft')
})

test('未提交的交付物不能验收，修改已验收交付物必须创建新版本', () => {
  let chain = applyChainCommand(
    emptyProjectChain(),
    { kind: 'decision', changeReason: '范围调整', title: '范围', rationale: '范围 A', evidence: '会议' },
    'local-user',
  )
  const command = {
    kind: 'draft' as const,
    title: '交付物',
    taskId: 'task',
    content: '交付说明',
    criteria: '完整',
    recipient: '编辑',
    responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' },
    decisionIds: [chain.decisions[0]!.id],
  }
  chain = applyChainCommand(chain, command, 'local-user')
  const draftId = chain.drafts[0]!.id
  expect(() =>
    applyChainCommand(
      chain,
      { kind: 'accept', evidence: 'test-run:123', draftId, comment: '通过' },
      'local-user',
    ),
  ).toThrow()
  chain = applyChainCommand(chain, { kind: 'submit', draftId }, 'local-user')
  chain = applyChainCommand(
    chain,
    { kind: 'accept', evidence: 'test-run:123', draftId, comment: '符合标准' },
    'local-user',
  )
  const edited = applyChainCommand(
    chain,
    { ...command, draftId, changeReason: '复核变更', content: '新交付说明' },
    'local-user',
  )
  expect(edited.drafts[0]!.status).toBe('draft')
  expect(edited.drafts[0]!.version).toBe(2)
  expect(chain.drafts[0]!.status).toBe('accepted')
  expect(edited.events.find((event) => event.action === 'accept')!.version).toBe(1)
})

test('决策更新后，已验收交付物必须重新复核才能交接', () => {
  let chain = emptyProjectChain()
  chain = applyChainCommand(
    chain,
    {
      kind: 'decision',
      changeReason: '范围调整',
      title: '发布方案',
      rationale: '采用方案 A',
      evidence: '会议纪要第 2 段',
    },
    'local-user',
  )
  const decisionId = chain.decisions[0]!.id
  chain = applyChainCommand(
    chain,
    {
      kind: 'draft',
      title: '发布稿',
      taskId: 'task-1',
      content: '方案 A 交付说明',
      criteria: '与已确认方案一致',
      recipient: '产品负责人',
      responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' },
      decisionIds: [decisionId],
    },
    'local-user',
  )
  const draftId = chain.drafts[0]!.id
  chain = applyChainCommand(chain, { kind: 'submit', draftId }, 'local-user')
  chain = applyChainCommand(
    chain,
    { kind: 'accept', evidence: 'test-run:123', draftId, comment: '验收条件已满足' },
    'local-user',
  )
  chain = applyChainCommand(
    chain,
    {
      kind: 'decision',
      changeReason: '范围调整',
      decisionId,
      title: '发布方案',
      rationale: '改用方案 B',
      evidence: '会议纪要第 3 段',
    },
    'local-user',
  )
  expect(chain.drafts[0]!.status).toBe('needs_review')
  expect(() =>
    applyChainCommand(chain, { kind: 'handoff', draftId, comment: '接收' }, 'local-user'),
  ).toThrow()
  expect(chain.events.some((event) => event.action === 'accept')).toBe(true)
})
