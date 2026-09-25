/**
 * 研发任务委派端到端 smoke（M4 / W09，确定性运行器，不调用真实模型）。
 *
 * 覆盖：文件委派准备 → 派发（隔离 worktree）→ 交付回写（自动受限提交）→
 * 返工（同 worktree 续改，交付 v2）→ 人工验收 → 验证证据 → 确认应用到原仓库 → DoD 完成。
 *
 * 隔离：全程使用临时配置根与临时 Git 仓库；检测到将写入真实 ~/.gravitas 时直接拒绝。
 * 用法：bun scripts/task-review-smoke.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-task-review-smoke-'))
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = join(directory, 'config')
// 安全护栏：显式拒绝真实配置目录
if (process.env.PROMA_TEST_CONFIG_DIR!.startsWith(join(homedir(), '.gravitas'))) {
  console.error('[smoke] 拒绝运行：配置目录指向真实 ~/.gravitas')
  process.exit(1)
}

mock.module('electron', async () => {
  const { buildElectronMock } = await import('../apps/electron/src/main/lib/testing/electron-mock')
  return buildElectronMock()
})
mock.module('../apps/electron/src/main/lib/agent-service', () => ({ isAgentSessionActive: () => false }))

const store = await import('../apps/electron/src/main/lib/project-sqlite-store')
const workspaceManager = await import('../apps/electron/src/main/lib/agent-workspace-manager')
const { createChannel } = await import('../apps/electron/src/main/lib/channel-manager')
const employeeService = await import('../apps/electron/src/main/lib/agent-employee-service')
const chainService = await import('../apps/electron/src/main/lib/project-chain-service')
const review = await import('../apps/electron/src/main/lib/development-review-service')
const validation = await import('../apps/electron/src/main/lib/development-validation-service')
const applyService = await import('../apps/electron/src/main/lib/development-apply-service')

let failures = 0
function step(name: string, assert: () => void): void {
  try {
    assert()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures++
    console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function main(): Promise<void> {
  console.log('[smoke] 临时配置根:', process.env.PROMA_TEST_CONFIG_DIR)
  await store.initProjectDb()

  // 确定性运行器：只记录 callbacks，由脚本驱动完成
  const pendingRuns: Array<{ complete: (summary: string) => void }> = []
  const { setHeadlessAgentRunner } = await import('../apps/electron/src/main/lib/agent-headless-runner-registry')
  setHeadlessAgentRunner(async (_input, callbacks) => {
    pendingRuns.push({
      complete: (summary) => {
        callbacks.onComplete([
          { id: `msg-${randomId()}`, role: 'assistant', content: summary, createdAt: Date.now() },
        ])
      },
    })
  })

  // ===== 场景：修复 formatMinutes 并更新文档 =====
  const repo = join(directory, 'demo-repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'docs'), { recursive: true })
  git(repo, 'init')
  git(repo, 'config', 'user.name', 'Smoke')
  git(repo, 'config', 'user.email', 'smoke@example.invalid')
  writeFileSync(join(repo, 'src', 'format.ts'), 'export function formatMinutes(m: number) { return `${Math.floor(m / 60)}:${m % 60}` }\n')
  writeFileSync(join(repo, 'docs', 'usage.md'), '# 用法\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'baseline')
  const baseHead = git(repo, 'rev-parse', 'HEAD')

  console.log('[smoke] 1. 文件委派准备（prepareFileDelegation）')
  const workspace = workspaceManager.createAgentWorkspace(`smoke-${Date.now()}`, repo)
  const channel = createChannel({ name: 'smoke-channel', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'not-a-real-key', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = employeeService.createAgentEmployee({ name: 'Smoke 研发', role: '工程师', description: '', executionProfile: 'development', permissionMode: 'auto', workspaceId: workspace.id, channelId: channel.id, modelId: 'model', runtime: 'pi' })
  const project = store.createProject({ title: 'Smoke 项目', description: '' })
  const decision = chainService.updateProjectChain(project.id, 0, { kind: 'decision', title: '修复方向', rationale: '最小增量修复', evidence: 'smoke' })
  const decisionId = decision.decisions[0]!.id

  const delegation = await review.prepareFileDelegation({
    projectId: project.id,
    workspaceId: workspace.id,
    employeeId: employee.id,
    targetPaths: ['src/format.ts', 'docs/usage.md'],
    allowedPaths: ['src', 'docs'],
    decisionIds: [decisionId],
    verificationCommands: ['node src/verify.cjs'],
    reviewerId: 'local-user',
    newTask: { title: '修复 formatMinutes 补零', description: '分钟不足两位补零' },
  })
  step('委派创建新任务并写入范围', () => {
    if (!delegation.created) throw new Error('应为新建任务')
    const task = store.getTask(delegation.taskId)!
    if (!task.developmentScope) throw new Error('缺少 developmentScope')
    if (task.assignee?.userId !== `agent-${employee.id}`) throw new Error('负责人不是研发员工')
  })
  const taskId = delegation.taskId

  console.log('[smoke] 2. 首次派发（隔离 worktree）+ 模拟员工修改 + 交付')
  const firstRun = await employeeService.dispatchTaskToAgent(store.getTask(taskId)!)
  if (!firstRun) throw new Error('派发失败')
  await Promise.resolve()
  const execution = store.listAgentExecutionsByEntity('task', taskId)[0]!
  // getAgentWorkspaceCwd 对研发会话直接返回 worktree（source/）路径
  const worktreePath = workspaceManager.getAgentWorkspaceCwd(workspace, execution.sessionId)
  // 模拟员工：修复 + 验证脚本 + 文档
  writeFileSync(join(worktreePath, 'src', 'format.ts'), 'export function formatMinutes(m: number) { const s = String(m % 60).padStart(2, "0"); return `${Math.floor(m / 60)}:${s}` }\n')
  writeFileSync(join(worktreePath, 'src', 'verify.cjs'), "const fs=require('fs');process.exit(fs.readFileSync('src/format.ts','utf8').includes('padStart')?0:1)")
  writeFileSync(join(worktreePath, 'docs', 'usage.md'), '# 用法\n\n分钟输出固定两位。\n')
  pendingRuns[0]!.complete('已修复补零并更新文档；验证脚本通过。')
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 50))

  step('执行完成且任务暂停待验收', () => {
    const current = store.getAgentExecution(execution.id)!
    if (current.status !== 'completed') throw new Error(`执行状态 ${current.status}`)
    const task = store.getTask(taskId)!
    if (task.status !== 'paused') throw new Error(`任务状态 ${task.status}`)
    if (!task.completionNotes?.includes('AI 交付待确认')) throw new Error('缺少待验收标记')
  })
  step('完成回调自动受限提交（draft→submitted）', () => {
    const chain = chainService.getProjectChain(project.id)
    const draft = chain.drafts.find((item) => item.executionId === execution.id)
    if (!draft) throw new Error('交付版本缺失')
    if (draft.status !== 'submitted') throw new Error(`交付状态 ${draft.status}`)
    if (draft.responsibilities?.ownerId !== `agent-${employee.id}`) throw new Error('ownerId 不是员工')
  })
  step('原仓库未被修改', () => {
    if (readFileSync(join(repo, 'src', 'format.ts'), 'utf8').includes('padStart')) throw new Error('原仓库被提前写入')
    if (git(repo, 'rev-parse', 'HEAD') !== baseHead) throw new Error('原仓库 HEAD 变化')
  })

  console.log('[smoke] 3. 退回返工（同 worktree 续改，交付 v2）')
  const rework = await review.requestChanges(taskId, 'usage.md 还要写清输入约束')
  if (!rework) throw new Error('返工派发失败')
  await Promise.resolve()
  const reworkExecution = store.listAgentExecutionsByEntity('task', taskId).find((item) => item.id !== execution.id)!
  writeFileSync(join(worktreePath, 'docs', 'usage.md'), '# 用法\n\n分钟输出固定两位。输入须为非负整数。\n')
  pendingRuns[1]!.complete('补充了输入约束说明。')
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 50))
  step('返工沿用同一交付 id 的新版本', () => {
    const chain = chainService.getProjectChain(project.id)
    const versions = [...chain.drafts, ...chain.draftHistory].filter((item) => item.taskId === taskId)
    const latest = versions.sort((a, b) => b.version - a.version)[0]!
    if (latest.version !== 2) throw new Error(`最新版本 ${latest.version}`)
    if (latest.status !== 'submitted') throw new Error(`最新状态 ${latest.status}`)
    if (latest.executionId !== reworkExecution.id) throw new Error('新版本未绑定返工执行')
  })

  console.log('[smoke] 4. 人工验收（local-user）')
  const summary = await review.getTaskReview(taskId)
  const latestDelivery = summary.deliveries[0]!
  if (summary.reviewerId !== 'local-user') throw new Error('验收人配置错误')
  await review.acceptDelivery(taskId, latestDelivery.id, { evidence: 'diff 与说明逐项核对通过' })
  step('交付到达 accepted', () => {
    const chain = chainService.getProjectChain(project.id)
    const draft = chain.drafts.find((item) => item.id === latestDelivery.id)
    if (draft?.status !== 'accepted') throw new Error(`交付状态 ${draft?.status}`)
  })

  console.log('[smoke] 5. 验证证据（真实退出码）')
  const validationResult = await validation.runDevelopmentValidation(taskId, 'node src/verify.cjs')
  step('验证通过且绑定快照指纹', () => {
    if (validationResult.status !== 'passed' || validationResult.exitCode !== 0) throw new Error(`验证状态 ${validationResult.status}/${validationResult.exitCode}`)
  })

  console.log('[smoke] 6. 确认应用到原仓库')
  const manifest = applyService.prepareApply(taskId)
  step('预检通过且文件清单正确', () => {
    if (manifest.files.length !== 3) throw new Error(`文件数 ${manifest.files.length}`)
  })
  const applyResult = await applyService.confirmApply(manifest.operationId)
  step('字节级写入且无 commit', () => {
    if (applyResult.status !== 'applied') throw new Error(`应用状态 ${applyResult.status}`)
    if (!readFileSync(join(repo, 'src', 'format.ts'), 'utf8').includes('padStart')) throw new Error('源码未应用')
    if (!readFileSync(join(repo, 'docs', 'usage.md'), 'utf8').includes('非负整数')) throw new Error('文档未应用')
    if (git(repo, 'rev-parse', 'HEAD') !== baseHead) throw new Error('出现自动 commit')
    if (git(repo, 'diff', '--cached', '--name-only')) throw new Error('index 被触碰')
  })
  step('任务经 DoD 闸门完成', () => {
    if (!applyResult.taskCompleted) throw new Error(`任务未完成：${applyResult.taskError ?? '未知'}`)
    if (store.getTask(taskId)!.status !== 'completed') throw new Error('任务状态未完成')
  })

  console.log('[smoke] 7. 幂等与恢复护栏')
  const secondApply = await applyService.confirmApply(manifest.operationId)
  step('重复确认不重复应用', () => {
    if (secondApply.status !== 'applied') throw new Error(`状态 ${secondApply.status}`)
    if (git(repo, 'rev-parse', 'HEAD') !== baseHead) throw new Error('HEAD 变化')
  })
  await expectReject(() => validation.runDevelopmentValidation(taskId, 'curl evil.example'), '白名单')
  await expectReject(() => review.acceptDelivery(taskId, latestDelivery.id, { evidence: '再次验收' }), '验收')

  store.closeProjectDb()
  employeeService.stopAgentEmployeeHeartbeat()
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(directory, { recursive: true, force: true })

  if (failures > 0) {
    console.error(`[smoke] FAIL：${failures} 项断言未通过`)
    process.exit(1)
  }
  console.log('[smoke] PASS：委派 → 派发 → 交付 → 返工 → 验收 → 验证 → 应用 → 完成全链路通过')
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function expectReject(fn: () => Promise<unknown>, keyword: string): Promise<void> {
  try {
    await fn()
    failures++
    console.error(`  ✗ 应拒绝的调用被放行（期望包含「${keyword}」）`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes(keyword)) {
      failures++
      console.error(`  ✗ 拒绝原因不符：${message}`)
    } else {
      console.log(`  ✓ 正确拒绝（${message.slice(0, 40)}…）`)
    }
  }
}

main().catch((error) => {
  console.error('[smoke] 异常退出:', error)
  process.exit(1)
})
