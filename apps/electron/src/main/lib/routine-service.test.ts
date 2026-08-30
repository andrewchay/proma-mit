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

    expect(run).toMatchObject({ sourceType: 'routine', sourceId: instance!.id, status: 'success', outputSummary: '记忆候选已生成' })
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
})
