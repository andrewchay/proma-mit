# 设计：Agent 即目录（agent state 外化为文件）+ 自演化快照目录级升级

- 状态：**计划待审批**
- 日期：2026-08-17
- 关联：`research/penguin-hermes-borrowing.md`（gap ① + 与自演化快照耦合）；`plan/self-evolution-design.md`（M0–M8 已落地）

## 0. 目标

把内置 sub-agent（code-reviewer / explorer / researcher）从**代码常量**（`buildBuiltinAgents()`）外化为
**目录文件**，实现 penguin 的「agent 即目录」：
- `system_config.json` = 稳定系统层（name/description/version/tools/model）
- `AGENTS.md` = 需求层（角色/领域规则，即 agent 系统提示正文）

并让**自演化的"采纳写回"从 prompt 级升级到目录级**：写 `AGENTS.md` + bump `system_config.version`，
目录整体可作为快照/回滚单元（升级 `builtin-agent-overrides.json` 与内存快照）。

## 1. 现状（已核验）

- 内置 sub-agent 定义硬编码在 `apps/electron/src/main/lib/agent-prompt-builder.ts` 的
  `buildBuiltinAgents(claudeAvailable)`，`AgentDefinition`（`description/tools/model/prompt/d`）。
- 三个调用点：
  1. `agent-orchestrator.ts:2469` —— SDK `agents:` 选项（主 Agent 按名 spawn）
  2. `agent-orchestrator.ts:1107` —— `runProviderAgnosticSubAgent` 读 `def.prompt`
  3. 自演化 `builtin-agent-state.ts` —— 快照/回滚被测 prompt
- 自演化「采纳写回」现用 `builtin-agent-overrides.json` 存 prompt 覆盖（M5），`buildBuiltinAgents`
  返回前合并覆盖。
- 已有成熟「默认资源 seeding + semver 同步」模式 `seedDefaultSkills()`（`config-paths.ts:746`），
  default-skills 目录在 `apps/electron/default-skills/`。

## 2. 目标目录布局

```
apps/electron/default-agents/<id>/        # 源码内置（随包同步）
  ├── system_config.json                  # 稳定层：name/description/version/tools/model 变化受限
  └── AGENTS.md                           # 需求层：系统提示正文（行为来源）

~/.gravitas/default-agents/<id>/          # 用户可写（seeded 一次 + semver 升级）
  ├── system_config.json
  ├── AGENTS.md
  ├── skills/                             # 预留：per-agent skill（可选，本期可不建）
  └── memory/                             # 预留：per-agent memory（可选）
```

## 3. 数据模型

`system_config.json`（gravitas 用 JSON，契合现有约定；沿用 penguin 的稳定层/需求层分离语义）：
```jsonc
{
  "id": "code-reviewer",
  "name": "Code Reviewer",
  "description": "代码审查子代理。在完成代码修改后调用，审查代码质量…",
  "version": 1,                          // 采纳写回时 +1，用于 semver 比较与目录快照
  "tools": ["Read", "Glob", "Grep", "Bash"],
  "model": "haiku",                      // 可选；缺省继承主 Agent
  "createdAt": "2026-08-17T00:00:00Z",
  "updatedAt": "2026-08-17T00:00:00Z"
}
```

`AGENTS.md` = 现在的 `AgentDefinition.prompt`（行为正文），可读可写。

## 4. 运行时改造

### 4.1 `default-agents` 目录读取 + 合并（核心抽象）

新增 `agent-runtime/agent-definition-store.ts`：
```ts
// 读取某个内置 agent 的目录定义；目录/字段缺失时回退代码默认（向后兼容）
function readAgentDir(agentId, codeDefault): AgentDirState | null

// 把目录状态转成 SDK 认识的 AgentDefinition
function agentDirToDefinition(dir): AgentDefinition

// buildBuiltinAgents 现在：对每个内置 id，优先读目录 → AGENTS.md=prompt，
// system_config.tools/description/model → AgentDefinition；否则用代码默认兜底。
```

### 4.2 `buildBuiltinAgents()` 改造

