# 设计：gravitas 的「能力评测 + 自演化」闭环（借鉴 penguin-harness）

- 状态：**草案待评审**
- 作者：Proma Agent（为 gravitas 立项）
- 日期：2026-08-16
- 依据：调研笔记 `research/penguin-hermes-borrowing.md`（第 5 节为 gravitas 现有代码梳理与 gap 映射）

---

## 0. 背景与目标

penguin-harness 的「自演化」是其核心差异化：用一套**可审计、可回归的评测体系**驱动 Agent 状态版本演进
（benchmark-design → agent-evaluation → agent-optimization）。

gravitas 深度梳理后发现：**运行机制 80% 已具备**（runSubAgent、goal-runtime 调度、bypassPermissions、
会话 JSONL 持久化、工作区目录模型），**缺的是评测领域层这 20%**：
1. 无可评估能力 Benchmark 数据模型（statement/rubric/score）
2. 无版本化 Agent 状态快照与回滚
3. 无「分数驱动 accpet/rollback」优化循环
4. 无 scoreboard 回归成绩流水

本设计目标：**以最小侵入、不破坏现有 Agent/SDK/UI 主路径为原则**，补上这 20%，形成可先小规模试点
（内置 sub-agent：code-reviewer / explorer / researcher）的评测自演化闭环。

---

## 1. 关键现有能力（设计直接复用，不重复造）

| 现有能力 | 位置 | 本设计用途 |
|---|---|---|
| `runSubAgent`（同步委派、child session、bypassPermissions、provider-agnostic） | `agent-orchestrator.ts` ~1105 | 评测委派底座 |
| 协作子 Agent（collaboration） | `agent-collaboration-tools.ts` | 评测可选的可观测通道 |
| Goal 控制平面（checkpoint/续跑/recoverDueGoals） | `goal-runtime/goal-coordinator.ts` | 优化循环的调度/续跑 |
| 权限多态（bypassPermissions 全放行） | `ai-sdk-runtime-core.ts` `checkToolPermission` | 评测子代理全自动运行 |
| 会话 JSONL 持久化 + meta（含 goalId/fork/parent 等） | `agent-session-manager.ts` | 评测运行记录 |
| 每会话 cwd 目录 + 工作区目录模型 | `agent-workspace-manager.ts` / `config-paths.ts` | 评测隔离沙箱 |
| skills 目录 + ReadSkill | `agent-workspace-manager.ts` | benchmark 指令注入 |

**设计原则**：纯新增一个评测领域层 + 对现有 `runSubAgent`/goal-runtime 做**向后兼容的扩展**，不改主流程。

---

## 2. 数据模型（新增，纯文件/JSON 存根，遵循「本地存储优先、无数据库」）

所有评测数据落在对应工作区下，与 session/workflow 同级，便于整体快照与移植。

```
<workspace>/                             # slug-desired 工作区
├── benchmarks/
│   ├── <benchmark-id>/                  # 语义 id，如 "subagent-code-review"
│   │   ├── benchmark.json               # config：title/desc/runtime/model/runs/targetScore
│   │   ├── scoreboard.json              # 版本化成绩流水（权威，勿二次计算）
│   │   └── cases/
│   │       ├── CASE-001-injected-bug/   # 每个 Case 目录
│   │       │   ├── statement.md         # 公开给被测 Agent 的任务
│   │       │   ├── statement/           # 可选公开素材（样例代码等）
│   │       │   └── rubric.json          # 私有 100 分评分项 + Gold 判定（不进被测上下文）
│   │       └── CASE-002-...
│   └── evaluations/                     # 每次评测运行的工作区/产物（可清理）
```

### 2.1 benchmark.json
```jsonc
{
  "id": "subagent-code-review",
  "title": "内置 code-reviewer 子代理代码审查能力",
  "description": "衡量 code-reviewer 找出注入缺陷的能力",
  "targetAgentId": "code-reviewer",        // 被测 Agent（先针对内置 sub-agent）
  "model": { "provider": "deepseek", "modelId": "deepseek-v4-flash" },
  "runsPerCase": 1,                         // 每 Case 运行次数
  "targetScore": 80,                        // 0..100 期望基准
  "cases": ["CASE-001-injected-bug", "CASE-002-clarity"]
}
```

