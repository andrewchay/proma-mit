import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentExitPlanService } from './agent-exit-plan-service'

describe('AgentExitPlanService 计划文档审批', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  test('缺少有效 planFile 时拒绝提交且不展示审批 UI', async () => {
    const service = new AgentExitPlanService()
    let sent = false
    let requestId = ''
    const resultPromise = service.handleExitPlanMode(
      'session-1',
      { summary: '实施计划' },
      new AbortController().signal,
      (request) => { sent = true; requestId = request.requestId },
      { planDirectory: '/missing/plan' },
    )
    if (requestId) service.respondToExitPlanMode({ requestId, action: 'deny' })
    const result = await resultPromise

    expect(result.behavior).toBe('deny')
    expect(sent).toBe(false)
  })

  test('审批期间计划内容变化时拒绝执行', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gravitas-plan-service-'))
    directories.push(root)
    const planDirectory = join(root, '.context', 'plan')
    mkdirSync(planDirectory, { recursive: true })
    const planFile = join(planDirectory, 'implementation.md')
    writeFileSync(planFile, '# 初始计划\n')
    const service = new AgentExitPlanService()
    let requestId = ''
    const resultPromise = service.handleExitPlanMode(
      'session-1',
      { summary: '实施计划', planFile },
      new AbortController().signal,
      (request) => { requestId = request.requestId },
      { planDirectory },
    )
    writeFileSync(planFile, '# 已修改计划\n')

    const response = service.respondToExitPlanMode({ requestId, action: 'approve_auto' })
    const result = await resultPromise

    expect(response?.targetMode).toBeNull()
    expect(result).toEqual({ behavior: 'deny', message: '计划文档在审批期间已变更，请重新提交计划审批' })
  })
})

describe('AgentExitPlanService 已批准计划覆盖判断（计划外提示）', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  /** 构造带有效计划文档的审批场景，返回服务、会话 ID 与提交审批的辅助函数 */
  async function approvePlan(service: AgentExitPlanService, toolInput: Record<string, unknown>, action: 'approve_auto' | 'approve_edit' = 'approve_auto'): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'gravitas-plan-cover-'))
    directories.push(root)
    const planDirectory = join(root, '.context', 'plan')
    mkdirSync(planDirectory, { recursive: true })
    const planFile = join(planDirectory, 'implementation.md')
    writeFileSync(planFile, '# 计划\n')
    let requestId = ''
    const resultPromise = service.handleExitPlanMode(
      'session-x',
      { summary: '实施计划', planFile, ...toolInput },
      new AbortController().signal,
      (request) => { requestId = request.requestId },
      { planDirectory },
    )
    service.respondToExitPlanMode({ requestId, action })
    await resultPromise
  }

  test('无已批准计划记录时不提示（视为覆盖）', () => {
    const service = new AgentExitPlanService()
    expect(service.isToolCoveredByApprovedPlan('session-x', 'Bash')).toBe(true)
  })

  test('批准后计划涉及的工具被覆盖，未涉及的工具不覆盖', async () => {
    const service = new AgentExitPlanService()
    await approvePlan(service, { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] })

    expect(service.isToolCoveredByApprovedPlan('session-x', 'Bash')).toBe(true)
    expect(service.isToolCoveredByApprovedPlan('session-x', 'Write')).toBe(false)
    // 其他会话不受影响
    expect(service.isToolCoveredByApprovedPlan('session-y', 'Bash')).toBe(true)
  })

  test('clearSessionPlan 清除记录后恢复为不提示', async () => {
    const service = new AgentExitPlanService()
    await approvePlan(service, { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] }, 'approve_edit')
    expect(service.isToolCoveredByApprovedPlan('session-x', 'Bash')).toBe(true)

    service.clearSessionPlan('session-x')
    expect(service.isToolCoveredByApprovedPlan('session-x', 'Write')).toBe(true)
  })
})
