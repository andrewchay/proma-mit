/**
 * 评测 / 自演化服务层：把 eval 闭环接到真实渠道与内置 sub-agent，供 IPC 触点调用。
 *
 * 用途：
 * - `runBaseline(benchmarkId)` —— 对 benchmark 里每个 Case 跑一次真实评测（真实模型），
 *   结果写入 scoreboard，返回摘要。
 * - `runImprove(benchmarkId)` —— 在 baseline 基础上做有限轮次的自演化候选迭代（accepted/rollback）。
 *
 * 副作用边界：评测完全旁路，不写用户真实 session；只在 isolated eval sandbox 运行。
 */

import { runBaseline, runImprove } from './commands'
import { requireBenchmark } from './commands'
import { buildEvalDelegate, buildBuiltinStateGuard, resolveEvalChannel, type EvalChannelInfo } from './eval-runner'
import { buildEvalTargetStateGuard, isEvalTargetId } from './eval-target-state'
import { writeToolAgentsMd } from './toolset-state'
import { generateCandidatePrompt } from './builder'
import { writeAgentAgentsMd } from '../../agent-definition-store'
import { clearBuiltinOverride, isBuiltinAgentId, readBuiltinOverrides } from './builtin-agent-overrides'
import type { BaselineSummary, ImproveSummary } from './commands'
import type { EvalProgressCallback, ScoreDelegate } from './evaluator'
import type { ProposeChange } from './self-evolver'
import type { BenchmarkConfig } from './types'

/** 采纳写回：把「始终允许」式的改进 prompt 持久化为内置 sub-agent 覆盖。 */
export interface AdoptResult {
  agentId: string
  applied: boolean
  reason?: string
}

/**
 * 采纳一个改进后的评测目标 prompt（agent 即目录 / toolset 即目录）。
 * 仅允许内置 sub-agent id 或已目录化的 toolset id，避免误写其他对象；同时清除旧版 legacy override。
 */
export function adoptEvalTarget(type: 'agent' | 'toolset', targetId: string, content: string): AdoptResult {
  if (!isEvalTargetId(type, targetId)) {
    return { agentId: targetId, applied: false, reason: `非有效评测目标 id: ${targetId}（类型: ${type}）` }
  }
  if (!content || !content.trim()) {
    return { agentId: targetId, applied: false, reason: 'content 不能为空' }
  }

  if (type === 'agent') {
    writeAgentAgentsMd(targetId, content.trim())
    clearBuiltinOverride(targetId)
  } else {
    writeToolAgentsMd(targetId, content.trim())
  }
  return { agentId: targetId, applied: true }
}

/** 兼容旧接口：采纳一个改进后的内置 sub-agent prompt */
export function adoptBuiltinPrompt(agentId: string, prompt: string): AdoptResult {
  return adoptEvalTarget('agent', agentId, prompt)
}

/** 清除某个内置 sub-agent 的持久化覆盖（恢复代码默认；目录置回 bundled seed 在 D2 seed 同步时处理）。 */
export function clearBuiltinPrompt(agentId: string): AdoptResult {
  if (!isBuiltinAgentId(agentId)) {
    return { agentId, applied: false, reason: `非内置子代理 id: ${agentId}` }
  }
  clearBuiltinOverride(agentId)
  return { agentId, applied: true }
}

/** 读取内置子代理的持久化覆盖（当前生效注override）。 */
export function listBuiltinPrompts(): import('./builtin-agent-overrides').BuiltinOverridesMap {
  return readBuiltinOverrides()
}

/** 可选：注入更准的 LLM 打分（默认规则打分）。 */
export interface EvalServiceOptions {
  scoreDelegate?: ScoreDelegate
  /** Case 级运行进度，供 IPC/Renderer 反馈真实评测状态。 */
  onProgress?: EvalProgressCallback
  maxRounds?: number
  /** 是否启用 Builder 候选生成（默认 true）；false = 只产出 baseline */
  useBuilder?: boolean
  /**
   * 是否在候选被接受后自动「采纳写回」到内置 sub-agent 持久化覆盖。
   * 默认 false：只记录到 scoreboard，不自动改内置行为；true 时把最后一个被接受候选的
   * prompt 写入 builtin-overrides（会影响后续真实 sub-agent 运行）。
   */
  autoAdopt?: boolean
}

