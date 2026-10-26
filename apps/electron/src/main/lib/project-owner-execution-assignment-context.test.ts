import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OwnerExecutionAssignmentCandidate, ProjectOwnerPlanDraft, ProjectOwnerPlanningContext } from '@gravitas/shared'
import { createOwnerExecutionAssignmentContext } from './project-owner-execution-assignment-context'

const plan: ProjectOwnerPlanDraft = {
  projectId: 'p', schemaVersion: 1, revision: 2, planVersion: 1, goalRevision: 1, goalVersion: 1, state: 'confirmed', actor: 'local-user', origin: 'manual', savedAt: 1, changeReason: '确认', contextFingerprint: 'a'.repeat(64), planFingerprint: 'b'.repeat(64),
  sources: { project: { id: 'p', title: '项目', description: '项目目标' }, roles: [{ key: 'research', name: '研究岗位', version: '1', sourceSha256: 'c'.repeat(64), rulesSha256: 'd'.repeat(64) }, { key: 'design', name: '设计岗位', version: '1', sourceSha256: 'e'.repeat(64), rulesSha256: 'f'.repeat(64) }] },
  proposal: { projectId: 'p', goalVersion: 1, mode: 'proposal_only', summary: '已确认方案', assumptions: [], risks: [], steps: [
    { key: 's1', title: '研究', outcome: '研究报告', acceptanceCriteria: ['有来源'], roleKey: 'research', dependencies: [] },
    { key: 's2', title: '设计', outcome: '原型', acceptanceCriteria: ['可预览'], roleKey: 'design', dependencies: ['s1'] },
  ] },
}
const context: ProjectOwnerPlanningContext = {
  goal: { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1, goal: { projectId: 'p', goalVersion: 1, objective: '完成体验升级', constraints: ['保持兼容'], acceptanceCriteria: ['用户审核'] } },
  sources: { project: { id: 'p', title: '项目', description: '项目目标' }, roles: plan.sources.roles }, fingerprint: 'a'.repeat(64),
}
const employee = (id: string, roleTemplateId: string, profile: 'controlled' | 'development' = 'controlled'): OwnerExecutionAssignmentCandidate => ({
  id, name: id, role: roleTemplateId, roleTemplateId, description: '资料', skills: ['研究'], totalTasks: 4, completedTasks: 3, failureCount: 1,
  executionProfile: profile, workspaceIds: ['w1', 'w2'], channelId: 'c', modelId: 'm', runtime: 'ai-sdk',
})
const create = (patch: Partial<Parameters<typeof createOwnerExecutionAssignmentContext>[0]> = {}) => createOwnerExecutionAssignmentContext({
  context, plan, teamContractVersion: 2, projectTitle: '项目', projectDescription: '项目说明', workspaces: [{ id: 'w1', name: '研究工作区', capabilities: ['mcp:search'] }, { id: 'w2', name: '研发工作区' }],
  ownerCarrierId: 'owner', ownerName: '项目Owner', bindingRevision: 2, ownerDefaults: { workspaceId: 'w1', channelId: 'c', modelId: 'm', runtime: 'ai-sdk' },
  candidates: [employee('researcher', 'research'), employee('designer', 'design'), employee('reviewer', 'reviewer'), employee('developer', 'developer', 'development')], ...patch,
})

