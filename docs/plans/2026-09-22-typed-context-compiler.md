# Typed Context Compiler 落地方案

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Gravitas 中建立一个显式、可验证、可重建的上下文投影层，使主 Agent、subagent、工具和 compaction 都消费类型化状态视图，而不是直接共享不可分解的完整会话历史。

**Architecture:** 保留原始事件和事实作为 durable ledger；在 turn 边界、spawn 边界和 compaction 边界生成面向任务的 Context Projection；最后由 provider/model adapter 将 projection 编译为具体模型所需的 prompt、工具目录和权限约束。第一阶段只做只读 subagent 的定向上下文和结构化结果，不做每 turn 全量 meta-attention，也不删除原始历史。

**Tech Stack:** TypeScript、Bun、Electron main process、Jotai、JSONL/JSON 本地存储、现有 provider-agnostic runtime、现有 agent session/workspace、BDD 风格 Bun tests。

---

## 0. 决策摘要

### 0.1 方向名称

统一使用 **Typed Context Compiler（TCC）**，不把产品命名为 Meta-attention Agent。

Meta-attention 是未来可能采用的一种 projection scorer；TCC 才是稳定的架构边界：

```text
Durable State / Event Ledger
        ↓
Context Projection
        ↓
Model-specific Prompt + Tools + Policy
        ↓
Agent Runtime
```

### 0.2 第一性原则

1. 原始状态可追溯、可重建，projection 不得成为唯一事实来源。
2. 子任务优先于主循环做定向 context projection。
3. 默认只读、结构化结果、显式证据；暂不自动合并任意自然语言上下文。
4. 动态重构只发生在 turn、spawn、compaction 等边界，禁止每 turn 全量重构。
5. 路由先由声明式约束驱动，暂不做不可解释的概率模型路由。
6. cache read/write、provider 能力和失败重试成本必须参数化，不能写死在业务策略中。
7. 所有自动压缩必须可回溯；失败或中止不得伪造 compact boundary。

### 0.3 目标与非目标

**本期目标**

- 定义并持久化类型化 Agent state、observation、artifact、decision、constraint。
- 在 spawn 边界为 explorer / researcher / code-reviewer 生成定向上下文。
- 让 subagent 返回带类型、证据定位、置信度和未验证项的结果。
- 记录 projection、token、cache、模型、重试和结果质量指标。
- 为后续 reversible compaction 和 tool discovery 建立数据基础。

**本期不做**

- 不实现每 turn 自动 relevance scoring。
- 不删除或覆盖原始 session JSONL。
- 不把所有工具一次性暴露给模型。
- 不在没有隐私策略和能力证据时自动跨 provider 路由。
- 不改写项目根 `AGENTS.md` 或 workspace `AGENTS.md`。
- 不把 Agent 执行完成等同于业务验收。

---

## 1. 现状衔接与边界

### 1.1 可复用能力

| 现有能力 | 位置 | TCC 用途 |
|---|---|---|
| Agent session JSONL | `apps/electron/src/main/lib/agent-session-manager.ts` | 原始事件与消息留存 |
| Agent 编排与 SDK 调用 | `apps/electron/src/main/lib/agent-orchestrator.ts` | spawn、主循环、执行指标接入 |
| Provider-agnostic runtime | `apps/electron/src/main/lib/agent-runtime/` | projection 编译和模型调用边界 |
| 内置 Agent 目录 | `apps/electron/default-agents/`、`agent-definition-store.ts` | Agent 能力描述、工具与策略来源 |
| 自演化评测 | `apps/electron/src/main/lib/agent-runtime/eval/` | 结果质量、回归和候选方案验证 |
| workspace / cwd 隔离 | `agent-workspace-manager.ts`、`config-paths.ts` | 子任务输入和产物隔离 |
| Pi 自动压缩 | Pi session 相关实现 | 后续接入 reversible projection，不在 P0 重写 |

### 1.2 事实来源优先级

