/**
 * 评测 / 自演化（Benchmark + Self-Evolution）类型定义。
 *
 * 借鉴 penguin-harness 的 benchmark→evaluate→optimize 闭环，但轻量化：
 * - Benchmark：多 Case 能力评测；每个 Case = 公开 statement + 私有 rubric（0..100）。
 * - Evaluator：隔离沙箱跑一次被测 Agent，按 rubric 打分，返回协议化结果。
 * - SelfEvolver：evidence→candidate→evaluate→accept/rollback 优化循环 + 版本化快照。
 *
 * 本层为纯新增，不侵入现有 Agent/SDK/UI 主路径。
 */

/** 评测目标类型 */
export type EvalTargetType = 'agent' | 'toolset'

/** 被测目标 */
export interface EvalTarget {
  type: EvalTargetType
  id: string
}

/** 被测目标：先针对内置 sub-agent（code-reviewer 等），后续可扩展到任意 Agent 状态。 */
export type EvalTargetAgentId = string

/** 评测运行时（复用现有渠道/模型）。 */
export interface EvalRuntimeRef {
  provider: string
  modelId: string
  /** 可选：渠道 ID（缺省用全局选中渠道） */
  channelId?: string
}

/** Benchmark 配置。 */
export interface BenchmarkConfig {
  /** 语义 id（如 "subagent-code-review"），参与路径拼接，须为 [A-Za-z0-9._-] */
  id: string
  title: string
  description: string
  /** 被测目标类型（默认 agent） */
  targetType?: EvalTargetType
  /** 被测 Agent id（内置 sub-agent 或用例名） */
  targetAgentId: EvalTargetAgentId
  /** 评测运行时（provider + model） */
  runtime: EvalRuntimeRef
  /** 每 Case 运行次数（默认 1） */
  runsPerCase: number
  /** 期望基准分 0..100 */
  targetScore: number
  /** Case id 列表 */
  cases: string[]
  /** 追加的候选改造指令前缀（self-execution 用） */
  createdAt: string
  updatedAt: string
}

/** Case 私有 rubric 评分项。 */
export interface RubricItem {
  name: string
  points: number
  /** 判定标准（仅供评分器/人工参考，绝不被测方可见） */
  check: string
}

/** Case 私有 rubric（总分恒为 100）。 */
export interface Rubric {
  version: number
  items: RubricItem[]
}

/** 单次评测运行结果（协议化返回，借鉴 penguin 纯协议）。 */
export interface EvalRunResult {
  protocolVersion: 1
  caseId: string
  run: number
  agentVersion: number
  /** ok=已打分；failed=无法产出有效分数 */
  status: 'ok' | 'failed'
  /** 0..100；仅 status=ok 时有意义 */
  score: number
  costUsd?: number
  durationMs?: number
  sessionId?: string
  /** 该 run 的决策 trace 文件路径（append-only JSONL，含完整工具序列） */
  tracePath?: string
  /** failed 时的稳定错误码 */
  failureCode?: 'invalid_request' | 'benchmark_invalid' | 'version_changed' | 'evaluation_failed'
}

/** 单个 Case × run 的分数明细（写入 scoreboard）。 */
export interface ScoreboardCaseRun {
  score: number
  costUsd?: number | null
  durationMs?: number | null
  sessionId: string
  /** 该 run 的 trace 文件路径（可选） */
  tracePath?: string
}

/** 单个 Case 的汇总（scoreboard 内）。 */
export interface ScoreboardCase {
  caseId: string
  score: number
  costUsd?: number | null
  durationMs?: number | null
  runs: ScoreboardCaseRun[]
}

/** 一次完整的评测结果（作为 scoreboard 里一个 evaluation 条目）。 */
export interface BenchmarkEvaluation {
  time: string
  agentVersion: number
  score: number
  costUsd?: number | null
  durationMs?: number | null
  runtime: EvalRuntimeRef
  summary?: string
  cases: ScoreboardCase[]
}

/** scoreboard：版本化回归成绩流水。存储值是权威，不做二次计算。 */
export interface Scoreboard {
  benchmarkId: string
  evaluations: BenchmarkEvaluation[]
}

/** 自演化候选改动。 */
export interface SelfEvolveChange {
  /** 简洁描述改动与假设（做了什么、预测哪些 Case 分数变化） */
  description: string
  /** 目标对象（如 "builtin:code-reviewer"） */
  target: EvalTargetAgentId
  /** 改动前的被测状态（可由调用方序列化为 JSON 字符串；对 SelfEvolver 不透明） */
  beforeState?: unknown
  /** 改动后的被测状态（同理；由 StateGuard.apply 解释） */
  afterState?: unknown
}

/** 自演化一轮的结果。 */
export interface SelfEvolveRoundResult {
  agentVersion: number
  change: SelfEvolveChange
  score: number
  /** 是否被接受为新的 Reference */
  accepted: boolean
  reason: string
  /** 被拒时是否已回滚 */
  rolledBack: boolean
}

/** 评测执行输入。 */
export interface EvaluateRunInput {
  benchmark: BenchmarkConfig
  caseId: string
  caseStatement: string
  run: number
  agentVersion: number
}
