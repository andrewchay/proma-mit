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