```text
用户明确输入 / 工具原始结果 / 文件系统事实
    > 结构化 Agent artifact / decision
    > 自动生成摘要
    > relevance score / 推断
```

任何 projection 都必须标记来源类型和可验证程度。自动摘要不能覆盖原始事实。

---

## 2. 目标架构

### 2.1 核心对象

建议新增 `packages/shared/src/context/`，将跨 main/runtime/renderer 使用的纯类型放在 shared；持久化和编译逻辑放在 Electron main。

```ts
export type ContextItemKind =
  | 'user_intent'
  | 'task_state'
  | 'file_fact'
  | 'tool_observation'
  | 'decision'
  | 'constraint'
  | 'artifact'
  | 'subtask_result'
  | 'permission_policy'
  | 'summary'

export type ContextVisibility = 'parent' | 'child' | 'model' | 'private'
export type ContextMutability = 'read_only' | 'append_only' | 'write'
export type EvidenceKind = 'file_locator' | 'tool_result' | 'session_message' | 'test_result' | 'user_statement'

export interface ContextEvidence {
  kind: EvidenceKind
  sourceId: string
  locator?: string
  checksum?: string
  verified: boolean
}

export interface ContextItem {
  id: string
  kind: ContextItemKind
  version: number
  createdAt: string
  updatedAt: string
  content: string
  summary?: string
  tags: string[]
  visibility: ContextVisibility
  mutability: ContextMutability
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  evidence: ContextEvidence[]
  supersedes?: string
  expiresAt?: string
}
```

### 2.2 Projection

```ts
export interface ContextProjectionRequest {
  sessionId: string
  purpose: 'main_turn' | 'subagent_spawn' | 'tool_discovery' | 'compaction' | 'evaluation'
  task: string
  targetAgentId?: string
  targetModel?: { provider: string; modelId: string }
  maxInputTokens?: number
  requiredKinds?: ContextItemKind[]
  excludedKinds?: ContextItemKind[]
  allowedVisibility?: ContextVisibility[]
  policy?: ContextProjectionPolicy
}

export interface ContextProjectionPolicy {
  allowUnverified: boolean
  includeRawEvidence: boolean
  includeSummaries: boolean
  includeFullContent: boolean
  allowedPaths?: string[]
  deniedPaths?: string[]
  allowedToolClasses?: string[]
  modelAllowlist?: string[]
}

export interface ContextProjection {
  id: string
  request: ContextProjectionRequest
  items: Array<{
    itemId: string
    representation: 'summary' | 'full' | 'locator'
    reason: string
    score?: number
  }>
  renderedPromptBlocks: string[]
  renderedToolCatalog?: string
  omittedItemIds: string[]
  tokenEstimate: number
  createdAt: string
  sourceRevision: string
}
```

### 2.3 Subagent 结果契约

第一版不让子 Agent 直接回灌整段 transcript，而是返回结构化 artifact：

```ts
export interface SubtaskResult {
  protocolVersion: 1
  taskId: string
  status: 'completed' | 'partial' | 'blocked' | 'failed'
  summary: string
  claims: Array<{
    statement: string
    confidence: 'high' | 'medium' | 'low'
    evidence: ContextEvidence[]
    verified: boolean
  }>
  artifacts: Array<{
    kind: 'file_finding' | 'plan' | 'review_finding' | 'research_note' | 'test_report'
    title: string
    content: string
    evidence: ContextEvidence[]
  }>
  unverified: string[]
  recommendedNextSteps: string[]
}
```

契约要求：事实、推断、未验证事项必须分开；缺少 evidence 的 claim 不得标记为 high confidence。

---

## 3. 组件和文件计划

### 3.1 Shared 类型与协议

**新增**

- `packages/shared/src/context/types.ts`
- `packages/shared/src/context/projection.ts`
- `packages/shared/src/context/subtask-result.ts`
- `packages/shared/src/context/index.ts`
- `packages/shared/src/context/*.test.ts`

**修改**

- `packages/shared/src/index.ts` 或现有导出入口
- 如有 shared package exports 配置，同步 `package.json`

