import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import {
  appendEvaluation,
  assertRubricTotals100,
  createBenchmark,
  readBenchmark,
  readCaseRubric,
  readCaseStatement,
  readScoreboard,
} from './benchmark-store'
import { getBenchmarkConfigPath, getBenchmarkCaseRubricPath, getEvalDir } from '../../config-paths'
import type { BenchmarkConfig, BenchmarkEvaluation, Rubric } from './types'

const testDir = join(tmpdir(), `gravitas-eval-test-${Date.now()}`)

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
})

const config: BenchmarkConfig = {
  id: 'subagent-code-review',
  title: '内置 code-reviewer 审查能力',
  description: '衡量 code-reviewer 找出注入缺陷的能力',
  targetAgentId: 'code-reviewer',
  runtime: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
  runsPerCase: 1,
  targetScore: 80,
  cases: ['CASE-001-injected-bug'],
  createdAt: '2026-08-16T00:00:00Z',
  updatedAt: '2026-08-16T00:00:00Z',
}

const rubric: Rubric = {
  version: 1,
  items: [
    { name: '定位修复点', points: 35, check: 'must reference exact defective function' },
    { name: '正确修复建议', points: 40, check: 'fix resolves the injected bug' },
    { name: '格式可执行性', points: 25, check: 'findings map to file:line' },
  ],
}

describe('benchmark-store', () => {
  it('createBenchmark 建立目录 / config / rubric / scoreboard', () => {
    const created = createBenchmark(config, [{ caseId: 'CASE-001-injected-bug', statement: '# 任务\n审查这段代码', rubric }])
    expect(created.id).toBe(config.id)

    const reread = readBenchmark(config.id)
    expect(reread?.targetAgentId).toBe('code-reviewer')

    const statement = readCaseStatement(config.id, 'CASE-001-injected-bug')
    expect(statement).toContain('审查这段代码')

    const storedRubric = readCaseRubric(config.id, 'CASE-001-injected-bug')
    expect(storedRubric?.items.reduce((s, i) => s + i.points, 0)).toBe(100)

    const scoreboard = readScoreboard(config.id)
    expect(scoreboard.evaluations).toHaveLength(0)
  })

  it('重复创建同一 benchmark 抛错（不覆盖）', () => {
    expect(() => createBenchmark(config, [{ caseId: 'CASE-001-injected-bug', statement: 'x', rubric }])).toThrow()
  })

  it('appendEvaluation 追加一条版本化成绩流水', () => {
    const evaluation: BenchmarkEvaluation = {
      time: '2026-08-16T01:00:00Z',
      agentVersion: 1,
      score: 74.4,
      costUsd: 0.0021,
      durationMs: 12000,
      runtime: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
      cases: [
        {
          caseId: 'CASE-001-injected-bug',
          score: 74.4,
          runs: [{ score: 74.4, sessionId: 'sub-xxx' }],
        },
      ],
    }
    appendEvaluation(config.id, evaluation)
    const scoreboard = readScoreboard(config.id)
    expect(scoreboard.evaluations).toHaveLength(1)
    expect(scoreboard.evaluations[0]!.agentVersion).toBe(1)
    expect(scoreboard.evaluations[0]!.score).toBe(74.4)
  })

  it('assertRubricTotals100 对总分非 100 抛错', () => {
    expect(() => assertRubricTotals100({ version: 1, items: [{ name: 'a', points: 99, check: 'x' }] })).toThrow()
    expect(() => assertRubricTotals100(rubric)).not.toThrow()
  })

  it('path helpers 可用且隔离到测试目录', () => {
    expect(getEvalDir().startsWith(testDir)).toBe(true)
    expect(getBenchmarkConfigPath(config.id).startsWith(testDir)).toBe(true)
    expect(getBenchmarkCaseRubricPath(config.id, 'CASE-001-injected-bug').startsWith(testDir)).toBe(true)
  })
})
