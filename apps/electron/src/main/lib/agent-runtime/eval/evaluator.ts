/**
 * 评测执行器：隔离沙箱跑一次被测 Agent，按私有 rubric 打分，返回协议化结果。
 *
 * 借鉴 penguin `agent-evaluation`，但轻量化：
 * - 沙箱：复用 `runSubAgent.workspaceDir`，被测方 cwd 指向独立目录，仅拷入 Case 公开素材；
 *   rubric 绝不进入被测上下文。
 * - 协议：被测方按固定一行 JSON 结尾输出（score/findings/verdict），评分器优先解析。
 * - 评分：默认规则打分（rubric 每项一组关键词）；可注入可选的 LLM 打分回调做更准评分。
 *
 * 本模块为纯新增；不直接依赖 SDK，只依赖注入的委派函数，便于单测。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { readBenchmark, readCaseRubric, readCaseStatement } from './benchmark-store'
import { assertRubricTotals100 } from './benchmark-store'
import { getBenchmarkCaseStatementAssetsDir, getEvalRunWorkspaceDir } from '../../config-paths'
import type { EvalRunResult, Rubric, RubricItem, BenchmarkConfig } from './types'

/** 评测用的可观测执行事件。 */
export interface EvalProgressEvent {
  benchmarkId: string
  caseId: string
  phase: 'case_start' | 'case_complete'
  completedCases: number
  totalCases: number
  score?: number
}

export type EvalProgressCallback = (event: EvalProgressEvent) => void

/** 被测子代理委派函数（由调用方注入，通常是项目内 runSubAgent）。 */
export interface SubAgentDelegateInput {
  agentName: string
  task: string
  workspaceDir: string
  /** 可选：被测状态（候选）的系统提示词覆盖；缺省由 delegate 自行解析内置定义 */
  systemPrompt?: string
  maxTurns?: number
  abortSignal?: AbortSignal
  /** 评测运行时：delegate 把本次运行 trace 信息写回（runId + trace 路径） */
  runId?: string
}

/** Delegate 返回：被测文本 + 可选 trace 信息。 */
export interface SubAgentDelegateResult {
  text: string
  /** 本次运行的 trace（决策序列）信息 */
  trace?: { runId: string; tracePath: string }
}

export type SubAgentDelegate = (input: SubAgentDelegateInput) => Promise<SubAgentDelegateResult>

/** 可选的 LLM 打分回调：把 rubric + statement + 被测输出 交给更准的评分。 */
export type ScoreDelegate = (input: {
  rubric: Rubric
  statement: string
  agentOutput: string
}) => Promise<number | null>

/** 规则打分缺省关键词表（rubric item name → 判定用关键词）。宽松启发式。 */
const RULE_KEYWORDS: Record<string, string[]> = {
  '修复点': ['line', 'file:', '函数', 'function', '位置'],
  '缺陷': ['bug', '缺陷', '注入', '错误'],
  '修复建议': ['修复', 'fix', '改为', 'suggest'],
  '格式': ['file:', 'line:', '##', '严重'],
}

/**
 * 构建一个 Case 的评测运行输入（供 CLI/自演化直接调用，不依赖运行时自建）。
 * 需要传入 rubric score（evaluator 内部调用）。
 */
export interface EvaluateCaseInput {
  benchmarkId: string
  caseId: string
  agentName: string
  runIndex: number
  agentVersion: number
  /** 可选注入：模型/渠道已在 benchmark.runtime 内 */
  abortSignal?: AbortSignal
  maxTurns?: number
}

/**
 * 评测一个 Case 的一次运行。
 *
 * @param delegate 委派函数（调用现有 runSubAgent 机制）
 * @returns 协议化结果
 */