**验收**

- 类型无 `any`。
- JSON 可序列化、版本字段明确。
- 无 Electron、文件系统和 provider 依赖。

### 3.2 Durable Context Ledger

**新增**

- `apps/electron/src/main/lib/agent-runtime/context/context-ledger.ts`
- `apps/electron/src/main/lib/agent-runtime/context/context-ledger-store.ts`
- `apps/electron/src/main/lib/agent-runtime/context/context-ledger.test.ts`

**职责**

- append-only 写入 ContextItem。
- 从现有 session/tool/artifact 事件生成最小 item。
- 支持按 session、workspace、task、kind、visibility 查询。
- 原始内容和摘要分开保存。
- 维护 sourceRevision，支持 projection 可追溯。
- 写入失败不能影响主 Agent 原有会话持久化；采用 best-effort observability，除非未来明确将 ledger 设为权威来源。

**建议存储**

```text
<workspace>/context/
├── ledger.jsonl
├── summaries.jsonl
├── projections.jsonl
└── indexes.json
```

第一版不引入 SQLite；当查询规模确实超过 JSONL 才评估 Context Store 索引。

### 3.3 Projection Compiler

**新增**

- `apps/electron/src/main/lib/agent-runtime/context/context-projector.ts`
- `apps/electron/src/main/lib/agent-runtime/context/context-renderer.ts`
- `apps/electron/src/main/lib/agent-runtime/context/context-policy.ts`
- `apps/electron/src/main/lib/agent-runtime/context/context-projector.test.ts`

**职责**

- 按 purpose、task、agent definition 和 policy 生成 projection。
- 默认先选高可信 evidence，再选摘要，最后才选全文。
- 明确输出 omitted items，不静默丢弃。
- 将每个 block 标记为 `[FACT]`、`[INFERENCE]`、`[UNVERIFIED]`、`[SUMMARY]`。
- 不允许同一 item 的 summary 和 full content 在同一层无标记重复出现。
- 估算 token，超过预算时按确定性优先级裁剪。

第一版的 ranking 使用规则，不调用模型：

1. requiredKinds 优先；
2. 目标 task/agent 标签匹配；
3. evidence verified 优先；
4. 最近更新时间；
5. summary 优先于 full；
6. 旧摘要和低置信推断最后。

### 3.4 Spawn Adapter

**修改**

- `apps/electron/src/main/lib/agent-orchestrator.ts`
- `apps/electron/src/main/lib/agent-runtime/agent-runtime-core.ts`（以实际文件为准）
- 共享 `SubAgentInput` 类型所在文件

**新增/扩展字段**

```ts
interface SubAgentContextOptions {
  projection?: ContextProjectionRequest
  resultProtocol?: 'typed-v1' | 'plain-text'
  readOnly?: boolean
}
```

**行为**

- 只有显式指定 `projection` 的新调用走 TCC；旧调用保持兼容。
- 首批内置 Agent：`explorer`、`researcher`、`code-reviewer`。
- 首批默认 `readOnly: true`，禁止直接修改父工作区。
- 子 Agent 产物写入独立 execution/task 目录，再转成 SubtaskResult。
- 父 Agent 消费 `SubtaskResult` 的 summary/claims/artifacts，而非自动拼接完整 child transcript。
- 原始 child session 仍可追溯。

### 3.5 Tool Catalog（P2）

**新增**

- `apps/electron/src/main/lib/agent-runtime/context/tool-capability-catalog.ts`
- `apps/electron/src/main/lib/agent-runtime/context/tool-capability-catalog.test.ts`

**第一版能力描述**

```ts
interface ToolCapabilityDescriptor {
  id: string
  title: string
  description: string
  inputSchemaRef: string
  access: 'read' | 'write' | 'external_side_effect'
  dataClasses: string[]
  requiresConfirmation: boolean
  parallelSafe: boolean
  resultKinds: ContextItemKind[]
}
```

系统常驻的是 capability summary；完整 schema 只在 projector 明确选择后注入。工具权限仍由现有 permission service 决定，catalog 不能绕过权限。