### 2.2 rubric.json（私有，0..100，总和 100）
```jsonc
{
  "version": 1,
  "items": [
    { "name": "定位到修复点", "points": 35,
      "check": "rubric: Must reference the exact defective function/file in the reviewed change" },
    { "name": "正确的修复建议", "points": 40,
      "check": "rubric: Suggested fix actually resolves the injected bug" },
    { "name": "格式与可执行性", "points": 25,
      "check": "rubric: Output uses the review format; findings map to file:line"
    }
  ]
}
```

### 2.3 scoreboard.json（版本化回归流水）
```jsonc
{
  "benchmarkId": "subagent-code-review",
  "evaluations": [
    {
      "time": "2026-08-16T23:50:00Z",
      "agentVersion": 3,                    // 被测 Agent 状态版本
      "score": 74.4,                        // 0..100 平均
      "costUsd": 0.002,
      "durationMs": 12000,
      "runtime": { "provider": "deepseek", "modelId": "deepseek-v4-flash" },
      "cases": [ { "caseId": "CASE-001-injected-bug", "score": 68.0, "sessionId": "sub-..." } ]
    }
  ]
}
```
> 沿用 penguin 的「存储值权威、勿二次计算」约定；score 两位小数、cost 六位。

---

## 3. 运行时设计

### 3.1 评测执行：`evaluateRun`（新增，位于 `agent-runtime/eval/`）

```ts
// apps/electron/src/main/lib/agent-runtime/eval/evaluator.ts
interface EvalRunInput {
  benchmarkId: string
  caseId: string
  runIndex: number
  agentVersion: number
  model: { provider: string; modelId: string }
}
interface EvalRunResult {
  protocolVersion: 1
  status: 'ok' | 'failed'
  score: number        // 0..100，status=ok 才有
  costUsd?: number
  durationMs?: number
  sessionId?: string
  failureCode?: 'invalid_request' | 'benchmark_invalid' | 'version_changed' | 'evaluation_failed'
}
```

**执行步骤**（借鉴 penguin `agent-evaluation`，但轻量化）：
1. **沙箱隔离**：在 `<workspace>/benchmarks/evaluations/<run-id>/` 建独立 cwd（复用
   `getAgentWorkspaceCwd` 的目录模式），仅拷入该 Case 的 `statement/` 公开素材；rubric 绝不进入。
2. **委派运行**：调用现有 `runSubAgent`，传 `cwd=<沙箱>` + 固定 statement 指令 + `permissionMode: bypassPermissions`。
   → 需对 `SubAgentInput` 增加可选 `workspaceDir`（见 §3.3），向后兼容（缺省 = 继承父 cwd）。
3. **协议化返回**：让被委派子代理**按固定纯文本协议返回结构**（见 §3.4），规避非结构化文本。
4. **评分**：用私有 `rubric.json` 由**评分器**（可以是独立一次小调用，或规则引擎）打分，产出 `EvalRunResult`。
5. **记录**：把 `sessionId`（供追溯）、score、cost、duration 写入 scoreboard。

### 3.2 优化循环：`SelfEvolver`（新增，可对接现有 goal-runtime 调度）

```ts
// agent-runtime/eval/self-evolver.ts
// evidence → hypothesis → candidate → evaluate → accept/rollback
interface SelfEvolveRound {
  candidateVersion: number
  change: string            // 假设：改了什么、预测哪些 Case 分数变化
  score: number
  accepted: boolean
  reason: string
}
```

- **Reference** = 当前保持的 Agent 状态（及其 scoreboard 最新成绩）。
- **候选**：基于 score + 该次运行 `sessionId` 关联的 Trace/日志，诊断失分 Case → 生成可回滚候选改动。
- **版本化快照**（见 §3.5）：每次改造前先快照 Agent 状态目录；候选被拒则回滚。
- **接受门槛**：候选在冻结 benchmark 上完整有效评分 **严格高于** Reference 才接受；只 append 被接受项。
- **复用 goal-runtime 调度**：`MAX_IMMEDIATE_CONTINUATIONS` 同理控制迭代上限；改造范围限定在
  「内置 sub-agent 的 prompt/工具集」这类**可安全回滚**的 Agent 定义，先不触碰用户真实 session。

