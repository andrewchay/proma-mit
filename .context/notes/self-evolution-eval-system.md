# Agent 能力评测 + 自演化 + Agent 即目录（实现路线）

- 状态：**已落地可用**（2026-08-17）
- 来源：调研 `notes/penguin-hermes-borrowing.md`；设计 `plan/self-evolution-design.md` + `plan/agent-as-directory-design.md`
- 本文档是「实现后」的权威参考：文件地图、里程碑、真实验证、已知边界与后续方向。

## 一、能力全景

从两个开源项目（penguin-harness 自演化 / Hermes-Studio 编排）调研出最值得借鉴的能力，已全部落地：

| 能力 | 落地 | 对应 borrow gap |
|---|---|---|
| 跨会话「始终允许」白名单持久化 | ✅ M0–? | gap ④ |
| **Agent 能力评测闭环**（benchmark→evaluate→scoreboard） | ✅ M0–M1 | gap ① |
| **Builder 自演化优化**（evidence→candidate→accept/rollback） | ✅ M2–M4 | penguin 杀手锏 |
| **采纳写回 → 影响真实 agent 行为** | ✅ M5 | — |
| **UI 评测面板**（Settings→评测 tab） | ✅ M6 | — |
| 真实端到端验证 | ✅ M7 | — |
| runsPerCase 多次运行取平均 | ✅ M8 | penguin runs 概念 |
| **Agent 即目录**（system_config.json + AGENTS.md） | ✅ D1–D4 | gap ① 深化 |

## 二、文件地图

### 评测 / 自演化核心（`apps/electron/src/main/lib/agent-runtime/eval/`）
- `types.ts` —— Benchmark/Rubric/Scoreboard/EvalRunResult/SelfEvolveChange 类型
- `benchmark-store.ts` —— benchmark/rubric/scoreboard 读写 + `listBenchmarks/getBenchmarkDetail/createBenchmarkForUI`
- `evaluator.ts` —— `evaluateCaseRun`（隔离沙箱 + 规则/LLM 打分 + 4 错误码）
- `self-evolver.ts` —— `selfEvolve`（Baseline→候选→快照→accept/rollback）
- `commands.ts` —— `runBaseline/runImprove` 编排 + `evaluateCaseAcrossRuns`（runsPerCase 平均）
- `eval-runner.ts` —— 真实渠道解析 + delegate（ProviderAgnosticAgentAdapter）+ builtin StateGuard
- `builtin-agent-state.ts` —— 内存快照/回滚（评估用）
- `builder.ts` / `builder-prompts.ts` —— Builder LLM 候选生成（纯模板可单测）
- `builtin-agent-overrides.ts` —— legacy JSON override（迁移过渡）
- `eval-service.ts` —— `runEvalBaseline/runEvalImprove/adoptBuiltinPrompt/...` 服务 + IPC
- `e2e-real.ts` —— 真实模型端到端验证（Proma Cloud 传输，CLI 可跑）

### Agent 即目录
- `apps/electron/src/main/lib/agent-definition-store.ts` —— 读目录/合并/迁移/写 AGENTS.md+bump version
- `apps/electron/default-agents/<id>/{system_config.json, AGENTS.md}` —— 内置 seed（随包）
- `~/.gravitas/default-agents/<id>/` —— 用户可写（seeded + semver 同步）
- `config-paths.ts` —— `getDefaultAgentsUserDir/getAgentDir/parseAgentDirVersion/seedDefaultAgents`

### 接线
- `agent-prompt-builder.ts` —— `buildBuiltinAgents()` 改为 `dir > override > code` 优先
- `agent-orchestrator.ts` —— `runSubAgent` 透传 `workspaceDir`（评测沙箱）
- `agent-runtime/types.ts` —— `SubAgentInput.workspaceDir?/systemPrompt?`
- `packages/shared/src/types/agent.ts` —— `AGENT_IPC_CHANNELS.*EVAL_*`
- `ipc.ts` + `preload/index.ts` —— 全套 EVAL IPC 桥接
- `index.ts` —— 启动 `seedDefaultAgents` + `foldLegacyAgentOverridesIntoDirs`

## 三、使用方式
- **UI**：Settings → Agent → 评测 tab（新建 Benchmark → Baseline → Improve(autoAdopt) → 看 scoreboard 趋势）
- **IPC**：`EVAL_RUN_BASELINE / EVAL_RUN_IMPROVE / EVAL_ADOPT_PROMPT / EVAL_CLEAR_PROMPT / EVAL_LIST_PROMPTS / EVAL_LIST_BENCHMARKS / EVAL_GET_BENCHMARK / EVAL_CREATE_BENCHMARK`
- **CLI 验证**：`bun run apps/electron/src/main/lib/agent-runtime/eval/e2e-real.ts`（真实模型，Proma Cloud）

