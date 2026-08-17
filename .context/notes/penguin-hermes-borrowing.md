# 调研笔记：penguin-harness 与 Hermes-Studio 可借鉴到 gravitas 的点

调研时间：2026-08-16。原始抓取数据在 /tmp/gravitas_research/（penguin_*.json / hermes_tree.json 及源码快照 pcore/ hsrc/ pskills/）。

## 一、penguin-harness（Prism-Shadow，1379★，TypeScript，Apache-2.0）
作者 hi-youga（LlamaFactory 作者）。定位「Let AI Build AI」自演化 harness，优先 DeepSeek，极低成本。
Monorepo：packages/{cli, core, desktop, server, skills, web, landing}。

### 1. Agent 即目录（最值得借鉴的抽象）
每个 agent = `<data>/agents/<id>/{agent_state/{system_config.yaml,AGENTS.md,skills/,memory/,tools/}, scratchpad/, traces/}`。
- `system_config.yaml`：稳定系统层（name/description/version/model.thinking_level），不改 system_prompt。
- `AGENTS.md`：需求层，注入系统提示；承载角色与领域规则。
- `skills/`：frontmatter 自动注入系统提示，`- name — description`，正文按需读；无需注册。
- `agent-vault`: `<agent>/agent_state/.vault.toml`，agent 粒度环境变量凭据；key 名暴露给模型、值永不入上下文；0600 权限；值上限 8KB（Linux env 128KB 限制）。key 名符合 shell 变量命名。

### 2. Self-evolving 闭环（4 个 skill，penguin 的杀手锏）
- agent-creation：从需求写 AGENTS.md + 装技能 + 设元数据。
- benchmark-design：多 Case 能力基准。每个 Case = `statement/README.md`（公开给测试 agent）+ `rubric/README.md`（私有 100 分评分项+Gold）。Pilot 迭代校准难度 → 冻结 Formal Baseline → 写 `scoreboard.yaml`。含一致性与 leak check（公开文件不得泄露 Gold/私有评分）。
- agent-evaluation：隔离 worker（run_subagent），独立 workspace 沙箱跑一次 test agent，私有 rubric 打分，返回**协议化纯 YAML**（protocol_version/status/score/cost/duration_ms/session_id + 4 个稳定错误码 invalid_request/benchmark_invalid/version_changed/evaluation_failed）。防泄漏：Evaluator 不进上下文、不留 narration。
- agent-optimization：evidence→hypothesis→candidate→evaluate→accept/rollback 循环。版本化快照 `<agent>/snapshots/v<N>.tar.gz`（reject 则回滚）。每轮候选严格校验：runtime 一致、分数严格高于 Reference 才接受，且只 append 被接受候选到 scoreboard。
- scoreboard.yaml：版本化的成绩流水（time/version/provider/model/thinking_level/score/cost/duration/cases[].runs[].session_id）。成绩是权威、勿二次计算。

### 3. 极小工具集 + GPT 式环境的克制设计
penguin-core tools 极精简（exec/input-command、read/write/edit-file、diff、describe/read-image、run-subagent、background）。理念：少工具调用、少 token，为开源模型（DeepSeek）深度调优。

### 4. Trace 可观察性（append-only、随上下文分段）
`<agent>/traces/<yyyy-mm-dd>/<sessionId>_<index>.jsonl`。每段 model context 对应一个文件，compaction 后 rotate 新文件；只记 session_meta/完整 model_msg/event_msg，streaming partial 跳过后在段结束时补齐；子会话消息不重复记录，只写 `subagent` 指针事件。可 resume。

### 5. skill-porting（外部生态移植）
无插件机制；从 Claude Code marketplace / Codex plugins / skills.sh / GitHub 抓取 skill，扁平化 frontmatter（只认单行 key: value），完整审查每个文件（拒绝泄密/回连/混淆/篡改安全规则），pinned revision。frontmatter：name/description/short_description/zh/version/updated。

## 二、Hermes-Studio（JPeetz，315★，TypeScript，MIT）
Hermes Agent（NousResearch）的 self-hosted Web UI/dashboard。React+TanStack 前端 + Node 后端，代理到 Hermes FastAPI gateway。虽然它是「另一个 agent 的 UI」，但其**编排与控制面抽象**极有参考价值。

### 1. capability probing（优雅降级的两级能力模型）
启动探测 gateway 各端点（/health、/v1/chat/completions、/v1/models、/api/sessions、/skills、/memory、/config、/jobs），TTL 120s 刷新。用 404/403 = 端点不存在，400/405/422 = 端点存在（HTTP 方法/形状问题），区分健壮。mode = enhanced-hermes / portable / disconnected。前端据此启用/降级功能。
→ gravitas 可借鉴：统一后端能力自检 + UI 分级（full / limited / offline）。

### 2. Execution Approvals（执行审批 UI 全链路）
后台命令需批准，UI 支持 approve once / approve for session / always-allow / deny，resolved receipt 内联展示，侧栏 pending 徽标。三种批准范围。
→ gravitas 已有 permission-mode（safe/ask/allow-all）与审批队列，可借鉴「本次会话始终允许」的白名单持久化 + 批准范围三态。