test('Given 当前计划与项目候选 When 构造Owner安排上下文 Then 只暴露当前需要的步骤、项目工作区和团队资料', () => {
  const value = create()
  expect(value.steps.map(step => step.key)).toEqual(['s1', 's2'])
  expect(value.workspaces.map(workspace => workspace.id)).toEqual(['w1', 'w2'])
  expect(value.candidates.map(candidate => candidate.id)).toEqual(['designer', 'developer', 'researcher', 'reviewer'])
  expect(value).not.toHaveProperty('apiKey')
  expect(value.candidates[0]).not.toHaveProperty('systemPrompt')
  expect(value.contextFingerprint).toMatch(/^[a-f0-9]{64}$/)
})
test('Given 一个候选成员能力更新 When 重建Owner安排上下文 Then 指纹变化使旧提案失效', () => {
  const before = create()
  const after = create({ candidates: [employee('researcher', 'research'), { ...employee('designer', 'design'), skills: ['交互设计'] }, employee('reviewer', 'reviewer'), employee('developer', 'developer', 'development')] })
  expect(after.contextFingerprint).not.toBe(before.contextFingerprint)
})
test('Given 只有一个普通员工或没有项目工作区 When 构造上下文 Then 不生成无法独立评审的安排Run', () => {
  expect(() => create({ candidates: [employee('only', 'research')] })).toThrow('独立检查成果')
  expect(() => create({ workspaces: [] })).toThrow('授权工作区')
})
test('Given 待审方案或岗位候选缺失 When 构造内部安排上下文 Then 可准备方案建议但停止不完整候选', () => {
  expect(create({ plan: { ...plan, state: 'proposed' } as ProjectOwnerPlanDraft }).steps.map(step => step.key)).toEqual(['s1', 's2'])
  expect(() => create({ plan: { ...plan, proposal: { ...plan.proposal, steps: [] } } })).toThrow('当前有效版本')
})


test('Given没有岗位模板的现有普通员工 When按v2生成安排资料 Then保留原profile与能力事实、只开放明确受控适配', () => {
  const general = (id: string): OwnerExecutionAssignmentCandidate => ({ ...employee(id, 'legacy'), roleTemplateId: undefined, executionProfile: 'general', ownerControlledCompatible: true })
  const value = create({ candidates: [general('worker'), general('checker')] })
  expect(value.teamContractVersion).toBe(2)
  expect(value.executionKinds).toEqual(['controlled'])
  expect(value.candidates.every(item => item.executionProfile === 'general' && item.ownerControlledCompatible)).toBe(true)
  expect(() => create({ candidates: [general('worker'), general('checker')], teamContractVersion: 1 })).toThrow('没有可用执行人员')
  expect(() => create({ candidates: [{ ...general('worker'), ownerControlledCompatible: undefined }, general('checker')] })).toThrow('独立检查成果')
  const legacy = create({ teamContractVersion: 1 })
  expect(legacy).not.toHaveProperty('teamContractVersion')
  const protocol = require('./project-owner-execution-assignment-protocol') as typeof import('./project-owner-execution-assignment-protocol')
  expect(protocol.buildOwnerExecutionAssignmentRequest(legacy).systemPrompt).toContain('独立评审必须来自 reviewer 或 delivery-verifier 岗位')
  const prompt = protocol.buildOwnerExecutionAssignmentRequest(value).systemPrompt
  expect(prompt).toContain('不能仅因模板ID不同拒绝现有员工')
  expect(prompt).toContain('该员工ID绝不能出现在assignments中，包括delivery-verifier岗位')
  expect(prompt).toContain('可由同一位非评审员工承担多个执行岗位')
  expect(prompt).toContain('reviewerEmployeeId与所有assignments.employeeId互不相同')
})


test('Givenv3已审核的不同模型员工 When冻结团队 Then保持各自配置、不纳入未审核候选且旧v2形状不变', () => {
  const worker = { ...employee('worker', 'research'), ownerMixedRuntimeCompatible: true as const }
  const checker = { ...employee('checker', 'reviewer'), ownerMixedRuntimeCompatible: true as const, channelId: 'other-channel', modelId: 'other-model' }
  const value = create({ teamContractVersion: 3, candidates: [worker, checker, employee('unknown', 'design')] })
  expect(value.teamContractVersion).toBe(3)
  expect(value.candidates.map(item => item.id)).toEqual(['checker', 'worker'])
  expect(value.candidates[0]).toMatchObject({ channelId: 'other-channel', modelId: 'other-model', ownerMixedRuntimeCompatible: true })
  const old = create({ teamContractVersion: 2, candidates: [worker, checker] })
  expect(old.candidates.every(item => !('ownerMixedRuntimeCompatible' in item))).toBe(true)
})

test('Given空仓库没有计划源码引用 When构建安排上下文 Then不向模型开放development执行方式', () => {
  const worker = { ...employee('worker', 'developer', 'development'), ownerControlledCompatible: true as const, ownerMixedRuntimeCompatible: true as const }
  const reviewer = { ...employee('reviewer', 'reviewer', 'controlled'), ownerMixedRuntimeCompatible: true as const }
  const value = create({ teamContractVersion: 3, candidates: [worker, reviewer] })
  expect(value.executionKinds).toEqual(['controlled'])
})