### 3.6 Reversible Compaction（P3）

**修改**

- 现有 Pi 自动压缩相关实现（先定位具体模块后改）
- `apps/electron/src/main/lib/agent-runtime/context/`
- 现有 compact boundary 类型、持久化和审计测试

**原则**

- compact 是 projection/view switch，不是删除原始 ledger。
- 保存 `sourceRevision`、projection policy、保留 item ids、摘要版本和 token 估算。
- 只在成功生成并验证 projection 后写 compact boundary。
- 中止、报错、空结果不写成功边界。
- 不在 P3 前引入自动模型 relevance scorer；先用规则 projection 形成 baseline。

### 3.7 Cost-aware Routing（P4）

**新增**

- `apps/electron/src/main/lib/agent-runtime/context/model-policy.ts`
- `apps/electron/src/main/lib/agent-runtime/context/cost-model.ts`
- 对应单测

**输入因素**

- provider/model 能力；
- cache affinity 是否已知；
- privacy/data policy；
- tool compatibility；
- expected context size；
- estimated retry cost；
- latency budget。

第一版只做可解释规则和 model allowlist。任何不确定的 cache 保留都按 cache miss 估算，禁止把 provider 行为假设当事实。

---

## 4. 分阶段路线图

### M0：契约和观测基线

**目标**：不改变执行行为，先能记录和回放。

**工作项**

- 定义 shared 类型和版本协议。
- 为现有 Agent/tool/subagent 事件生成 ledger item。
- 记录 token estimate、model、provider、duration、retry、failure code。
- 建立 fixture：一个小型代码任务、一次探索、一次工具观察。

**退出条件**

- 现有主路径测试全部通过。
- ledger 关闭或写入失败不改变任务结果。
- 可从 ledger 重建 fixture 的最小状态。

### M1：规则型 Context Projection

**目标**：生成可解释、可回放的 context view。

**工作项**

- 实现 deterministic projector。
- 支持 summary/full/locator 三种 representation。
- 支持 policy、visibility、path allow/deny。
- 输出 omitted item 和每项 reason。
- 建立 golden projection fixtures。

**退出条件**

- 同一 ledger + request 产生 byte-stable projection。
- 超出预算时不会丢失 required items。
- 未验证 claim 不被渲染成 verified fact。

### M2：Subagent 定向上下文与 typed result

**目标**：先在 spawn 边界取得实际收益。

**工作项**

- 扩展 SubAgentInput 的 projection/resultProtocol/readOnly。
- explorer/researcher/code-reviewer 接入。
- 子任务独立目录和父工作区只读隔离。
- 解析并持久化 SubtaskResult。
- 父 Agent 只消费 typed result，不自动 merge transcript。

**退出条件**

- 只读子任务不能写入父工作区。
- child session 仍可从 UI/审计追溯。
- 失败时父任务得到明确 blocked/failed 结果，不被伪装为成功。

### M3：评测与对照实验

**目标**：验证 TCC 是否真的改善成功率、成本和稳定性。

**对照组**

1. full parent context；
2. 现有普通摘要/brief；
3. TCC deterministic projection + typed result。

**指标**

- 任务成功率；
- 总 input/output/cache token；
- 重试次数；
- 人工纠正次数；
- duration；
- 子任务结果可验证率；
- evidence coverage；
- projection token 占原始可用状态比例；
- false omission / false inclusion。

**退出条件**

- 至少 10 个固定 case、每 case 至少 3 次运行，记录 provider/model 和版本。
- TCC 在不降低成功率超过预设容忍度的情况下，至少一个成本或稳定性指标改善。
- 没有通过评测的数据，不推进自动 scorer 或自动 adoption。

### M4：两层工具能力目录

**目标**：减少高基数 schema 对主上下文的污染。

**工作项**

- 建立 capability descriptor。
- 常驻摘要目录和按需 schema 注入。
- 将 access/dataClasses/confirmation 接入 policy。
- 对 MCP、builtin tools、workspace tools 做统一 descriptor 适配。

