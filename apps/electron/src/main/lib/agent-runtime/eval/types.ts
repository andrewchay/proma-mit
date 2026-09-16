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
export type EvalTargetType = 'agent' | 'toolset' | 'employee_capability'

/** 被测目标 */
export interface EvalTarget {
  type: EvalTargetType
  id: string
  /** employee_capability 使用；id 为 agentId。 */
  scope?: 'role' | 'workspace'
  workspaceId?: string
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

/**
 * 评判者身份（评估器独立性审计）。
 *
 * 综述基准（arXiv:2607.13104 §8.1.2）：若同一评判配置既驱动更新又报告终值，
 * 系统会过优化到评判的潜在偏差。因此每条 evaluation 记录本次评判者身份：
 * - kind: rule=规则打分（无模型耦合，天然独立）/ llm=LLM judge / injected=外部注入回调
 * - independent: 评判渠道是否与「被测方/Builder 渠道」不同（channelId 或 modelId 不同）
 */
export interface JudgeIdentity {
  kind: 'rule' | 'llm' | 'injected'
  provider?: string
  modelId?: string
  channelId?: string
  /** true = 评判者与被测/候选生成方解耦；false = 存在自我确认风险 */
  independent: boolean
}

/** 评判预算（judge 资源隔离，综述 §8.1.2 延伸）：超限后 judge 停用并回退规则打分。 */
export interface JudgeBudget {
  /** 单次评测闭环内 judge 最大调用次数（独立计费桶的最小形态） */
  maxCalls?: number
  /** judge 输入中被测输出的最大字符数（max tokens 的代理上限，超出截断） */
  maxPromptChars?: number
}

/** Benchmark 配置。 */
export interface BenchmarkConfig {
  /** 语义 id（如 "subagent-code-review"），参与路径拼接，须为 [A-Za-z0-9._-] */
  id: string
  title: string
  description: string
  /** 被测目标类型（默认 agent） */
  targetType?: EvalTargetType
  /** 被测 Agent id（内置 sub-agent、工具集 id 或 AI 员工 id） */
  targetAgentId: EvalTargetAgentId
  /** employee_capability 专用：能力范围 */
  targetScope?: 'role' | 'workspace'
  /** employee_capability 专用：工作区级能力的目标工作区 */
  targetWorkspaceId?: string
  /** 评测运行时（provider + model） */
  runtime: EvalRuntimeRef
  /**
   * 可选：独立评判运行时（LLM judge）。
   * 不配置时回退规则打分；配置后 judge 用该渠道/模型评分，
   * 与 runtime（被测方/候选生成方）不同即视为独立评判（综述 §8.1.2）。
   */
  judgeRuntime?: EvalRuntimeRef
/** 可选：judge 预算隔离（调用次数 / 输入规模上限） */
  judgeBudget?: JudgeBudget
  /**
   * 可选：held-out Case id 列表（迁移测试，综述 §8.1.1）。
   * 与 cases（训练集）必须不相交；不参与 improve 优化循环，
   * 仅在 includeHeldOut 时评测并单独落盘，用于检测对训练 benchmark 的过拟合。
   */
  heldOutCases?: string[]
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
  /**
   * 可选的真实工具行为断言。存在时，分数只由 append-only trace 中的 tool_use /
   * tool_result 决定，不能由模型在文本里提及工具名冒充。
   */
  toolTrace?: ToolTraceAssertion
}

/** 对一次或多次真实工具调用的可序列化断言。 */
export interface ToolTraceAssertion {
  /** 必须至少出现一次的工具名；数组表示任一即可。 */
  name?: string | string[]
  /** 调用参数中必须存在的字段。 */
  requiredArguments?: string[]
  /** 必须严格相等的关键原始参数（仅支持 JSON 原始值，保持 benchmark 可审计）。 */
  expectedArguments?: Record<string, string | number | boolean>
  /** 工具执行结果必须为成功或错误。 */
  result?: 'success' | 'error'
  /** trace 中不得出现的工具名。 */
  forbiddenNames?: string[]
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
  /** 多次 run 分数的总体标准差（n<2 时为 null）；方差报告，防单次随机性误读 */
  scoreStd?: number | null
  costUsd?: number | null
  durationMs?: number | null
  runs: ScoreboardCaseRun[]
}

/** held-out 迁移评测结果（附在 evaluation 上，与训练分数并列）。 */
export interface HeldOutReport {
  score: number
  /** 跨 Case 总体标准差（n<2 → null） */
  scoreStd?: number | null
  cases: ScoreboardCase[]
}

/** 一次完整的评测结果（作为 scoreboard 里一个 evaluation 条目）。 */
export interface BenchmarkEvaluation {
  time: string
  agentVersion: number
  score: number
  costUsd?: number | null
  durationMs?: number | null
  runtime: EvalRuntimeRef
  /** 本次评判者身份（评估器独立性审计）；null=未记录（历史数据） */
  judge?: JudgeIdentity | null
  /** 各 Case 分数的总体标准差（n<2 时为 null）；mean±std 方差报告 */
  scoreStd?: number | null
  /** held-out 迁移分数（仅 includeHeldOut 时评测）；null/缺省 = 未评测 */
  heldOut?: HeldOutReport | null
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
