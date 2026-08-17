import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { createBenchmarkForUI, getBenchmarkDetail, listBenchmarks } from './benchmark-store'
import type { CreateBenchmarkRequest } from './benchmark-store'

const testDir = join(tmpdir(), `gravitas-eval-ui-test-${Date.now()}`)

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

const req: CreateBenchmarkRequest = {
  id: 'ui-bench',
  title: 'UI 基准',
  description: 'demo',
  targetAgentId: 'code-reviewer',
  provider: 'deepseek',
  modelId: 'deepseek-v4-flash',
  targetScore: 80,
  cases: [
    {
      caseId: 'CASE-001',
      statement: '# 审查下面的代码',
      rubricItems: [
        { name: '定位修复点', points: 50, check: 'x' },
        { name: '修复建议', points: 50, check: 'y' },
      ],
    },
  ],
}

describe('benchmark-store UI 入口', () => {
  it('createBenchmarkForUI 创建并可在 list 中看到', () => {
    const created = createBenchmarkForUI(req)
    expect(created.id).toBe('ui-bench')
    expect(created.cases).toContain('CASE-001')

    const list = listBenchmarks()
    const mine = list.find((b) => b.id === 'ui-bench')
    expect(mine).toBeDefined()
    expect(mine?.targetAgentId).toBe('code-reviewer')
    expect(mine?.latestScore).toBeNull()
  })

  it('getBenchmarkDetail 返回 config/scoreboard/cases', () => {
    const detail = getBenchmarkDetail('ui-bench')
    expect(detail).not.toBeNull()
    expect(detail?.config.cases).toHaveLength(1)
    expect(detail?.cases[0]?.statement).toContain('审查')
    expect(detail?.scoreboard.evaluations).toHaveLength(0)
  })

  it('非法 id 抛错', () => {
    expect(() => createBenchmarkForUI({ ...req, id: '../evil' })).toThrow()
  })
})