### 3. Multi-Agent Crews + Workflow DAG + Templates
命名 crew（goal + ≤8 persona 成员：role/color/model/profile），并行 dispatch 到 all/指定成员，live SSE 活动流，按成员状态。DAG 工作流构建器（拓扑序执行、环检测、每 node 状态、层间等待）。Crew 模板（Research/Build/Review/Deploy 等 7 内置+自定义）。
→ gravitas 已有 sub-agent（code-reviewer/explorer/researcher），可借鉴「可见的 crew 编排 + 模板 + DAG 流水线」的商业化编排视图。

### 4. Profile-Scoped Workspaces（文件系统隔离）
每个 crew member 绑定命名 profile → `~/.hermes/profiles/<name>/`，文件操作 profile-aware，服务端防 path traversal、拒绝 `../`。
→ gravitas 工作区已有隔离（session cwd），可借鉴「成员/profile 粒度文件系统作用域」的沙箱模型。

### 5. Cron Job Manager（唯一内置调度器的 agent UI）
自然语言 prompt + cron 表达式调度、pause/resume、trigger now + live SSE 流式回显到 job 卡、delivery 渠道（TG/Discord/Slack/Signal）、skills 绑定、repeat 次数上限、30s 轮询。
→ gravitas 已有 automation 定时任务，可借鉴「可视化任务队列 + delivery + live run 回放」的用户面。

### 6. SQLite event store + Last-Event-ID 重放（audit/analytics 与 SSE 补发一体）
better-sqlite3（WAL、同步 API、TTL 7 天、per-session cap 10k）。monotonic seq + HTTP Last-Event-ID 协议：EventSource 自动带 Last-Event-ID，重连重放错失事件，零客户端改动。native 不可用时优雅 no-op。audit trail（跨会话时间线）/analytics 都源自它。
→ gravitas 审计已用本地 JSONL，SSE 补发机制值得借鉴（尤其长会话断线）。

### 7. 其它可借鉴
- cost tracking（per-crew/agent token+cost，内置模型价格表 + fuzzy 匹配）
- visual knowledge graph（记忆 wiki-link 力导向图）
- session history archive / patterns & corrections viewer（读 MEMORY.md、SOUL.md 等 identity 文件）
- Identity 文件编辑（SOUL.md/persona.md/CLAUDE.md 浏览器直改）
- gate capability model（feature-gates.ts）、rate-limit 显示 provider 反馈头
- 8-theme 系统、PWA 移动端、systemd auto-start

## 三、与 gravitas 现状对照（关键）
gravitas 已有：Agent SDK/Provider-agnostic runtime、多工作区、MCP、Skill、权限审批队列、审计 JSONL、usage/cost ledger、Automation 定时任务、sub-agent。
gravitas 缺口 / 最值得补：
1. **Agent 单一文件状态 + AGENTS.md 需求层分离**（penguin）——现 gravitas agent 会话/状态分散，penguin 的「agent 即目录」更干净、可移植、可版本快照。
2. **Benchmark/评测回归闭环（自演化）**（penguin）——gravitas 完全没有可度量的 agent 能力评测体系，这是差异化蓝海。
3. **capability probing 优雅降级**（hermes）——同一 UI 面向全功能/精简/离线后端。
4. **Crew/DAG 可视化编排**（hermes）——把 sub-agent 升级为可见 crew + 流水线。
5. **SSE Last-Event-ID 补发**（hermes）——提升实时长会话体验。
6. **skill 外部生态移植/审核流程**（penguin skill-porting）——已有 skills/ 目录大量 skill，可接 marketplaces。
7. **agent 粒度 vault**（penguin）——与渠道级分离的凭据单元粒度。

## 四、落地进度（2026-08-16）

### ✅ 已完成：④ 跨会话持久化「始终允许」白名单（补 approve_for_session 唯一缺口）
核验发现 approve_for_session 本已存在（PermissionBanner 三态 + SessionWhitelist 三档）。本次补齐跨会话持久化：
- `apps/electron/src/types/settings.ts`：新增 `AgentAllowlist` + `DEFAULT_AGENT_ALLOWLIST`，`AppSettings.agentAllowlist`
- `settings-service.ts`：`NESTED_MERGE_FIELDS` 加 `agentAllowlist`
- `agent-permission-service.ts`：新增 `PersistentAllowlistStore`（内存默认=测保隔离 / settings.json 后端=单例），`persistAllow`/`removePersistentAllow`/`getPersistentAllowlist`，`isWhitelisted` 双级命中，WebBridge host 信任持久化；**危险命令(rm/sudo等)/ComputerUse/WebBridge 上传下载绝不持久化**
- `packages/shared` `AGENT_IPC_CHANNELS`：新增 `GET_ALLOWLIST` / `REMOVE_ALLOWLIST_ENTRY`
- `ipc.ts` + `preload/index.ts`：桥接 getAgentAllowlist / removeAgentAllowlistEntry
- `PermissionBanner.tsx`：文案「始终允许 · 跨会话生效」
- 新增 `AgentAllowlistPanel.tsx` 设置面板（查看/移除），挂到 AgentSettings skills tab（空列表自动隐藏）
- 单测 19→23 全绿；electron typecheck 通过