### 3.3 扩展 `SubAgentInput`（向后兼容）
```ts
export interface SubAgentInput {
  // ...现有字段
  /** 评测隔离沙箱：子代理 cwd 指向独立目录，仅拷入 Case 公开素材；缺省 = 继承父 cwd（不变） */
  workspaceDir?: string
  /** 协议化返回：true 时子代理按固定纯文本协议输出，便于评分解析 */
  returnProtocol?: boolean
  /** 是否需要把输入里的 rubric 排除在子代理可见之外（评测用，cwd 不拷 rubric） */
  // rubric 隔离由 evaluator 负责，不需透传
}
```

### 3.4 协议化返回（轻量，借鉴 penguin 的纯 YAML 协议）
被委派子代理按固定模板结束输出：
```text
SCORE_BODY / 你的判断与依据（human-readable）
同时必须在结尾输出一行 JSON：
{"score": 0-100, "findings": ["file:line —— 缺陷说明"], "verdict": "pass|fail|partial"}
```
评分器优先解析该行；解析失败 → 降级为人工/规则打分，不影响整体流程。

### 3.5 版本化 Agent 状态快照（衔接「agent 即目录」①）
现状：Agent 状态分散在 workspace 目录 + session JSONL + 内置 sub-agent 定义（代码内 `buildBuiltinAgents`）。
**快照目标**：聚焦「被测 Agent 的能力配置」，即内置 sub-agent 定义本身可外化为文件。

- **Phase-1 轻量快照**：把 `buildBuiltinAgents()` 返回的 Agent 定义（prompt/tools/model）序列化到
  `<workspace>/agent-defs/<name>/state.json`，用 `state.json` 的 `version` 字段做版本 + `snapshots/v<N>.tar.gz`
  原子打包（对目录 `cp -R` + tar，先 `exclude` 大产物），拒绝时 `restore`。
- **Phase-2（与 ① 合并）**：逐步把内置 sub-agent 定义迁移为「定义即文件」，让快照=整个 Agent 状态目录。

> 这是 ①「agent 即目录」与自演化的自然耦合点：**建议两者并为一个立项**，先出 ① 的目录 layout，
> 本评测系统在其之上落快照/回滚，一次设计两处收益。

---

## 4. 试点范围（先小、可回滚、不碰真实用户会话）

1. **对象**：仅针对内置 sub-agent `code-reviewer`（/ 可选 explorer/researcher）。
   它们由 `buildBuiltinAgents()` 生成、prompt 在代码内——快照/回滚收敛清晰。
2. **Benchmark 首批**：2–3 个 Case（注入缺陷的代码审查、清晰度、合规）。
3. **评测运行时**：复用现有 provider-agnostic runtime + 渠道（DeepSeek 等，与 penguin 思路一致，省钱）。
4. **触发面**：先做**内部触点/CLI**（`gravitas eval <benchmark> <agent>` / `gravitas improve`），
   渲染 UI 面板列为「中改动」第二阶段。

---

## 5. 新增/改动文件清单（草案）

**新增**
- `apps/electron/src/main/lib/agent-runtime/eval/types.ts` —— EvalRun / scoreboard / rubric 类型
- `apps/electron/src/main/lib/agent-runtime/eval/benchmark-store.ts` —— benchmark/scoreboard 读写
- `apps/electron/src/main/lib/agent-runtime/eval/evaluator.ts` —— 评测执行（沙箱 + 委派 + 协议 + 评分）
- `apps/electron/src/main/lib/agent-runtime/eval/self-evolver.ts` —— 优化循环（accept/rollback + 快照）
- `apps/electron/src/main/lib/agent-runtime/eval/cli.ts` —— `eval` / `improve` 内部命令入口（+ IPC 桥）
- `apps/electron/src/main/lib/agent-runtime/eval/*.test.ts` —— 单测（隔离临时目录）

