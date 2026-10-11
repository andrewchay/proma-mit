/**
 * D04：独立工具选择 benchmark（离线确定性）。
 *
 * 覆盖 D01→D02→D03 全链的多步场景与恢复非劣：
 * - schema token 统计复用 shared `runCapabilityTokenBenchmark`（全量基线 vs 摘要+选中）；
 * - 失败统计：tool_not_loaded / schema_changed 拒绝、required 缺失；
 * - 恢复非劣：步骤间目录修订后旧调用被拒、重规划成功；
 * - 时延只含机制耗时（发现+计划+门禁），不含模型；模型质量评测需 Provider 授权，不在本文件。
 *
 * 不拿历史 M4 单轮结果作 PASS：本 benchmark 独立运行、独立断言。
 */

import { estimateCapabilityTokens, runCapabilityTokenBenchmark } from '@gravitas/shared'
import { buildToolCapabilityCatalog } from '../tool-capability-catalog'
import { guardLoadedToolCall, planToolLoading } from '../tool-loading-gate'
import type { RuntimeToolDefinition } from '../types'

export const TOOL_SELECTION_BENCHMARK_ID = 'tool-selection-pipeline-v1'

export interface BenchmarkStep {
  readonly query: string
  readonly requiredIds?: readonly string[]
  /** 本步模拟的执行尝试：对该工具的（可能已修订的）定义过执行门禁。 */
  readonly attemptTool?: string
  /** 目录修订：在上一步工具集基础上变换（模拟 MCP 目录更新/schema 变化）。 */
  readonly revise?: (tools: readonly RuntimeToolDefinition[]) => RuntimeToolDefinition[]
}

export interface BenchmarkScenario {
  readonly id: string
  readonly steps: readonly BenchmarkStep[]
  readonly seedTools: readonly RuntimeToolDefinition[]
  readonly tokenBudget: number
}

export interface BenchmarkStepReport {
  readonly stepIndex: number
  readonly loadedNames: readonly string[]
  readonly attemptRefusal?: 'tool_not_loaded' | 'schema_changed'
  readonly requiredMissing: readonly string[]
  readonly planMs: number
}

export interface ToolSelectionBenchmarkReport {
  readonly benchmarkId: typeof TOOL_SELECTION_BENCHMARK_ID
  readonly version: 1
  readonly scenarioId: string
  readonly steps: readonly BenchmarkStepReport[]
  readonly tokens: {
    readonly toolCount: number
    readonly selectedCount: number
    readonly baselineTokens: number
    readonly optimizedTokens: number
    readonly savingsRate: number
  }
  readonly refusals: { readonly toolNotLoaded: number; readonly schemaChanged: number }
  readonly requiredMissingTotal: number
  /** 未被拒绝解释的失败（应为空；非空即机制缺陷）。 */
  readonly unresolvedFailures: readonly string[]
  readonly wallTimeMs: number
}

function schemaBodies(catalog: ReturnType<typeof buildToolCapabilityCatalog>['catalog'], tools: readonly RuntimeToolDefinition[]): Record<string, string> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const bodies: Record<string, string> = {}
  for (const descriptor of catalog.descriptors) {
    const tool = byName.get(descriptor.toolName ?? '')
    if (tool) bodies[descriptor.schemaRef] = JSON.stringify(tool.parameters)
  }
  return bodies
}

export function runToolSelectionBenchmark(scenario: BenchmarkScenario): ToolSelectionBenchmarkReport {
  if (scenario.steps.length === 0) throw new Error('scenario 至少需要一个 step')
  const startedAt = Date.now()
  const stepReports: BenchmarkStepReport[] = []
  const refusals = { toolNotLoaded: 0, schemaChanged: 0 }
  let requiredMissingTotal = 0
  const unresolvedFailures: string[] = []
  let tools: RuntimeToolDefinition[] = [...scenario.seedTools]
  let priorTools: RuntimeToolDefinition[] = [...scenario.seedTools]
  let lastPlan: ReturnType<typeof planToolLoading> | undefined

  for (const [stepIndex, step] of scenario.steps.entries()) {
    if (step.revise) tools = step.revise(tools)
    const catalog = buildToolCapabilityCatalog(tools).catalog
    const planStart = Date.now()
    const plan = planToolLoading({ catalog, query: step.query, tokenBudget: scenario.tokenBudget, requiredIds: step.requiredIds }, tools)
    const planMs = Date.now() - planStart
    lastPlan = plan
    requiredMissingTotal += plan.discovery.requiredMissing.length

    let attemptRefusal: BenchmarkStepReport['attemptRefusal']
    if (step.attemptTool) {
      // 目录修订步骤的尝试用上一版定义（模拟会话内已加载的旧 schema）。
      const source = step.revise ? priorTools : tools
      const target = source.find((tool) => tool.name === step.attemptTool)
      if (!target) {
        unresolvedFailures.push(`step ${stepIndex}: attempt tool ${step.attemptTool} 不在工具集`)
      } else {
        const verdict = guardLoadedToolCall(plan, target)
        if (!verdict.ok) {
          attemptRefusal = verdict.reason
          if (verdict.reason === 'tool_not_loaded') refusals.toolNotLoaded += 1
          else refusals.schemaChanged += 1
        }
      }
    }
    priorTools = [...tools]
    stepReports.push({
      stepIndex,
      loadedNames: [...plan.loadedNames].sort(),
      ...(attemptRefusal ? { attemptRefusal } : {}),
      requiredMissing: [...plan.discovery.requiredMissing],
      planMs,
    })
  }

  const fullCatalog = buildToolCapabilityCatalog(tools).catalog
  const allIds = fullCatalog.descriptors.map((descriptor) => descriptor.id)
  const baselineBoard = runCapabilityTokenBenchmark({ catalog: fullCatalog, schemas: schemaBodies(fullCatalog, tools), selectedIds: allIds })
  // 优化侧自定义：过滤后摘要 + 选中 schema（shared 版 optimized 用全量摘要，非本场景语义）。
  const selectedDescriptors = lastPlan
    ? fullCatalog.descriptors.filter((descriptor) => descriptor.toolName && lastPlan.loadedNames.has(descriptor.toolName))
    : []
  const bodies = schemaBodies(fullCatalog, tools)
  const optimizedText = [
    lastPlan ? lastPlan.summary : '',
    ...selectedDescriptors.map((descriptor) => bodies[descriptor.schemaRef] ?? ''),
  ].join('\n\n')
  const optimizedTokens = estimateCapabilityTokens(optimizedText)
  const baselineTokens = baselineBoard.baselineTokens
  return {
    benchmarkId: TOOL_SELECTION_BENCHMARK_ID,
    version: 1,
    scenarioId: scenario.id,
    steps: stepReports,
    tokens: {
      toolCount: fullCatalog.descriptors.length,
      selectedCount: selectedDescriptors.length,
      baselineTokens,
      optimizedTokens,
      savingsRate: baselineTokens === 0 ? 0 : 1 - optimizedTokens / baselineTokens,
    },
    refusals,
    requiredMissingTotal,
    unresolvedFailures,
    wallTimeMs: Date.now() - startedAt,
  }
}
