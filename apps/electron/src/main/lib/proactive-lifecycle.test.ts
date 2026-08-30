import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoutineInstance, resetRoutineServiceForTests, runRoutineInstance, setRoutineRunner } from './routine-service'
import { approveApproval, getPendingApprovals, setApprovedChangeExecutor } from './approval-service'
import { executeApprovedChange } from './proactive-approved-change-executor'
import { listMemoryItems } from './memory-plugin-service'
import { refreshRecommendations, resetRecommendationServiceForTests } from './recommendation-service'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = await mkdtemp(join(tmpdir(), 'gravitas-proactive-lifecycle-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir

afterAll(async () => {
  resetRoutineServiceForTests()
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  await rm(configDir, { recursive: true, force: true })
})

beforeEach(async () => {
  resetRoutineServiceForTests()
  resetRecommendationServiceForTests()
  await rm(join(configDir, 'proactive'), { recursive: true, force: true })
  setApprovedChangeExecutor((approval) => executeApprovedChange(approval, { createSchedule: () => {} }))
})

describe('Proactive lifecycle', () => {
  test('given a memory Routine result when it is approved then local Memory and its recommendation are produced with no direct model write', async () => {
    const instance = createRoutineInstance({ manifestId: 'proma-memory:memory-daily', title: '每日记忆' })
    expect(instance).not.toBeNull()
    setRoutineRunner(async () => ({
      sessionId: 'session-1',
      outputSummary: '提取一条偏好候选',
      output: '```proma-memory-items\n{"items":[{"title":"语言偏好","content":"用户偏好中文","kind":"preference","tags":["语言"],"confidence":0.9}]}\n```',
    }))

    const run = await runRoutineInstance(instance!.id, {
      sessionId: 'session-1', channelId: 'channel-1', runtime: 'proma', prompt: '仅输出候选，不直接写入记忆', permissionMode: 'safe',
    })
    expect(listMemoryItems()).toHaveLength(0)

    const approval = getPendingApprovals().find((item) => item.runId === run.id)
    expect(approval).toBeDefined()
    expect(await approveApproval(approval!.id)).toEqual(expect.objectContaining({ executionStatus: 'succeeded' }))
    expect(listMemoryItems()).toContainEqual(expect.objectContaining({ title: '语言偏好', kind: 'preference' }))
    expect(refreshRecommendations()).toContainEqual(expect.objectContaining({ duplicateKey: 'memory-daily-suggestion' }))
  })
})