**改动（向后兼容）**
- `agent-runtime/types.ts`：`SubAgentInput` 增加 `workspaceDir?` / `returnProtocol?`
- `agent-orchestrator.ts` `runSubAgent`：透传 `workspaceDir`，并支持协议返回解析
- `config-paths.ts`：新增 `getBenchmarkPath(slug, benchmarkId)` 等路径函数
- （Phase-2）`agent-prompt-builder.ts` / 内置 Agent 定义外化为文件（与 ① 合并）

---

## 6. 边界与不做

- **不改现有 Agent 主路径**：评测是旁路，不注入用户真实 session。
- **不做 UI 面板**（首期）；先 CLI/内部触点。
- **不引入评分热依赖**：rubric 是静态私有文件，评分首期可用「固定规则 + 一次小推理」，不强制新模型服务。
- **快照不含用户私有数据**：只打包 Agent 能力定义 + benchmark；session 内容仍走 JSONL（已有）。
- **危险操作无**：评测全是读/审，不触发文件写入用户项目；bypassPermissions 仅作用于隔离沙箱。

---

## 7. 里程碑

- **M0 ✅ 已完成**：类型 + benchmark-store（benchmark.json / rubric.json / scoreboard.json 读写）+
  config-paths 的 eval 路径函数（`getEvalDir` / `getBenchmarkDir` / `getEvalRunWorkspaceDir` 等）+ 单测。
- **M1 ✅ 已完成**：evaluator（沙箱隔离 + `runSubAgent.workspaceDir` 扩展 + 规则打分/可选 LLM 回调 + 4 错误码）+ 单测。
- **M2 ✅ 已完成**：self-evolver（版本快照 + 候选 + accept/rollback）+ commands（runBaseline / runImprove 编排）+ 单测；
  一个稳定的闭环已可跑通（19 tests / 8 files 全绿，typecheck 通过，测试隔离无泄漏到真实 config）。
- **M3 ✅ 已完成（真实会话接入 + IPC 触点）**：
  - `eval-runner.ts`：`resolveEvalChannel`（benchmark.runtime.channelId 优先，否则默认 Agent 渠道；解密 apiKey）+
    `buildEvalDelegate`（用 `ProviderAgnosticAgentAdapter` 在隔离沙箱真实跑 model）+ `buildBuiltinStateGuard`
    （对内置 sub-agent 做版本化 prompt 快照/应用/回滚）。
  - `builtin-agent-state.ts`（纯逻辑，可单测）；candidate 经 `SubAgentDelegateInput.systemPrompt` 透传到真实评测。
  - IPC 触点：`EVAL_RUN_BASELINE` / `EVAL_RUN_IMPROVE`（shared → ipc.ts → preload 全套）。
  - 全量 24 单测 + monorepo typecheck 绿；隔离无泄漏。

- **M4 ✅ 已完成（Builder 候选生成器=真实自演化闭环）**：
  - `builder-prompts.ts`（纯模板，可单测）+ `builder.ts`（`runPlainPrompt` 用 `ProviderAgnosticAgentAdapter`
    真实 LLM 调用，`generateCandidatePrompt` 基于 baseline 失分生成修订版 sub-agent prompt）。
  - `eval-service` 新增 `buildBuilderProposer`：只在有失分 Case 时产出候选；`useBuilder=false` 保守。
  - candidate 经 `afterState:{prompt}` 进评测闭环，strictly-higher 才 accepted，**绝不自动写回内置 def**。

- **M5 ✅ 已完成（采纳写回=改进真正生效）**：
  - `builtin-agent-overrides.ts`：`builtin-overrides.json` 持久化（`<config>/eval/`）+ `isBuiltinAgentId` 校验。
  - `buildBuiltinAgents()` 返回前合并持久化覆盖 → **所有**内置 sub-agent 调用点（runSubAgent / SDK agents）
    自动拿到采纳后的 prompt，而非代码默认值。
  - `eval-service`：`adoptBuiltinPrompt` / `clearBuiltinPrompt` / `listBuiltinPrompts` + `runEvalImprove.{autoAdopt}`
    （improve 接受候选后自动写回）；`commands` 新增 `onAcceptedCandidate`。
  - IPC 触点：`EVAL_ADOPT_PROMPT` / `EVAL_CLEAR_PROMPT` / `EVAL_LIST_PROMPTS`。
  - 集成测试验证：save 覆盖 → buildBuiltinAgents 生效；clear → 恢复代码默认。全量 30 单测 + monorepo typecheck 绿。

