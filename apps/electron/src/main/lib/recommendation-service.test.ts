import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resetRecommendationServiceForTests,
  runRecommendationEngine,
} from './recommendation-service'

const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configDir = await mkdtemp(join(tmpdir(), 'gravitas-recommendation-service-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir

afterAll(async () => {
  resetRecommendationServiceForTests()
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
  await rm(configDir, { recursive: true, force: true })
})

beforeEach(async () => {
  resetRecommendationServiceForTests()
  await rm(join(configDir, 'proactive'), { recursive: true, force: true })
})

describe('RecommendationService', () => {
  test('given repeated local signals when refreshed then it creates one deduplicated recommendation per actionable rule', () => {
    const context = {
      recentRuns: [{ status: 'success', startedAt: Date.now() }],
      hasMemoryDailySchedule: false,
      hasReleaseMonitor: false,
      pendingApprovalCount: 5,
      sopCandidateCount: 3,
      recentReleaseRuns: 3,
      scheduleCount: 1,
    }

    const first = runRecommendationEngine(context)
    const repeated = runRecommendationEngine(context)

    expect(first.map((item) => item.duplicateKey).sort()).toEqual([
      'approval-digest-suggestion',
      'memory-daily-suggestion',
      'release-monitor-suggestion',
      'sop-review-suggestion',
    ])
    expect(repeated).toEqual([])
  })

  test('given no local proactive configuration when refreshed then it offers a safe first task', () => {
    const recommendations = runRecommendationEngine({
      recentRuns: [],
      hasMemoryDailySchedule: false,
      hasReleaseMonitor: false,
      pendingApprovalCount: 0,
      sopCandidateCount: 0,
      recentReleaseRuns: 0,
      scheduleCount: 0,
    })

    expect(recommendations).toEqual([
      expect.objectContaining({
        title: '创建首个安全定时任务',
        duplicateKey: 'proactive-getting-started-suggestion',
        safetyLevel: 'read_only',
      }),
    ])
  })
})
