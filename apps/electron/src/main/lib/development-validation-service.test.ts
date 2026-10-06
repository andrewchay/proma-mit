/**
 * M3 / W07：验证证据服务 BDD（T27/T28 + 授权白名单）。
 * 临时真实 Git 仓库与 worktree；验证脚本预置在允许路径内并随交付冻结。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-rd-validate-'))
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = join(directory, 'config')
mock.module('electron', () => buildElectronMock())

const store = await import('./project-sqlite-store')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { getAgentSessionWorkspacePath } = await import('./config-paths')
const sessionManager = await import('./agent-session-manager')
const { createChannel } = await import('./channel-manager')
const service = await import('./agent-employee-service')
const { createDevelopmentWorktree } = await import('./agent-development-worktree')
const chainService = await import('./project-chain-service')
const { submitDevelopmentDelivery } = await import('./development-delivery-service')
const { runDevelopmentValidation, listDevelopmentValidations, DevelopmentValidationError } = await import('./development-validation-service')

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  service.stopAgentEmployeeHeartbeat()
  store.closeProjectDb()
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(directory, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fixture(options: { scriptName?: string; scriptContent?: string } = {}): { taskId: string; executionId: string; worktreePath: string; command: string } {
  const scriptName = options.scriptName ?? 'verify.cjs'
  const scriptContent = options.scriptContent ?? "const fs=require('fs');process.exit(fs.readFileSync('src/a.ts','utf8')==='fixed\\n'?0:1)"
  const command = `node src/${scriptName}`

  const repo = join(directory, `repo-${randomUUID().slice(0, 8)}`); mkdirSync(repo)
  git(repo, 'init'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'original\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'baseline')

  const workspace = createAgentWorkspace(`validate-${randomUUID().slice(0, 6)}`, repo)
  const channel = createChannel({ name: `ch-${randomUUID().slice(0, 6)}`, provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'not-a-real-key', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = service.createAgentEmployee({ name: '研发', role: '工程师', description: '', executionProfile: 'development', permissionMode: 'auto', workspaceId: workspace.id, channelId: channel.id, modelId: 'model', runtime: 'pi' })
  const project = store.createProject({ title: '验证闭环', description: '' })
  const decision = chainService.updateProjectChain(project.id, 0, { kind: 'decision', title: '修复方向', rationale: '最小增量', evidence: 'issue#1' })

  const session = sessionManager.createAgentSession('验证测试', channel.id, workspace.id)
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, session.id)
  const executionId = `exec-${randomUUID()}`
  const worktree = createDevelopmentWorktree(repo, sessionDirectory, executionId)
  writeFileSync(join(worktree.path, 'src', 'a.ts'), 'fixed\n')
  writeFileSync(join(worktree.path, 'src', scriptName), scriptContent)

  const task = store.createTask(project.id, {
    title: '修复 a.ts', description: '',
    developmentScope: {
      workspaceId: workspace.id, targetPaths: ['src/a.ts'], allowedPaths: ['src'],
      reviewerId: 'local-user', decisionIds: [decision.decisions[0]!.id],
      verificationCommands: [command],
    },
    assignee: { userId: `agent-${employee.id}`, displayName: employee.name },
  })
  store.createAgentExecution({ id: executionId, projectId: project.id, entityType: 'task', entityId: task.id, agentId: employee.id, sessionId: session.id, prompt: 'p' })
  store.updateAgentExecution(executionId, { status: 'completed', resultSummary: 'done', completedAt: Date.now() })
  return { taskId: task.id, executionId, worktreePath: worktree.path, command }
}

describe('验证证据（T27/T28）', () => {
  test('Given 白名单命令与匹配内容 When 运行 Then exitCode=0 status=passed', async () => {
    const w = fixture()
    submitDevelopmentDelivery(w.executionId)
    const result = await runDevelopmentValidation(w.taskId, w.command)
    expect(result.status).toBe('passed')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.snapshotContentHash).toBeTruthy()
  })

  test('Given 非零退出 When 运行 Then status=failed 且真实退出码入档', async () => {
    const w = fixture({ scriptContent: 'process.exit(3)' })
    submitDevelopmentDelivery(w.executionId)
    const result = await runDevelopmentValidation(w.taskId, w.command)
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(3)
    expect(listDevelopmentValidations(w.taskId)[0]!.status).toBe('failed')
  })

  test('Given 非白名单命令 When 运行 Then 拒绝', async () => {
    const w = fixture()
    submitDevelopmentDelivery(w.executionId)
    await expect(runDevelopmentValidation(w.taskId, 'rm -rf /')).rejects.toThrow('白名单')
    await expect(runDevelopmentValidation(w.taskId, '  ')).rejects.toThrow('不能为空')
  })

  test('Given 命令修改快照文件 When 完成 Then stale 且不算通过（T28）', async () => {
    const w = fixture({ scriptName: 'mutate.cjs', scriptContent: "const fs=require('fs');fs.writeFileSync('src/a.ts','CHANGED\\n')" })
    submitDevelopmentDelivery(w.executionId)
    const result = await runDevelopmentValidation(w.taskId, w.command)
    expect(result.status).toBe('stale')
  })

  test('Given 超时 When 运行 Then status=timeout 且进程被终止', async () => {
    const w = fixture({ scriptName: 'hang.cjs', scriptContent: 'setInterval(()=>{},1000)' })
    submitDevelopmentDelivery(w.executionId)
    const result = await runDevelopmentValidation(w.taskId, w.command, { timeoutMs: 600 })
    expect(result.status).toBe('timeout')
    expect(result.exitCode).toBeNull()
  }, 20000)

  test('Given 多次运行 When 列表 Then 按时间倒序且记录持久化', async () => {
    const w = fixture()
    submitDevelopmentDelivery(w.executionId)
    await runDevelopmentValidation(w.taskId, w.command)
    await runDevelopmentValidation(w.taskId, w.command)
    const all = listDevelopmentValidations(w.taskId)
    expect(all.length).toBe(2)
    expect(all[0]!.finishedAt).toBeGreaterThanOrEqual(all[1]!.finishedAt)
  })

  test('Given 无已完成执行 When 运行 Then 明确拒绝', async () => {
    const project = store.createProject({ title: '无执行', description: '' })
    await expect(runDevelopmentValidation(store.createTask(project.id, { title: 't', description: '' }).id, 'node x.cjs')).rejects.toThrow(DevelopmentValidationError)
  })
})