**退出条件**

- 未选择的完整 schema 不进入 prompt。
- 权限检查仍在实际调用处执行。
- 工具选择准确率不低于现有 baseline，且 prompt token 减少。

### M5：Reversible Compaction

**目标**：把 compaction 从不可逆摘要变成可重建视图。

**工作项**

- compact boundary 绑定 sourceRevision 和 projection metadata。
- 原始 ledger 保留，摘要可重建。
- 规则触发：token budget、轮数、失败重试、上下文熵代理指标。
- 与现有 Pi automatic compaction 审计对齐。

**退出条件**

- 任意成功 compact boundary 可以读取保留 item ids 和 policy。
- 失败/中止不生成成功边界。
- 从原始 ledger 可重建等价或更完整视图。

### M6：可解释成本感知路由

**目标**：把 cache affinity、隐私、能力和重试成本纳入模型选择。

**工作项**

- 参数化 pricing/caching capability。
- 声明式敏感路径和 model allowlist。
- 默认按 cache miss 估算未知 provider 行为。
- 在 UI/审计展示路由理由。

**退出条件**

- 每次路由都有可解释 reason。
- 违反 privacy policy 的模型永不被选择。
- 未知 cache 行为不会被错误标记为命中。

---

## 5. BDD 验收场景

### Context ledger

- **Given** 一个已完成工具调用，**When** 调用 ledger recorder，**Then** 写入 tool_observation、来源 sessionId、工具名、结果摘要和 evidence。
- **Given** ledger 写入失败，**When** Agent 继续执行，**Then** 主流程完成，且错误进入 observability，不伪造 ledger 成功。
- **Given** 同一 source event 重放，**When** 再次写入，**Then** 由 sourceId/version 去重，不产生重复事实。

### Projection

- **Given** 同一 ledger 和同一 request，**When** 两次 projection，**Then** 结果稳定且 sourceRevision 相同。
- **Given** budget 不足，**When** projector 裁剪，**Then** requiredKinds 先保留， omittedItemIds 明确记录。
- **Given** 一个未验证 claim，**When** 渲染到模型上下文，**Then** 显式标记 `[UNVERIFIED]`，不能伪装成 `[FACT]`。
- **Given** 同一个 item 同时有 summary 和 full，**When** 两者都被选中，**Then** 渲染器必须标注版本关系，禁止无标记重复。

### Subagent

- **Given** readOnly 子任务，**When** 子 Agent 尝试修改父工作区，**Then** 写入被拒绝或只进入隔离目录。
- **Given** child 返回缺少 evidence 的高置信 claim，**When** 解析结果，**Then** 降级为 low/unknown 并加入 unverified。
- **Given** child 执行失败，**When** 父 Agent 收到结果，**Then** status=failed/blocked，不能生成 completed artifact。

### Compaction

- **Given** projection 生成中止，**When** compact 流程结束，**Then** 不写成功 compact boundary。
- **Given** 已有 compact boundary，**When** 读取原始 ledger，**Then** 可以重建保留 item 列表和渲染视图。

### Routing

- **Given** 任务触碰敏感路径，**When** 路由模型，**Then** 不选择不在 allowlist 的 provider。
- **Given** provider cache affinity 未知，**When** 估算成本，**Then** 按 miss 处理并在 reason 中注明未知。

---

## 6. 评测设计

### 6.1 最小 benchmark

创建独立 TCC benchmark，不直接改已有自演化 benchmark 的含义：

```text
<workspace>/benchmarks/typed-context-compiler/
├── benchmark.json
├── scoreboard.json
└── cases/
    ├── CASE-001-repo-exploration/
    ├── CASE-002-tool-output-noise/
    ├── CASE-003-sensitive-file-policy/
    ├── CASE-004-subtask-evidence/
    └── CASE-005-context-recovery/
```

### 6.2 成功定义

TCC 只有在以下条件同时满足时才算有效：