### ⏸ ①②③ 评估为架构/中改动，未贸然实施：
- **① agent 即目录**：需重构 500 行单块 `agent-prompt-builder.ts`（稳定系统层 + per-agent AGENTS.md 需求层），侵入 SDK 提示词注入。建议单独立项先出设计。
- **② capability probing**：桌面同进程无「远程网关探测」问题；已有 CAPABILITY_MANIFEST / claudeAvailable 分支。低改动收益有限，建议并入 ①。
- **③ SSE 补发**：价值在 server/headless 的 HTTP SSE 路由，桌面 IPC 无浏览区 EventSource 断线痛点。已在 server 规划内。

## 五、gravitas 现有代码深度梳理（2026-08-16 二轮）

目标：为 penguin 自演化闭环映射到 gravitas 找到真实 gap 与连接点。

### 现有 Agent 运行时（承接评测闭环的底座，已相当完整）
- **四 runtime adapter**（`agent-orchestrator.ts` + `adapters/`）：`claude`（Claude Agent SDK）/ `proma`（Provider-agnostic）/ `pi`（Pi Agent SDK）/ `ai-sdk`（AISDKAgentAdapter）。装饰者链 `RuntimeRoutingAgentAdapter` 按 runtime 路由。
- **Provider-agnostic AI-SDK runtime core**（`agent-runtime/ai-sdk-runtime-core.ts`）：自建工具循环（streamText + tool 执行 + 权限兜底 + SDKMessage 转换），含 retry、context-compaction、plan mode、AskUser、GoalCheckpoint 工具。
- **runSubAgent**（`agent-orchestrator.ts` ~1105）：同步委派给 `ProviderAgnosticAgentAdapter`，独立 child session `<parent>-<uuid>`，继承父渠道/model/cwd，`permissionMode: 'bypassPermissions'`，MCP 隔离，返回 assistant 文本摘要，`maxTurns` 默认 10。**这正是 penguin `run_subagent` 的对应物**，但缺：隔离工作区沙箱、并行调度、结果结构化（协议化）。
- **collaboration 子 Agent**（`agent-collaboration-tools.ts` + `agent-employee-service.ts`）：真实可见、可交互、可按 ID 追踪的协作子会话，与 runSubAgent 并存。

### Goal 控制平面（离自演化最近、却差关键一环）
- `goal-runtime/goal-coordinator.ts` + `goal-store.ts`：Goal 状态机（active/waiting/blocked/completed/cancelled）+ Checkpoint（`GOAL_CHECKPOINT_TOOL_NAME` 工具，outcome=continue/waiting/blocked/complete）+ 验收条件 `acceptanceCriteria` + `evidence`（test/command/file/tool/user）+ 唤醒触发（immediate/at/user_input/interaction/external_task/file_change）。
- 自动续跑：`setContinuationRunner` → `runAgent(..., runtimeInstruction=内部指令)`，`MAX_IMMEDIATE_CONTINUATIONS=3`，`recoverDueGoals` 跨应用重启恢复。
- **定位**：这是「面向用户目标的自我驱动循环」，不是「面向 benchmark 分数的优化循环」。它已经会调度、续跑、持久化——penguin 自演化需要的一切机制它基本都有，只缺「可比较的分数维度」。

### 权限安全（评测沙箱可用）
- `AgentPermissionService`：会话白名单 + 跨会话持久化 allowlist（本次已补）+ safe/plan/bypass 多态 + 危险命令/ComputerUse/WebBridge 逐次确认。
- `checkToolPermission`（ai-sdk-runtime-core）：bypassPermissions 全放行——评测子代理可全自动运行（与 penguin `--approve allow-all` 等价）。

### 明确缺失（= 自演化的真实 gap）
1. **无可评估能力 Benchmark**：无 statement/rubric/score 结构，无 benchmark 目录/配置。
2. **无版本化 Agent 状态快照**：session 存 JSONL；但无「Agent 状态版本 + 快照 tar.gz + 回滚」机制（penguin `snapshots/v<N>.tar.gz`）。
3. **无分数驱动 accept/rollback 优化循环**（penguin agent-optimization）。
4. **无 scoreboard/回归成绩流水**：只有 marketing content-audit 内容评分，与 agent 能力无关。

### 关键结论（连接点）
- gravitas 的 `runSubAgent` + `goal-runtime` + 权限多态已提供 penguin 自演化闭环 80% 的运行机制；缺的是「评测数据模型 + 版本快照 + 分数决策」这 20% 的领域层。
- 最小落地：**新建一个 benchmark/self-evolution 数据层**，复用 goal-runtime 的调度/续跑与 runSubAgent 的委派，不侵入现有 Agent/SDK 主路径。
- 「agent 即目录」(①) 与自演化是天然耦合的：版本化快照需要「可整体打包的 Agent 状态目录」，而这个目录本身正是 ① 的目标。建议两者并为一个立项。
