import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRoutineInstance,
  resetRoutineServiceForTests,
  runRoutineInstance,
  setRoutineRunner,
  submitSOPCandidate,
} from './routine-service'
import { ProactiveSchedulerStore } from './proactive-scheduler-store'
import { getPendingApprovals } from './approval-service'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = await mkdtemp(join(tmpdir(), 'gravitas-routine-service-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir

afterAll(async () => {
  resetRoutineServiceForTests()
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  await rm(configDir, { recursive: true, force: true })
})

beforeEach(async () => {
  resetRoutineServiceForTests()
  await rm(join(configDir, 'proactive'), { recursive: true, force: true })
})

describe('RoutineService', () => {
  test('given an enabled routine with an explicit target when run then its rendered prompt and result are persisted', async () => {
    const instance = createRoutineInstance({ manifestId: 'proma-memory:memory-daily', title: '每日记忆' })
    expect(instance).not.toBeNull()
    setRoutineRunner(async (_receivedInstance, target, prompt) => {
      expect(target.permissionMode).toBe('safe')
      expect(prompt).toContain('整理')
      expect(prompt).toContain('仅汇总事实')
      return {
        outputSummary: '记忆候选已生成',
        sessionId: 'session-1',
        output: '```proma-memory-items\n{"items":[{"title":"输出语言","content":"用户偏好中文","kind":"preference","tags":["语言"],"confidence":0.9}]}\n```',
      }
    })

    const run = await runRoutineInstance(instance!.id, {
      sessionId: 'session-1',
      channelId: 'channel-1',
      runtime: 'proma',
      prompt: '仅汇总事实，不直接写入记忆',
      permissionMode: 'safe',
    })

    expect(run).toMatchObject({ sourceType: 'routine', sourceId: instance!.id, sourceTitle: '每日记忆', status: 'success', outputSummary: '记忆候选已生成' })
    expect(new ProactiveSchedulerStore().listRuns()).toEqual([expect.objectContaining({ id: run.id, sourceType: 'routine' })])
    const memoryApproval = getPendingApprovals().find((approval) => approval.runId === run.id)
    expect(memoryApproval).toEqual(expect.objectContaining({
      runId: run.id,
      sourceType: 'memory',
      proposedChange: expect.objectContaining({ title: '输出语言', kind: 'preference', tags: ['语言'] }),
    }))
  })

  test('given a complete SOP candidate when submitted then it creates a Skill approval instead of writing a file', () => {
    const result = submitSOPCandidate(
      { id: 'sop-1', title: '发布检查', description: '发布前执行', steps: ['检查 CI', '确认版本'], createdAt: Date.now() },
      'workspace-1',
    )
    expect(result?.approvalId).toBeString()
    expect(getPendingApprovals()).toContainEqual(expect.objectContaining({
      id: result?.approvalId,
      sourceType: 'skill',
      proposedChange: expect.objectContaining({ type: 'skill_create', workspaceId: 'workspace-1' }),
    }))
  })

  test('记忆 Routine 运行记录成果阶段与触发来源：候选生成记为 pending_approval，Schedule 包装时继承 trigger 并关联 parentRunId', async () => {
    const instance = createRoutineInstance({ manifestId: 'proma-memory:memory-daily', title: '每日记忆' })
    setRoutineRunner(async () => ({
      outputSummary: '候选已生成',
      sessionId: 'session-1',
      output: '```proma-memory-items\n{"items":[{"title":"语言偏好","content":"用户偏好中文","kind":"preference","tags":["语言"],"confidence":0.9}]}\n```',
    }))

    const run = await runRoutineInstance(instance!.id, {
      sessionId: 'session-1', channelId: 'channel-1', runtime: 'proma', prompt: '整理', permissionMode: 'safe',
    }, 'scheduled', 'parent-run-1')

    expect(run.status).toBe('success')
    // 内层 Routine 继承 Schedule 的真实触发来源，不再伪装为 manual
    expect(run.trigger).toBe('scheduled')
    expect(run.parentRunId).toBe('parent-run-1')
    // 候选已生成：成果阶段必须可追踪
    expect(run.memoryStage).toBe('pending_approval')
    expect(run.memoryCandidates).toBe(1)
  })

  test('记忆 Routine 无输入且无候选时记为 no_input，而不是与「无新记忆」混淆', async () => {
    const instance = createRoutineInstance({ manifestId: 'proma-memory:memory-daily', title: '每日记忆' })
    setRoutineRunner(async () => ({
      outputSummary: '没有可整理内容',
      sessionId: 'session-1',
      output: '```proma-memory-items\n{"items":[]}\n```',
    }))

    const run = await runRoutineInstance(instance!.id, {
      sessionId: 'session-1', channelId: 'channel-1', runtime: 'proma', prompt: '整理', permissionMode: 'safe',
    })

    expect(run.status).toBe('success')
    // 测试环境没有任何会话资料：必须标记 no_input，不能伪装成正常「无新记忆」
    expect(run.memoryStage).toBe('no_input')
    expect(run.memoryCandidates).toBe(0)
    expect(getPendingApprovals().filter((approval) => approval.runId === run.id)).toHaveLength(0)
  })

  test('记忆 Routine 输出包含契约标记但解析不到候选时记为 invalid_output', async () => {
    const instance = createRoutineInstance({ manifestId: 'proma-memory:memory-daily', title: '每日记忆' })
    setRoutineRunner(async () => ({
      outputSummary: '输出异常',
      sessionId: 'session-1',
      output: '```proma-memory-items\n这不是合法 JSON\n```',
    }))

    const run = await runRoutineInstance(instance!.id, {
      sessionId: 'session-1', channelId: 'channel-1', runtime: 'proma', prompt: '整理', permissionMode: 'safe',
    })

    expect(run.status).toBe('success')
    expect(run.memoryStage).toBe('invalid_output')
    expect(run.memoryCandidates).toBe(0)
  })

  test('同标题记忆候选重试时不产生重复审批（幂等）', async () => {
    const instance = createRoutineInstance({ manifestId: 'proma-memory:memory-daily', title: '每日记忆' })
    const output = '```proma-memory-items\n{"items":[{"title":"语言偏好","content":"用户偏好中文","kind":"preference","tags":["语言"],"confidence":0.9}]}\n```'
    setRoutineRunner(async () => ({ outputSummary: '候选', sessionId: 'session-1', output }))
    const target = { sessionId: 'session-1', channelId: 'channel-1', runtime: 'proma' as const, prompt: '整理', permissionMode: 'safe' as const }

    await runRoutineInstance(instance!.id, target)
    await runRoutineInstance(instance!.id, target)

    const memoryApprovals = getPendingApprovals().filter(
      (approval) => approval.sourceType === 'memory'
        && typeof approval.proposedChange === 'object'
        && approval.proposedChange !== null
        && (approval.proposedChange as { type?: string }).type === 'memory_write',
    )
    expect(memoryApprovals.filter((approval) => approval.title === '记忆写入: 语言偏好')).toHaveLength(1)
  })

  test('记忆 Routine 提示词必须包含输出契约与授权资料说明', async () => {
    const instance = createRoutineInstance({ manifestId: 'proma-memory:memory-daily', title: '每日记忆' })
    let capturedPrompt = ''
    setRoutineRunner(async (_receivedInstance, _target, prompt) => {
      capturedPrompt = prompt
      return { outputSummary: 'ok', sessionId: 'session-1', output: '```proma-memory-items\n{"items":[]}\n```' }
    })

    await runRoutineInstance(instance!.id, {
      sessionId: 'session-1', channelId: 'channel-1', runtime: 'proma', prompt: '整理', permissionMode: 'safe',
    })

    expect(capturedPrompt).toContain('proma-memory-items')
    expect(capturedPrompt).toContain('输出要求')
  })
})
