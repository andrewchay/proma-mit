/**
 * R01：held-out 离线基准矩阵骨架。
 *
 * 只跑确定性离线检查（策略/预算闸/调度串行/压缩 Golden/敏感拦截），
 * 不调用真实 Provider、不跑 TCC 实验。费用字段恒为 'unknown'——
 * 离线执行没有费用计量，绝不写成 0（0 会被误读为"免费"）。
 */

import { AGENT_RUNTIME_CAPABILITIES, DEFAULT_HARNESS_POLICY, HarnessPolicyError, assertRuntimeSatisfiesPolicy, type AgentRuntime, type HarnessPolicy } from '@gravitas/shared'

export interface BenchmarkTask {
  readonly id: string
  readonly description: string
  /** 安全断言：失败即整体失败，零容忍 */
  readonly safety: boolean
  readonly runtimes?: readonly AgentRuntime[]
  readonly run: (runtime?: AgentRuntime) => Promise<{ passed: boolean; detail?: string }>
}

export interface BenchmarkResult {
  readonly taskId: string
  readonly runtime: AgentRuntime | null
  readonly passed: boolean
  readonly detail?: string
  /** 离线基准无费用计量，恒为 unknown；禁止填 0 */
  readonly cost: 'unknown'
}

export interface HarnessBenchmarkReport {
  readonly generatedAt: string
  readonly total: number
  readonly passed: number
  readonly failed: number
  /** 安全断言失败清单（零容忍：非空即整体失败） */
  readonly safetyFailures: readonly string[]
  readonly results: readonly BenchmarkResult[]
}

const ALL_RUNTIMES: readonly AgentRuntime[] = ['claude', 'proma', 'pi', 'ai-sdk']

export async function runHarnessBenchmark(tasks: readonly BenchmarkTask[]): Promise<HarnessBenchmarkReport> {
  const results: BenchmarkResult[] = []
  const safetyFailures: string[] = []
  for (const task of tasks) {
    const runtimes = task.runtimes ?? [undefined]
    for (const runtime of runtimes) {
      let outcome: { passed: boolean; detail?: string }
      try {
        outcome = await task.run(runtime)
      } catch (error) {
        outcome = { passed: false, detail: error instanceof Error ? error.message : String(error) }
      }
      results.push({ taskId: task.id, runtime: runtime ?? null, passed: outcome.passed, detail: outcome.detail, cost: 'unknown' })
      if (task.safety && !outcome.passed) safetyFailures.push(runtime ? `${task.id}@${runtime}` : task.id)
    }
  }
  const passed = results.filter((r) => r.passed).length
  return {
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    safetyFailures,
    results,
  }
}

const cloneDefaultPolicy = (): HarnessPolicy => JSON.parse(JSON.stringify(DEFAULT_HARNESS_POLICY)) as HarnessPolicy

/** 内置 held-out 任务集：策略/预算/调度/压缩/记忆的离线安全与质量断言。 */
export function buildHarnessBenchmarkTasks(deps: {
  evaluateGoldenSet: () => boolean
  checkUnknownToolsSerialize: () => Promise<boolean>
  sensitiveFilterBlocks: () => boolean
  budgetGateThrows: (runtime: AgentRuntime) => boolean
}): BenchmarkTask[] {
  return [
    {
      id: 'policy-default-no-gaps',
      description: '默认策略在全部 runtime 上无 required 缺口',
      safety: true,
      runtimes: ALL_RUNTIMES,
      run: async (runtime) => {
        try {
          assertRuntimeSatisfiesPolicy(runtime!, AGENT_RUNTIME_CAPABILITIES[runtime!], cloneDefaultPolicy())
          return { passed: true }
        } catch (error) {
          return { passed: false, detail: error instanceof Error ? error.message : String(error) }
        }
      },
    },
    {
      id: 'policy-required-tool-scheduling-rejects-claude',
      description: 'required 工具调度串行化必须在 claude（SDK 子进程）上被拒绝',
      safety: true,
      run: async () => {
        const policy = cloneDefaultPolicy()
        policy.guarantees.toolScheduling = 'required'
        try {
          assertRuntimeSatisfiesPolicy('claude', AGENT_RUNTIME_CAPABILITIES.claude, policy)
          return { passed: false, detail: 'claude 未被拒绝' }
        } catch (error) {
          return { passed: error instanceof HarnessPolicyError }
        }
      },
    },
    {
      id: 'budget-gate-unsupported-runtime-fail-closed',
      description: '不支持费用停止阈值的 runtime 在预算闸 fail-closed',
      safety: true,
      runtimes: ALL_RUNTIMES,
      run: async (runtime) => ({ passed: deps.budgetGateThrows(runtime!) === !AGENT_RUNTIME_CAPABILITIES[runtime!].supportsBudgetStopThreshold }),
    },
    {
      id: 'scheduler-unknown-tools-serialize',
      description: 'unknown 工具在共享调度器上全局串行',
      safety: true,
      run: async () => ({ passed: await deps.checkUnknownToolsSerialize() }),
    },
    {
      id: 'compaction-golden-set',
      description: '压缩 Golden 集（含三连压缩）评估通过',
      safety: false,
      run: async () => ({ passed: deps.evaluateGoldenSet() }),
    },
    {
      id: 'memory-sensitive-candidate-blocked',
      description: '敏感记忆候选在进入审批链前被拦截',
      safety: true,
      run: async () => ({ passed: deps.sensitiveFilterBlocks() }),
    },
  ]
}
