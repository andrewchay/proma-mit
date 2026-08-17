/**
 * Benchmark / Scoreboard 存储。
 *
 * 纯文件 JSON 存储（本地优先、无数据库），遵循项目「safe-file」读写惯例：
 * - 读：`readJsonFileSafe<T>`；写：`writeJsonFileAtomic`。
 * - 存储值权威：scoreboard 内分数只落盘不二次计算；读写模块不做热重算。
 *
 * 目录布局（全局 eval 根，见 config-paths）：
 *   <config>/eval/benchmarks/<benchmark-id>/
 *     ├── benchmark.json
 *     ├── scoreboard.json
 *     └── cases/<case-id>/{ statement.md, rubric.json, statement/ }
 */

import { existsSync, readdirSync } from 'node:fs'
import {
  getBenchmarkCaseRubricPath,
  getBenchmarkCaseStatementAssetsDir,
  getBenchmarkCaseStatementPath,
  getBenchmarkConfigPath,
  getBenchmarkScoreboardPath,
  getBenchmarksRootDir,
} from '../../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../../safe-file'
import { join } from 'node:path'
import type {
  BenchmarkConfig,
  BenchmarkEvaluation,
  Rubric,
  Scoreboard,
  ScoreboardCase,
} from './types'

/** 新建一个 Benchmark（含 cases）；已存在则抛错避免覆盖。 */
export function createBenchmark(
  config: BenchmarkConfig,
  cases: Array<{ caseId: string; statement: string; rubric: Rubric }>,
): BenchmarkConfig {
  if (existsSync(getBenchmarkConfigPath(config.id))) {
    throw new Error(`Benchmark 已存在: ${config.id}`)
  }
  writeJsonFileAtomic(getBenchmarkConfigPath(config.id), config)
  const fs = require('node:fs') as typeof import('node:fs')
  for (const c of cases) {
    writeJsonFileAtomic(getBenchmarkCaseRubricPath(config.id, c.caseId), c.rubric)
    // statement.md 作为纯文本写入，被测方沙箱直接可读
    fs.writeFileSync(getBenchmarkCaseStatementPath(config.id, c.caseId), c.statement, 'utf-8')
    // 声明素材目录占位（可选，用来放样例文件）
    fs.mkdirSync(getBenchmarkCaseStatementAssetsDir(config.id, c.caseId), { recursive: true })
  }
  // scoreboard 初始化
  const scoreboard: Scoreboard = { benchmarkId: config.id, evaluations: [] }
  writeJsonFileAtomic(getBenchmarkScoreboardPath(config.id), scoreboard)
  return readBenchmark(config.id) ?? config
}

/** 读取 Benchmark 配置；不存在返回 null。 */
export function readBenchmark(benchmarkId: string): BenchmarkConfig | null {
  return readJsonFileSafe<BenchmarkConfig>(getBenchmarkConfigPath(benchmarkId))
}

