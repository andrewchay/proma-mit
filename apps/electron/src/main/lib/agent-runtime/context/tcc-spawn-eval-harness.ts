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
  /** 只评估指定 case（诊断探针用）；缺省评估全部。 */
  caseIds?: string[]
  /** 诊断用：将模型原始输出另存到仓库外私有文件。 */
  capturePath?: string
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

  const recorded = readScoreboard(plan.scoreboardPath)
  const completed = new Set((recorded?.runs ?? []).map(runKey))
  const targetCases = plan.caseIds ? fixture.cases.filter((testCase) => plan.caseIds!.includes(testCase.id)) : fixture.cases
  if (targetCases.length === 0) throw new Error('No evaluation cases selected')
  const planned = targetCases.length * 3 * plan.runsPerCase
  if (plan.authorizedCalls < planned) {
    throw new Error(`Authorized calls (${plan.authorizedCalls}) are fewer than the planned matrix (${planned})`)
  }
  const matrixComplete = fixture.cases.every((testCase) => (['full_context', 'brief', 'tcc_projection'] as const).every((variant) =>
    Array.from({ length: plan.runsPerCase }, (_, index) => index + 1).every((run) => completed.has(`${testCase.id}:${variant}:${run}`))))
  if (matrixComplete && recorded) {
    return { planned, alreadyRecorded: completed.size, executed: 0, scoreboard: recorded, gate: evaluateTccExperimentGate(recorded) }
  }

  mkdirSync(plan.isolationDir, { recursive: true })
  const delegate = buildTccExperimentDelegate(channel, plan.capturePath ? { ...isolation, capturePath: plan.capturePath } : isolation)
  const accumulated = [...(recorded?.runs ?? [])]
  const scoreboard = await runTccExperiment({
    fixture: { ...fixture, cases: targetCases },
    provider: plan.provider,
    modelId: plan.modelId,
    implementationVersion: plan.implementationVersion,
    runsPerCase: plan.runsPerCase,
    alreadyCompleted: completed,
    // 逐次落盘：90 次调用耗时较长，中断后必须能续跑而不能重烧额度。
    onRun: (run) => {
      accumulated.push(run)
      writeFileSync(plan.scoreboardPath, `${JSON.stringify({ version: 1, benchmarkId: 'typed-context-compiler', cases: fixture.cases, runs: accumulated }, null, 2)}\n`)
    },
    delegate,
  })
  const merged = mergeRuns(recorded, scoreboard, fixture.cases)
  writeFileSync(plan.scoreboardPath, `${JSON.stringify(merged, null, 2)}\n`)
  return { planned, alreadyRecorded: completed.size, executed: merged.runs.length - completed.size, scoreboard: merged, gate: evaluateTccExperimentGate(merged) }
}

function readScoreboard(path: string): TccExperimentScoreboard | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TccExperimentScoreboard
  } catch {
    return undefined
  }
}

function mergeRuns(previous: TccExperimentScoreboard | undefined, next: TccExperimentScoreboard, cases: TccExperimentFixture['cases']): TccExperimentScoreboard {
  const runs: TccExperimentRun[] = previous ? [...previous.runs] : []
  const seen = new Set(runs.map(runKey))
  runs.push(...next.runs.filter((run) => !seen.has(runKey(run))))
  return { version: 1, benchmarkId: 'typed-context-compiler', cases, runs }
}

function runKey(run: TccExperimentRun): string {
  return `${run.caseId}:${run.variant}:${run.run}`
}

export function defaultIsolationDir(baseDir: string): string {
  return join(baseDir, 'tcc-eval-isolation')
}