test('Given冻结代码文件被当前步骤引用 When构建安排上下文 Then保留development执行方式', () => {
  const codeFile = { path: 'src/game.ts', sha256: '1'.repeat(64), matchedTerms: [], excerpts: [] }
  const codedPlan = {
    ...plan,
    sources: { ...plan.sources, code: { workspaceId: 'w1', rootFingerprint: '2'.repeat(64), filesScanned: 1, truncated: false, files: [codeFile] } },
    proposal: { ...plan.proposal, steps: plan.proposal.steps.map((step, index) => index === 0
      ? { ...step, sourceReferences: [{ path: codeFile.path, line: 1, sha256: codeFile.sha256 }] }
      : step) },
  } as ProjectOwnerPlanDraft
  const worker = { ...employee('worker', 'developer', 'development'), ownerControlledCompatible: true as const, ownerMixedRuntimeCompatible: true as const }
  const reviewer = { ...employee('reviewer', 'reviewer', 'controlled'), ownerMixedRuntimeCompatible: true as const }
  const value = create({ plan: codedPlan, teamContractVersion: 3, candidates: [worker, reviewer] })
  expect(value.executionKinds).toEqual(['controlled', 'development'])
})

test('Given 旧安排请求与新岗位覆盖提示 When 恢复冻结来源 Then 按完整hash还原且不改旧提示', async () => {
  const { createHash } = await import('node:crypto')
  const protocol = await import('./project-owner-execution-assignment-protocol')
  const value = create()
  for (const strict of [true, false]) {
    const request = protocol.buildOwnerExecutionAssignmentRequest(value, strict)
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    expect(protocol.resolveOwnerExecutionAssignmentRequest(value, hash)).toEqual(request)
    expect(request.systemPrompt.includes('每个岗位恰好一项')).toBe(strict)
  }
  expect(() => protocol.resolveOwnerExecutionAssignmentRequest(value, 'f'.repeat(64))).toThrow('不属于已知格式')
})

test('Given 无代码候选但工作区是git仓库 When 构造上下文 Then 提供development并标记绿地', () => {
  const repo = mkdtempSync(join(tmpdir(), 'owner-greenfield-repo-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo })
    // 研发交付基线取自 HEAD：必须有首个提交才会被判定为可用绿地仓库。
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
    const value = create({
      teamContractVersion: 2,
      workspaces: [{ id: 'w1', name: '研究工作区', rootPath: repo }, { id: 'w2', name: '研发工作区', rootPath: repo }],
    })
    expect(value.executionKinds).toContain('development')
    expect(value.greenfieldDevelopment).toBe(true)
    expect(value.codeFiles).toBeUndefined()
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('Given 无代码候选且工作区不是git仓库 When 构造上下文 Then 不提供development（研发交付依赖worktree快照）', () => {
  const plain = mkdtempSync(join(tmpdir(), 'owner-greenfield-plain-'))
  try {
    const value = create({
      teamContractVersion: 2,
      workspaces: [{ id: 'w1', name: '研究工作区', rootPath: plain }, { id: 'w2', name: '研发工作区', rootPath: plain }],
    })
    expect(value.executionKinds).not.toContain('development')
    expect(value.greenfieldDevelopment).toBeUndefined()
  } finally { rmSync(plain, { recursive: true, force: true }) }
})

test('Given 只有git init没有首个提交 When 构造上下文 Then 不提供development（交付基线缺失）', () => {
  const empty = mkdtempSync(join(tmpdir(), 'owner-greenfield-empty-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: empty })
    const value = create({
      teamContractVersion: 2,
      workspaces: [{ id: 'w1', name: '研究工作区', rootPath: empty }, { id: 'w2', name: '研发工作区', rootPath: empty }],
    })
    expect(value.executionKinds).not.toContain('development')
    expect(value.greenfieldDevelopment).toBeUndefined()
  } finally { rmSync(empty, { recursive: true, force: true }) }
})