- **M6 ✅ 已完成（UI 评测面板）**：
  - `EvalPanel.tsx` 作为 AgentSettings 第 4 个 tab（slider 3→4）：Benchmark 列表 + scoreboard 趋势条、
    新建 Benchmark 表单（Case + Rubric 100 分）、触发 Baseline / Improve（autoAdopt）、采纳覆盖查看/恢复默认。
  - 新增 IPC：`EVAL_LIST_BENCHMARKS` / `EVAL_GET_BENCHMARK` / `EVAL_CREATE_BENCHMARK` +
    `benchmark-store.{listBenchmarks,getBenchmarkDetail,createBenchmarkForUI}`。
  - preload 全套桥接。全量 33 单测 + monorepo typecheck 绿，无泄漏。

- **M7 ✅ 已完成（真实端到端验证）**：
  - 探测真实渠道（DeepSeek/Kimi/AthenAI/ClaudeGPT 等；默认 DeepSeek-OAI + deepseek-v4-flash）。
  - 因渠道 key 用 Electron `safeStorage` 加密、无法在 CLI 解密，改用 Proma Cloud（真实 OpenAI 兼容端点，
    gpt-5.6-luna）做真实模型传输；新增 `e2e-real.ts` 验证脚本。
  - **真实闭环验证成功**：真实 LLM 作为被测审查员 + Builder 真实 LLM 生成候选。
    第 1 次：baseline 37 → 44/53/54 逐步接受；第 2 次（同一脚本）：baseline 10/44 → round1 50 接受、
    round2 44 拒绝+回滚。**accept 与 rollback 机制在真实模型下均正确触发**，scoreboard 正常写入，隔离清理干净。

- **M8 ✅ 已完成（runsPerCase>1 消除评测随机性）**：
  - `commands.ts` 新增 `evaluateCaseAcrossRuns`：对每个 Case 跑 `runsPerCase` 次（默认 1）并取平均，
    run 明细写入 scoreboard `cases[].runs`。`runBaseline` 与 `runImprove` 的 `delegateForEvolve` 都走此路径。
  - 新增 2 个单测验证：runsPerCase=3 时 delegate 被调 3 次且分数取平均；缺失时默认 1 次。
  - 真实 e2e 复跑确认仍正常（accept + rollback 都对）。全量 35 单测 + monorepo typecheck 绿，无泄漏。

### 真实路径注意事项
- 产品路径（Electron 内）用 `runEvalBaseline/runEvalImprove`（UI 评测 tab）：走 safeStorage 渠道 + adapter。
- 规则打分偏保守（关键词启发）；真实评测建议配 `scoreDelegate`（LLM 打分）提升准确性。
- 单次评测存在模型随机性 → 建议将来支持 `runsPerCase > 1` 多次运行取平均（对齐 penguin）。

### 已落地结构与生产接入点
- 新增：`agent-runtime/eval/{types,benchmark-store,evaluator,self-evolver,commands,eval-runner,builtin-agent-state,eval-service}.ts`（各配单测）。
- 改动：`agent-runtime/types.ts` `SubAgentInput.workspaceDir?`；`agent-orchestrator.ts` `runSubAgent` 透传 `workspaceDir`；
  shared `AGENT_IPC_CHANNELS`；ipc.ts；preload。
- 生产接入点：`runEvalBaseline(benchmarkId)` / `runEvalImprove(benchmarkId)`（来自 IPC / 渲染进程）；
  真实渠道由 `resolveEvalChannel` 解析，内置 sub-agent 由 `buildBuiltinStateGuard` 快照。
- 待完善：候选生成器（当前保守为 null，只产出 baseline）；UI 评测面板与 benchmark 创建入口（下一步）；
  状态外化为「agent 即目录」（① 立项）后快照升级到目录级。