- 任务成功率不低于 full-context baseline 的 95%（或明确记录质量 tradeoff）；
- 至少一个 case 的 input/cache token 降低 20%；
- typed result evidence coverage ≥ 90%；
- false omission ≤ 5%；
- projection 失败可回退到 baseline，不阻塞主流程；
- 没有新增越权文件读取或父工作区写入。

### 6.3 评测隔离

所有会写 workspace/session/config 的测试必须设置 `PROMA_TEST_CONFIG_DIR` 临时目录；测试后删除临时目录并清理环境变量。禁止写入真实 `~/.gravitas/`。

---

## 7. 风险、回滚与观察点

| 风险 | 早期信号 | 处理 |
|---|---|---|
| 过滤掉关键事实 | false omission、重复追问、测试失败 | 默认回退 baseline；提高 evidence/required 优先级 |
| 摘要与原文冲突 | 同 item 双版本、模型引用错误版本 | 强制 version/source 标记；必要时只保留 locator+full |
| ledger 增加 IO | session 延迟、写入队列堆积 | best-effort async；限制摘要大小；关闭索引写入 |
| typed result 过度僵化 | child 频繁 blocked、协议解析失败 | 保留 human-readable summary；协议失败进入 partial，不丢原文 |
| cache 假设错误 | 实际账单偏差、provider 行为不一致 | capability registry；未知按 miss 估算 |
| 权限绕过 | 子任务读取/写入越界 | projection policy 与 permission service 双重检查；安全测试优先 |
| 自动优化回归 | benchmark score 下降 | 只允许冻结 benchmark 上严格改善的候选写回 |
| 范围膨胀 | 同时改 compaction/router/tool/MCP | 阶段门禁；M0-M3 未通过不得进入 M4+ |

### 回滚策略

- feature flag：`typedContextCompiler` 默认为 off，按 workspace/session 开启。
- spawn adapter：projection 失败或超时回退原有 `SubAgentInput`。
- ledger：可删除 projection/index 文件，原始 session 不受影响。
- compact：保留旧 compact 路径，TCC 只作为新 projection provider。
- routing：规则模块独立，关闭后沿用 workspace 当前模型选择。

---

## 8. 交付顺序与执行规则

每个 milestone 按以下顺序执行：

1. 先写 failing BDD test；
2. 运行单测确认失败；
3. 写最小实现；
4. 运行目标单测；
5. 运行相关包 typecheck；
6. 运行全量隔离测试 `bun run test`、`bun run typecheck`，必要时 `lint`、`docs:check`；
7. 更新台账的状态、证据、风险和下一步；
8. 小步提交，提交前检查测试隔离和真实配置目录无残留。

### 推荐首轮执行任务

1. M0-01：定义 shared context 类型。
2. M0-02：建立 fixture 和 ledger recorder。
3. M0-03：接入只读 observability，不改变 Agent 行为。
4. M1-01：实现 deterministic projector。
5. M1-02：完成 projection golden tests。
6. M2-01：为 explorer 增加 projection spawn 试点。
7. M2-02：实现 typed result 解析和持久化。
8. M3-01：建立 5 case 对照 benchmark。

达到 M3 退出条件前，不开始自动 relevance scorer、全局 compaction 改造和成本感知 router。

---

## 9. 预期最终形态

```text
用户任务
  ↓
Task / Policy
  ↓
Durable Context Ledger  ← 原始消息、工具观察、文件事实、artifact、decision
  ↓
Context Projection      ← 按任务/Agent/权限/预算生成可解释视图
  ↓
Model Prompt Compiler   ← provider/model/tool protocol 适配
  ↓
Agent / Subagent
  ↓
Typed Result + Evidence + Artifact
  ↓
Ledger / Eval / 可逆视图更新
```

TCC 不承诺某个模型永远更聪明，也不把 KV cache 当作产品卖点。它提供的是一个稳定的 runtime 边界：模型、工具、subagent 和 compaction 都可以替换，但 durable state、projection、policy 和 evidence 始终可追踪、可验证、可重建。
