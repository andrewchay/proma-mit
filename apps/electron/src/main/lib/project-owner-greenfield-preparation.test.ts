import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-greenfield-preparation-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))

const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const plans = await import('./project-owner-plan-service')
const prep = await import('./project-owner-execution-preparation')

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  employees.stopAgentEmployeeHeartbeat()
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

/** 建一个带首个提交的 git 仓库工作区：研发交付基线来自 HEAD。 */
function gitRepository(withCommit: boolean): string {
  const repo = mkdtempSync(join(tmpdir(), 'owner-greenfield-repo-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# 空项目\n')
  if (withCommit) {
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'], { cwd: repo })
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: repo })
  }
  return repo
}

/** 绿地准备夹具：目标是本次新建 index.html，验证只用内置断言。 */
function fixture(rootPath: string) {
  const project = store.createProject({ title: '绿地2048', description: '' })
  const workspace = createAgentWorkspace(`owner-greenfield-${randomUUID()}`, rootPath)
  bindWorkspaceToProject(project.id, workspace.id)
  const modelId = 'glm-5.3-flash'
  const channel = createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: modelId, name: modelId, enabled: true }] })
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研发', description: '', executionProfile: 'development', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id] })
  const executor = employee('研发执行者'), reviewer = employee('研发评审')
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '从零做一个可玩的 2048 单页' })
  const context = plans.getProjectOwnerPlanningContext(project.id)
  const steps = [{ key: 'build', title: '实现页面', outcome: '单页文件', acceptanceCriteria: ['可玩'], dependencies: [], roleKey: context.sources.roles[0]!.key }]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '实现单页', assumptions: [], risks: [], steps, changeReason: '建立计划' })
  plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)
  return {
    project,
    subject: { projectId: project.id },
    input: {
      requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null,
      expectedGoalRevision: 1, expectedPlanRevision: 2, selectedStepKeys: ['build'], executionKind: 'development' as const,
      employeeRuntimeVersion: 2 as const, executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id,
      roleAssignments: [{ roleKey: steps[0]!.roleKey, employeeId: executor.id }], workspaceId: workspace.id,
      knowledgeSourceIds: [], maxCostMicros: 500000, maxRuns: 4, maxRework: 1, expiresAt: Date.now() + 3_600_000,
      changeReason: '绿地研发准备',
      developmentScope: { workspaceId: workspace.id, targetPaths: ['index.html'], allowedPaths: ['index.html'], verificationCommands: ['browser:html.loads+dom.board+behavior.merge'] },
    },
  }
}

test('Given 绿地研发范围 When 预览并保存执行准备 Then 不再被文本交付或代码候选挡住', () => {
  const repo = gitRepository(true)
  try {
    const f = fixture(repo)
    const preview = prep.previewOwnerExecutionPreparation(f.subject, f.input)
    // 绿地范围必须原样进入准备来源，而不是被降级为文本交付。
    expect(preview.previewFingerprint).toMatch(/^[a-f0-9]{64}$/)
    const saved = prep.saveOwnerExecutionPreparation(f.subject, f.input, preview.previewFingerprint)
    expect(saved.input.executionKind).toBe('development')
    expect(saved.input.developmentScope?.targetPaths).toEqual(['index.html'])
    expect(saved.input.developmentScope?.verificationCommands).toEqual(['browser:html.loads+dom.board+behavior.merge'])
    // 绿地执行不能退化成完整文本交付，否则 Write/Edit 会被移出工具集。
    expect(saved.input.textDeliveryVersion).toBeUndefined()
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('Given 仓库没有首个提交 When 预览执行准备 Then 明确拒绝而不是留下半启动状态', () => {
  const repo = gitRepository(false)
  try {
    const f = fixture(repo)
    expect(() => prep.previewOwnerExecutionPreparation(f.subject, f.input)).toThrow()
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