/**
 * Builder 候选生成器：基于 baseline 失分，用评测渠道 LLM 生成修订版 sub-agent prompt。
 * 只在有失分 Case 时产出；否则返回 null（本轮结束）。
 */
function buildBuilderProposer(
  channel: EvalChannelInfo,
  benchmark: BenchmarkConfig,
  currentPrompt: () => string | undefined,
  maxRounds: number,
): ProposeChange {
  let generated = 0
  return async ({ deficit, round }) => {
    if (generated >= maxRounds) return null
    // 只在存在真实失分（低分/失败）时才值得尝试改进
    const hasDeficit = deficit.some((d) => d.score === null || d.score < benchmark.targetScore)
    if (!hasDeficit) return null
    generated++
    const base = currentPrompt() ?? `（${benchmark.targetAgentId} 未定义 prompt）`
    try {
      const revised = await generateCandidatePrompt(channel, {
        benchmark,
        currentPrompt: base,
        caseScores: deficit.map((d) => ({ caseId: d.caseId, score: d.score })),
      })
      if (!revised || revised === base) return null
      return {
        description: `Builder 第 ${round} 轮候选：针对 ${deficit.map((d) => d.caseId).join(',')} 失分优化提示词`,
        target: benchmark.targetAgentId,
        afterState: { prompt: revised },
      }
    } catch (error) {
      console.error('[Eval] Builder 候选生成失败:', error)
      return null
    }
  }
}

/** 跑一次真实 Baseline 评测。 */
export async function runEvalBaseline(benchmarkId: string, opts: EvalServiceOptions = {}): Promise<BaselineSummary> {
  const benchmark = requireBenchmark(benchmarkId)
  const channel = resolveEvalChannel(benchmark)
  const delegate = buildEvalDelegate(channel)
  const guard = buildEvalTargetStateGuard({
    type: benchmark.targetType ?? 'agent',
    id: benchmark.targetAgentId,
  })
  return runBaseline({
    benchmark,
    delegate,
    scoreDelegate: opts.scoreDelegate,
    agentVersion: guard.version(),
    onProgress: opts.onProgress,
  })
}

/** 跑一次真实 Improve 优化闭环（baseline + Builder 候选迭代）。 */
export async function runEvalImprove(benchmarkId: string, opts: EvalServiceOptions = {}): Promise<ImproveSummary> {
  const benchmark = requireBenchmark(benchmarkId)
  const channel = resolveEvalChannel(benchmark)
  const delegate = buildEvalDelegate(channel)
  const guard = buildEvalTargetStateGuard({
    type: benchmark.targetType ?? 'agent',
    id: benchmark.targetAgentId,
  })
  const maxRounds = opts.maxRounds ?? 2
  const autoAdopt = opts.autoAdopt === true
  let adoptedContent: string | undefined
  return runImprove({
    benchmark,
    delegate,
    scoreDelegate: opts.scoreDelegate,
    state: guard,
    maxRounds,
    // useBuilder=false 时保守：只产出 baseline，不自动生成候选
    propose: opts.useBuilder === false
      ? async () => null
      : buildBuilderProposer(channel, benchmark, () => guard.currentContent(), maxRounds),
    // autoAdopt：把最后一个被接受候选的 content 写回目录（AGENTS.md 或 TOOLS.md）
    onAcceptedCandidate: autoAdopt
      ? (candidate) => {
        const c = extractContent(candidate.afterState)
        if (c) adoptedContent = c
      }
      : undefined,
  }).then(async (summary) => {
    if (autoAdopt && adoptedContent) {
      adoptEvalTarget(benchmark.targetType ?? 'agent', benchmark.targetAgentId, adoptedContent)
    }
    return summary
  })
}

/** 从候选 afterState 提取内容字符串（支持 { prompt/toolsMd } 或直接字符串）。 */
function extractContent(afterState: unknown): string | undefined {
  if (typeof afterState === 'string') return afterState.trim()
  if (afterState && typeof afterState === 'object') {
    const obj = afterState as Record<string, unknown>
    const p = obj.prompt ?? obj.toolsMd
    if (typeof p === 'string' && p.trim()) return p.trim()
  }
  return undefined
}

/** 兼容旧接口：从候选 afterState 提取 prompt 字符串 */
function extractPrompt(afterState: unknown): string | undefined {
  return extractContent(afterState)
}