export async function evaluateCaseRun(
  benchmark: BenchmarkConfig,
  caseId: string,
  runIndex: number,
  agentVersion: number,
  delegate: SubAgentDelegate,
  opts: { abortSignal?: AbortSignal; maxTurns?: number; scoreDelegate?: ScoreDelegate; systemPrompt?: string; traceText?: string } = {},
): Promise<EvalRunResult> {
  const statement = readCaseStatement(benchmark.id, caseId)
  const rubric = readCaseRubric(benchmark.id, caseId)
  if (!statement) return { protocolVersion: 1, caseId, run: runIndex, agentVersion, status: 'failed', score: 0, failureCode: 'invalid_request' }
  if (!rubric) return { protocolVersion: 1, caseId, run: runIndex, agentVersion, status: 'failed', score: 0, failureCode: 'benchmark_invalid' }
  assertRubricTotals100(rubric)

  // 1) 准备隔离沙箱：只拷入该 Case 公开素材
  const runId = `eval-${benchmark.id}-${caseId}-${runIndex}-${Date.now()}`
  const workspaceDir = getEvalRunWorkspaceDir(runId)
  prepareSandbox(workspaceDir, benchmark.id, caseId)

  // 2) 委派：被测子代理在沙箱内执行，按协议返回
  const startedAt = Date.now()
  const prompt = buildEvalPrompt(statement)
  let text = ''
  let runTracePath: string | undefined
  let score = 0
  let failed = false
  let failureCode: EvalRunResult['failureCode']
  try {
    const result = await delegate({
      agentName: benchmark.targetAgentId,
      task: prompt,
      workspaceDir,
      runId,
      maxTurns: opts.maxTurns ?? 12,
      abortSignal: opts.abortSignal,
      systemPrompt: opts.systemPrompt,
    })
    text = result.text
    if (result.trace) {
      runTracePath = result.trace.tracePath
    }
    const traceText = runTracePath && existsSync(runTracePath)
      ? readFileSync(runTracePath, 'utf-8')
      : undefined
    score = await computeScores(rubric, statement, text, opts.scoreDelegate, traceText)
  } catch (error) {
    failed = true
    failureCode = 'evaluation_failed'
    text = String(error instanceof Error ? error.message : error)
  }
  const durationMs = Date.now() - startedAt
  if (failed) {
    return { protocolVersion: 1, caseId, run: runIndex, agentVersion, status: 'failed', score: 0, durationMs, failureCode, tracePath: runTracePath }
  }

  return {
    protocolVersion: 1,
    caseId,
    run: runIndex,
    agentVersion,
    status: 'ok',
    score,
    durationMs,
    sessionId: runId,
    tracePath: runTracePath,
    failureCode: undefined,
  }
}

/** 拷贝 Case 公开素材到沙箱（rubric 绝不拷入）。 */
function prepareSandbox(workspaceDir: string, benchmarkId: string, caseId: string): void {
  mkdirSync(workspaceDir, { recursive: true })
  const assetsDir = getBenchmarkCaseStatementAssetsDir(benchmarkId, caseId)
  if (!existsSync(assetsDir)) return
  for (const entry of readdirSync(assetsDir)) {
    const src = join(assetsDir, entry)
    // 仅拷贝普通文件（样例代码/数据），跳过子目录以免泄露；如需子目录可后续扩展
    const dst = join(workspaceDir, entry)
    if (!existsSync(dst)) {
      try {
        copyFileSync(src, dst)
      } catch {
        // 忽略单个文件拷贝失败，不阻塞评测
      }
    }
  }
}

/** 构造被测方 prompt（含协议返回要求；不含 rubric）。 */
function buildEvalPrompt(statement: string): string {
  return [
    statement,
    '',
    '请按以下要求完成任务，并在输出的**最后一行**单独输出一行 JSON：',
    '{"score": 0-100, "findings": ["file:line —— 缺陷说明"], "verdict": "pass|fail|partial"}',
    'score 表示你自评对本任务的完成置信度；findings 列出关键发现（file:line）；verdict 为整体结论。',
  ].join('\n')
}

/** 计算得分。 */
async function computeScores(
  rubric: Rubric,
  statement: string,
  agentOutput: string,
  scoreDelegate?: ScoreDelegate,
  traceText?: string,
): Promise<number> {
  // 1) 若注入 LLM 打分，优先使用
  if (scoreDelegate) {
    const llmScore = await scoreDelegate({ rubric, statement, agentOutput }).catch(() => null)
    if (llmScore !== null) return clamp(llmScore)
  }
  // 2) 否则规则打分逐项加权
  return clamp(ruleScore(rubric, agentOutput, traceText))
}

/** 规则打分：每项按关键词命中给加权分。 */
function ruleScore(rubric: Rubric, output: string, traceText?: string): number {
  const evidence = `${output}\n${traceText ?? ''}`.toLowerCase()
  let earned = 0
  for (const item of rubric.items) {
    const keywords = keywordsFor(item)
    const matched = keywords.filter((keyword) => evidence.includes(keyword.toLowerCase()))
    const ratio = keywords.length === 0 ? 1 : matched.length / keywords.length
    earned += item.points * ratio
  }
  // 空输出得 0
  if (!output.trim()) return 0
  return Math.round(earned)
}

/**
 * 从 rubric 的 `check` 中提取可审计的行为证据：工具名、参数名和关键中文短语。
 * 标题只表达评判维度，不能作为唯一评分依据；真实运行的工具调用会写入 trace。
 */
function keywordsFor(item: RubricItem): string[] {
  const known = RULE_KEYWORDS[item.name] ?? []
  const check = item.check ?? ''
  const codeTokens = check.match(/`([^`]+)`|\b(?:ma_|computer_use_|ComputerUse)[A-Za-z0-9_]+\b/g) ?? []
  const fieldTokens = check.match(/\b(?:brand|product|platform|budget|content|source|category|text_input)\b/g) ?? []
  const actionTokens = item.name.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
  const checkPhrases = check.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
  return [...new Set([...known, ...codeTokens, ...fieldTokens, ...actionTokens, ...checkPhrases]
    .map((token) => token.replace(/`/g, '').trim())
    .filter((token) => token.length > 1))]
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}
