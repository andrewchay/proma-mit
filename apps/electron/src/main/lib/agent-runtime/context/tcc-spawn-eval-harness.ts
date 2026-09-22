import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import type { TccExperimentRun, TccExperimentScoreboard } from './tcc-experiment'
import { evaluateTccExperimentGate } from './tcc-experiment'
import type { TccExperimentFixture } from './tcc-experiment-runner'
import { runTccExperiment } from './tcc-experiment-runner'
import type { TccEvalChannel, TccEvalIsolation } from './tcc-spawn-real-delegate'
import { buildTccExperimentDelegate } from './tcc-spawn-real-delegate'
import { loadTccSpawnFixture } from './tcc-spawn-fixture'
import { checkTccEvalPreflight } from './tcc-spawn-experiment'

export interface TccSpawnEvalPlan {
  fixturePath: string
  scoreboardPath: string
  isolationDir: string
  /** 用户显式授权的最大调用次数；任何超出都不允许发生。 */
  authorizedCalls: number
  runsPerCase: number
  provider: string
  modelId: string
  implementationVersion: string
}

export interface TccSpawnEvalReport {
  planned: number
  alreadyRecorded: number
  executed: number
  scoreboard: TccExperimentScoreboard
  gate: ReturnType<typeof evaluateTccExperimentGate>
}

/** 把 spawn 样本转换为既有 M3 评测 fixture 形态，复用同一门禁与统计口径。 */
export function toTccExperimentFixture(rawFixture: unknown): TccExperimentFixture {
  const fixture = loadTccSpawnFixture(rawFixture)
  return {
    version: 1,
    benchmarkId: 'typed-context-compiler',
    cases: fixture.cases.map((testCase) => ({
      id: testCase.id,
      task: testCase.task,
      brief: testCase.brief,
      requiredItemIds: testCase.requiredItemIds,
      forbiddenItemIds: testCase.forbiddenItemIds,
      items: testCase.items,
      projectionRequest: testCase.projectionRequest,
    })),
  }
}

/**
 * 真实评测编排。三重保护：先离线 preflight，再核对授权调用数，最后逐次落盘以便中断恢复。
 * 任何一层不通过都不会发起模型请求。
 */
export async function runTccSpawnEvaluation(
  plan: TccSpawnEvalPlan,
  channel: TccEvalChannel,
  isolation: TccEvalIsolation,
): Promise<TccSpawnEvalReport> {
  const fixture = toTccExperimentFixture(JSON.parse(readFileSync(plan.fixturePath, 'utf8')) as unknown)
  const raw = loadTccSpawnFixture(JSON.parse(readFileSync(plan.fixturePath, 'utf8')) as unknown)
  const preflight = checkTccEvalPreflight(raw.cases)
  if (!preflight.ready) throw new Error(`TCC evaluation preflight failed: ${preflight.reasons.join('; ')}`)

  const planned = fixture.cases.length * 3 * plan.runsPerCase
  if (plan.authorizedCalls < planned) {
    throw new Error(`Authorized calls (${plan.authorizedCalls}) are fewer than the planned matrix (${planned})`)
  }

  const recorded = readScoreboard(plan.scoreboardPath)
  const remaining = fixture.cases.length * 3 * plan.runsPerCase - (recorded?.runs.length ?? 0)
  if (remaining <= 0 && recorded) {
    return { planned, alreadyRecorded: recorded.runs.length, executed: 0, scoreboard: recorded, gate: evaluateTccExperimentGate(recorded) }
  }

  mkdirSync(plan.isolationDir, { recursive: true })
  const delegate = buildTccExperimentDelegate(channel, isolation)
  const scoreboard = await runTccExperiment({
    fixture,
    provider: plan.provider,
    modelId: plan.modelId,
    implementationVersion: plan.implementationVersion,
    runsPerCase: plan.runsPerCase,
    delegate: async (input) => {
      const result = await delegate(input)
      return result
    },
  })
  const merged = mergeRuns(recorded, scoreboard)
  writeFileSync(plan.scoreboardPath, `${JSON.stringify(merged, null, 2)}\n`)
  return { planned, alreadyRecorded: recorded?.runs.length ?? 0, executed: plan.runsPerCase * fixture.cases.length * 3, scoreboard: merged, gate: evaluateTccExperimentGate(merged) }
}

function readScoreboard(path: string): TccExperimentScoreboard | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TccExperimentScoreboard
  } catch {
    return undefined
  }
}

function mergeRuns(previous: TccExperimentScoreboard | undefined, next: TccExperimentScoreboard): TccExperimentScoreboard {
  if (!previous) return next
  const seen = new Set(previous.runs.map(runKey))
  const runs: TccExperimentRun[] = [...previous.runs, ...next.runs.filter((run) => !seen.has(runKey(run)))]
  return { ...next, runs }
}

function runKey(run: TccExperimentRun): string {
  return `${run.caseId}:${run.variant}:${run.run}`
}

export function defaultIsolationDir(baseDir: string): string {
  return join(baseDir, 'tcc-eval-isolation')
}