`agent-prompt-builder.ts` 的 `buildBuiltinAgents()`：
- 初始化：内联一份**代码默认**作为 seed 源。
- 运行时：对每个 id，`readAgentDir(id, codeDefault)` 读取用户目录；若存在且优先，用它生成
  `AgentDefinition`（`prompt=AGENTS.md` 内容，`tools/description/model` 从 `system_config.json`）。
- 移除/降级现有的 `builtin-agent-overrides.json` 合并（被「写 AGENTS.md」取代）——向后兼容期间
  保留并优先于目录；迁移完成后删除。

### 4.3 自演化「采纳写回」升级（M5 → V2）

- `builtin-agent-state.ts` 的 `buildBuiltinStateGuard`：快照/回滚对象从「prompt 字符串」升级为
  「`<id>/` 整个目录」— 沙箱评测用临时副本，采纳时原子写 `AGENTS.md` + bump `system_config.version`。
- `eval-service.adoptBuiltinPrompt` → `adoptAgentDirectory(agentId, { agensMd, versionBump })`。
- 保留 `builtin-agent-overrides.json` 作为迁移过渡，迁移完成移除。

### 4.4 保留「自演化闭环 + UI 面板」不变

整个 eval M0–M8 的对外接口（IPC `EVAL_*`、`EvalPanel`）保持不变，只是内部读写从
「JSON override」换成「目录文件」。对用户无感知，甚至更透明（可在磁盘直接编辑 `AGENTS.md`）。

## 5. 文件级改动清单

**新增**
- `apps/electron/src/main/lib/agent-runtime/agent-definition-store.ts` —— 目录读取/合并/转 AgentDefinition
- `apps/electron/default-agents/{code-reviewer,explorer,researcher}/{system_config.json, AGENTS.md}`
  —— 从 `buildBuiltinAgents` 现有定义 seeding
- `config-paths.ts`：`getDefaultAgentsDir()` / `getAgentDir(id)` + `seedDefaultAgents()`（镜像 seedDefaultSkills）
- 单测：`agent-definition-store.test.ts`（目录读取/合并/回退/semver）

**改动**
- `agent-prompt-builder.ts`：`buildBuiltinAgents()` 改为读目录（回退代码默认）
- `agent-runtime/eval/builtin-agent-state.ts` + `eval-service.ts`：快照/采纳升级到目录级
- 移除 `builtin-agent-overrides.ts`（迁移后可删，或保留兼容）

**不动**
- eval IPC / `EvalPanel` / `commands` / `self-evolver` / `evaluator` 对外接口（仅内部数据源换目录）
- session/workspace 存储

## 6. 边界与风险

- **兼容性**：读不到目录或字段缺失 → 回退代码默认，绝不崩。老用户 `builtin-overrides.json` 迁移优先。
- **不做**：本期不建 per-agent `skills/`、`memory/` 的运行时注入（仅预留目录结构）；
  不引入 YAML 依赖（用 JSON 契合 gravitas 约定）。
- **版本**：`system_config.version` 由采纳写回 bump；目录级快照（tar.gz）作为自演化回滚单元，
  比现有的 `builtin-agent-overrides.json` 更完整（覆盖 tools/description 变更）。

## 7. 里程碑（已完成 ✅）

- **D1 ✅**：`default-agents/{code-reviewer,explorer,researcher}/{system_config.json, AGENTS.md}` 三个目录（从现有代码 seed）；
  config-paths 新增 `getDefaultAgentsUserDir/getAgentDir/parseAgentDirVersion/seedDefaultAgents`；index.ts 启动调度；
  electron-builder extraResources 加 default-agents。
- **D2 ✅**：`agent-definition-store.ts`（`readAgentDirState` 无副作用、`getBuiltinAgentDefinition` 目录优先/回退代码默认、
  `foldLegacyAgentOverridesIntoDirs` 迁移 legacy override）；`buildBuiltinAgents` 改为 `dir > override > code` 优先级。
- **D3 ✅**：自演化采纳写回升级目录级——`eval-service.adoptBuiltinPrompt` 与 `runEvalImprove.autoAdopt` 改 `writeAgentAgentsMd`
  （写 AGENTS.md + bump system_config.version）+ 清 legacy override。真实 e2e 复跑 confirm accept/rollback 正常。
- **D4 ✅**：40 单测（35 eval + 5 agent-dir）全绿；monorepo typecheck 全绿（7 包）；真 config 无残留。