## 四、关键设计决策
1. **沙箱隔离**：评测子代理 cwd 指向独立 `eval/runs/<id>/`，只拷 Case 公开 statement，rubric 绝不入被测上下文。
2. **协议化返回**：被测方按固定 JSON 行结尾输出，评分优先解析；规则打分兜底。
3. **strictly-higher 才 accept**：候选分数必须严格高于 Reference才接受，否则回滚；被拒候选不进 scoreboard。
4. **采纳写回**：`adoptBuiltinPrompt` 或 UI「审查并采纳」写 agent 目录 `AGENTS.md` + bump `system_config.version`，即改即生效。
   - **安全默认**：`runEvalImprove` 的 `autoAdopt` 默认 **false**——跑 Improve 只把被接受候选分数与 prompt 记入 scoreboard/返回，**不自动写回**内置 sub-agent 行为。
   - UI 在 Improve 后展示被接受候选 → `审查并采纳` 显式触发（或「放弃」）；也可在面板「恢复默认」。
   - 直接改 IPC 或程序时如需一键写回，显式传 `{ autoAdopt: true }`。
5. **Agent 即目录**：稳定层(`system_config.json`) + 需求层(`AGENTS.md`) 分离；目录优先于代码默认与 legacy override。
6. **版本 anchor**：`system_config.version` 用于 semver seed 同步 + 自演化版本追踪 + 未来目录级快照。

## 五、真实验证（M7/M8）
- Proma Cloud（gpt-5.6-luna）真实模型端到端：accept 与 rollback 均正确触发。
  例：baseline 23 → round1 43 接受 → round2 53 接受；另一 run baseline 44 → round1 50 接受、round2 44 拒绝回滚。
- 40 单测（35 eval + 5 agent-dir）+ monorepo typecheck 全绿（7 包）。
- 真实 config 无残留；所有测试隔离 `PROMA_TEST_CONFIG_DIR` 临时目录。

## 六、边界与已知限制
- **规则打分偏保守**：关键词启发；真实评测建议 `scoreDelegate`（LLM 打分）。
- **单次评测随机性**：已支持 `runsPerCase>1` 取平均，但多 Case 成本线性增加。
- **渠道密钥**：真实产品路径需 Electron safeStorage（CLI 无法解密），真实调用在 Electron 内（UI 面板触发）。
- **内置 sub-agent 范围**：当前只对 code-reviewer/explorer/researcher 评测/采纳。

## 六·五、数据迁移 / 备份 / 团队分发覆盖（2026-08-17 补齐）
新增功能产生的本地路径已纳入 `migration-service.ts`：
- 新增组件 **`evalsystems`（评测与 Agent 定义）**，个人备份(.gravi-backup)默认包含、团队分发(.gravi-team)可勾选：
  - `eval/benchmarks/**`（benchmark + scoreboard + case statement/rubric；**排除 throwaway 的 eval/runs/**）
  - `default-agents/**`（用户采纳的 sub-agent 定义：system_config.json + AGENTS.md）
  - `settings.json` 的 `agentAllowlist` 子集（持久化「始终允许」，仅导出该字段，不拖走其它设置）
- **导出与导入两端都已接入**：导出 `_addEvalSystems`（v1/v2 两处 dispatch）、导入 `_importEvalSystems`（v1 confirmImport / v2 _confirmImportV2 两处 dispatch），round-trip 完整。
- 不含任何 API Key 凭据，个人+团队均可安全携带。
- 涉及文件：`migration-service.ts`（`_addEvalSystems`/`_importEvalSystems` + 4 处 dispatch）、`MigrationSettings.tsx`（组件选择 UI）、`migration-evalsystems.test.ts`（mock-Electron 导入往返单测，验证 benchmarks/default-agents/allowlist 都能还原）。

## 七、后续方向
1. **内置 benchmark 模板**：给 code-reviewer 预置几个高质量 Case，开箱即用（对齐 penguin benchmark-design）。
2. **目录级快照/回滚**：`system_config.version` 已 anchor，下一步整个 `default-agents/<id>/` tar.gz 快照 + rollback（覆盖 tools/description 变更）。
3. **候选策略精细化**：Builder 分段指令微调、单 Case 定向优化，而非全局 prompt 改写。
4. **评分准确度**：接入 LLM scoreDelegate + rubric 设计最佳实践。
5. 有缘时把 `builtin-agent-overrides.json`（legacy 迁移残留读写）彻底移除。