/** 读取 Case 公开 statement 文本（从 statement.md 读纯文本）。 */
export function readCaseStatement(benchmarkId: string, caseId: string): string | null {
  const fs = require('node:fs') as typeof import('node:fs')
  const p = getBenchmarkCaseStatementPath(benchmarkId, caseId)
  if (!existsSync(p)) return null
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

/** 读取 Case 私有 rubric；不存在或非法返回 null。 */
export function readCaseRubric(benchmarkId: string, caseId: string): Rubric | null {
  const rubric = readJsonFileSafe<Rubric>(getBenchmarkCaseRubricPath(benchmarkId, caseId))
  if (!rubric || !Array.isArray(rubric.items)) return null
  return rubric
}

/** 读取 scoreboard；不存在返回空 scoreboard。 */
export function readScoreboard(benchmarkId: string): Scoreboard {
  return readJsonFileSafe<Scoreboard>(getBenchmarkScoreboardPath(benchmarkId)) ?? { benchmarkId, evaluations: [] }
}

/** 追加一条完整评测结果到 scoreboard（保持「存储值权威」：不做重算直接落盘）。 */
export function appendEvaluation(benchmarkId: string, evaluation: BenchmarkEvaluation): Scoreboard {
  const scoreboard = readScoreboard(benchmarkId)
  scoreboard.evaluations.push(evaluation)
  writeJsonFileAtomic(getBenchmarkScoreboardPath(benchmarkId), scoreboard)
  return scoreboard
}

/**
 * 计算单个 Case 的平均分（对非空 run 分取平均；无 run 返回 null）。
 * 仅供运行时构建 evaluation 条目使用；最终落盘值以此为准。
 */
export function summarizeCase(
  caseId: string,
  caseScore: number,
  caseCostUsd: number | null | undefined,
  caseDurationMs: number | null | undefined,
  runs: import('./types').ScoreboardCaseRun[],
): ScoreboardCase {
  return { caseId, score: caseScore, costUsd: caseCostUsd ?? null, durationMs: caseDurationMs ?? null, runs }
}

/** 校验 rubric 总分必须是 100（评测前置校验）。 */
export function assertRubricTotals100(rubric: Rubric): void {
  const total = rubric.items.reduce((sum, item) => sum + (typeof item.points === 'number' ? item.points : 0), 0)
  if (total !== 100) {
    throw new Error(`Rubric 总分应为 100，实际 ${total}`)
  }
}

/** 列出所有已创建的 Benchmark（含每项最新成绩，用于面板列表）。 */
export function listBenchmarks(): Array<BenchmarkConfig & { latestScore: number | null; lastEvaluationTime: string | null }> {
  const root = getBenchmarksRootDir()
  if (!existsSync(root)) return []
  const out: Array<BenchmarkConfig & { latestScore: number | null; lastEvaluationTime: string | null }> = []
  for (const entry of readdirSync(root)) {
    const configPath = join(root, entry, 'benchmark.json')
    if (!existsSync(configPath)) continue
    const config = readJsonFileSafe<BenchmarkConfig>(configPath)
    if (!config) continue
    const scoreboard = readJsonFileSafe<Scoreboard>(join(root, entry, 'scoreboard.json'))
    const last = scoreboard?.evaluations?.length ? scoreboard.evaluations[scoreboard.evaluations.length - 1] : undefined
    out.push({
      ...config,
      latestScore: last ? last.score : null,
      lastEvaluationTime: last ? last.time : null,
    })
  }
  return out
}

/** 读取某个 Benchmark 的配置 + scoreboard（供面板展示）。不存在返回 null。 */
export function getBenchmarkDetail(benchmarkId: string):
  | { config: BenchmarkConfig; scoreboard: Scoreboard; cases: Array<{ caseId: string; statement: string | null }> }
  | null {
  const config = readBenchmark(benchmarkId)
  if (!config) return null
  const scoreboard = readScoreboard(benchmarkId)
  const cases: Array<{ caseId: string; statement: string | null }> = config.cases.map((caseId) => ({
    caseId,
    statement: readCaseStatement(benchmarkId, caseId),
  }))
  return { config, scoreboard, cases }
}

/** UI 创建 Benchmark 的请求结构。 */
export interface CreateBenchmarkRequest {
  id: string
  title: string
  description: string
  targetAgentId: string
  provider: string
  modelId: string
  channelId?: string
  targetScore: number
  cases: Array<{ caseId: string; statement: string; rubricItems: Array<{ name: string; points: number; check: string }> }>
}

/** UI 用的创建入口：拼装 BenchmarkConfig + Cases 交给 createBenchmark。 */
export function createBenchmarkForUI(input: CreateBenchmarkRequest): BenchmarkConfig {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.id)) {
    throw new Error(`Benchmark id 非法：仅允许字母/数字/._-，且不以数字外的符号开头（${input.id}）`)
  }
  const now = new Date().toISOString()
  const config: BenchmarkConfig = {
    id: input.id,
    title: input.title,
    description: input.description,
    targetAgentId: input.targetAgentId,
    runtime: { provider: input.provider, modelId: input.modelId, channelId: input.channelId },
    runsPerCase: 1,
    targetScore: input.targetScore,
    cases: input.cases.map((c) => c.caseId),
    createdAt: now,
    updatedAt: now,
  }
  const caseDefs = input.cases.map((c) => ({
    caseId: c.caseId,
    statement: c.statement,
    rubric: { version: 1, items: c.rubricItems },
  }))
  return createBenchmark(config, caseDefs)
}
