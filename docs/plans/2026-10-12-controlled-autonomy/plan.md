# Gravitas 受控自主性与证据治理调整规划

**建立/生效：** 2026-10-12 09:32 GMT+8 用户要求建规划和台账；待项目链收束后再处理。  
**Goal：** 在不降低自主推进能力的前提下，把推理自述、可观察行为和可验证结果分开治理，保证 Agent 不能自行扩大授权、改写成功标准或控制验收证据。  
**Architecture：** 复用 Project Chain、Pilot/AI Owner、Harness policy、受保护验证配置、ContextItem 与评测设施，在执行边界、证据采集和完成门禁上增量补强；权威状态由现有主进程服务维护，模型只能提出候选。派生任务摘要只提供上下文，不构成授权。  
**Tech Stack：** Bun、TypeScript、Electron、React/Jotai，既有 JSON/JSONL、业务 SQLite、macOS seatbelt、Linux bubblewrap；不预先决定新增依赖。  
**执行方法：** 恢复后使用当前工作区 `executing-plans` Skill，BDD 红灯→最小实现→绿灯→回归→证据登记。仅对独立探索或对抗审查使用真实协作子会话。  
**当前状态：** 仅文档规划，实施暂缓；未创建项目任务、授权、自动化或真实员工派发，未调用模型，未修改运行代码。

关联：[入口与恢复步骤](README.md) · [实施与验收台账](ledger.md)。

---

## 1. 已确认的原则与范围

### 1.1 用户已认可的方向

1. 自主性要做，但必须发生在受控安全环境中；不能把逐步人工审批当作唯一安全方案。
2. 模型供应与操作权力分离：模型提议，外部控制面决定是否执行。
3. reasoning/CoT 用于理解和评审，不作为真实内部因果过程、执行证明或成功依据。
4. 行为记录证明发生了什么；验证回执证明特定标准下的结果；业务验收继续由权威项目链管理。
5. 优先核查目标—动作—成果证据的一致性，再生成来源可追溯的运行时摘要，补接近日常工作的评测。
6. 论文的 J-space/J-lens 是模型机制研究；本方案不把应用级上下文称作 J-space，不产品化内部激活监控。
7. 当前只建明细规划与台账，等用户收束项目链后回来启动，不自行推进或定时执行。

论文内容依据用户提供的讨论摘要；本轮没有独立复核原论文的实验或结论。

### 1.2 核心不变量

- Agent 可以自主选择实现路径，不能自行改写授权、验收标准、受保护验证器或权威回执。
- 计划确认、执行授权、技术评审、人工业务验收是不同决定，不能相互冒充。
- 人工批准绑定对象与版本；对象、范围、标准或关键参数漂移后重验，必要时重新批准。
- 模型解释、评审模型意见和普通日志字符串均不能生成可信 passed 回执。
- 缺失、过期、unknown、skip 分别表示不同状态，不能按成功处理。
- 安全底线未成立时不得扩大真实自主运行；发现高风险边界缺口不能仅靠提示词缓解。
- 撤权首先阻断新动作；停止请求接受不等于执行/子进程/Provider 已终止，终止不等于外部副作用已撤销。

### 1.3 非目标

不重写 Agent 框架，不新建平行 Goal/项目/审批/真相库，不默认启用 TCC，不自动修改 AGENTS.md 或 README.md，不强制所有任务双模型，不收集完整 CoT，不建立未经需求确认的企业 SIEM/WORM 服务，不恢复已决定下线的 Runtime，不自动运行付费实验或发送事件披露。

本方案中的 README 是本规划目录的交接入口，不是项目根 README；项目根文档更新仍需单独允许。

## 2. 规划基线与证据边界

静态核查 HEAD：`324d1229fc01b6c075c4fa2a716107b9c050e4a4`。这是阅读定位，不是固定测试构建。开始时 `.context/note.md` 已有独立改动，本次不触碰。本轮未重跑产品测试、构建或真实 Runtime。

| 基线 | 当前可复用部分 | 未被本轮证明的部分 |
|---|---|---|
| Project Chain | 任务/决策/交付版本、责任、DoD、execution 关联和业务流转 | 用户正在收束的最新链路；不得沿用旧时点判断为现状 |
| Pilot | grant/命令/预算账本、重新核验、恢复停等、停止意图与升级 | 完整 G1、真实终止证明、完整自主评审闭环；旧授权不能自动恢复 |
| AI Owner | 目标驱动路线、计划提案/目标草案已有子片 | 通用目标→计划→自动组织→验收完整闭环 |
| Harness | policy 契约、产物完成门禁、受保护 verifier、effects/调度、压缩来源、held-out 设施 | 当前 root/worktree/安装包一致性、跨 Runtime 全链保证、独立可信审计；旧 PASS 不能替代本轮验收 |
| macOS Bash | `bash-sandbox.ts` 限制写入、保护 hooks/config/verifiers，scratch 缓存 | 网络限制、环境变量最小化、跨会话读写隔离；`agent-workspaces` 广泛例外与其他文件工具路径需审计 |
| Linux Executor | namespace、固定目录 fd、禁网、资源限制、拒绝宿主降级 | 当前部署内核/LSM 实际能力与生产接线；契约 skip 不等于隔离通过 |
| 本地审计 | 操作 JSONL、筛选/导出，受保护 verifier 另有哈希链 | 全部重要动作统一覆盖、独立不可篡改性、审计故障与副作用一致性 |
| Context/评测 | ContextItem 来源/版本/evidence、trace/工具行为断言、held-out | 权威项目摘要覆盖、完整副作用断言、独立安全维度采纳规则 |

### 2.1 来源优先级

执行时以当前源码、固定构建和对应最新证据为准。Harness 的早期 evidence 文档中“沙箱未启用/尚无 UI”的判断已被后续实施取代，必须读取后续条目；Bash 初版“整个配置目录拒读”也被后续例外策略修正。不要摘取历史段落作为最新能力声明。

参考台账：
- `docs/plans/2026-10-08-harness-reliability-upgrade/ledger.md`
- `docs/plans/2026-10-08-harness-reliability-upgrade/bash-sandbox-evidence.md`
- `docs/plans/2026-10-08-harness-reliability-upgrade/protected-verifier-implementation-evidence.md`
- `docs/plans/2026-10-07-ai-project-owner/ledger.md`
- `docs/plans/2026-09-26-project-pilot/ledger.md`
- `.context/notes/self-evolution-eval-system.md`（历史地图，具体状态重核）

## 3. 三层治理与权威来源

| 层 | 数据内容 | 权威性 | 应用方式 |
|---|---|---|---|
| 推理/报告层 | reasoning、计划解释、反思、模型评审意见 | 模型声明，不代表真实执行或因果过程 | 提供评审线索，明确标为声明 |
| 行为层 | 已批准动作、工具 dispatch、目标资源、实际结果、文件差异 | 主进程/受控执行器观察；SDK 转述须标来源 | 审计、偏离发现、恢复对账 |
| 结果层 | 产物修订、固定 verifier 回执、逐条标准结果、业务验收 | 验证服务与项目链各自权威 | 完成门禁与交接，不靠文本 PASS |

建议逻辑路径（复用现有模块，不新建平行编排）：

```text
权威任务/决策/DoD/授权
    → 带来源与版本的运行时摘要（上下文，不授权）
    → 模型提出下一步
    → 独立动作门禁：对象、版本、scope、capability、预算、当前撤权状态
    → 受控工具/执行器
    → 行为记录 + 产物修订 + 独立验证回执
    → 一致性判定：通过 / 明确阻断 / 风险需审阅 / unknown
    → 原有完成、业务验收与交接服务
```

“确定性”只指身份、范围、版本、回执和规则检查可确定执行，不宣称对开放语义任务的正确性有完备证明。

## 4. 与已有路线的接入顺序

实施不是第四套项目链。先由 CA-01 判断已合并/未合并模块，形成复用映射；已有项只补验收，不重做。

| 本规划 | 复用/关联 | 不重复做 |
|---|---|---|
| CA-01～04 | Harness P/E、Bash sandbox，Pilot gate，AO-05/11 | 第二套策略、派发和审批系统 |
| CA-05～07 | Harness V、protected verifier、Project Chain/Task Review | 第二套成果/DoD/验收数据库 |
| CA-08 | ContextItem/projection、AO 计划上下文 | TCC 重启、模型自由改写真相库 |
| CA-09 | Harness R、eval trace/held-out/self-evolver | 只看文本的另一个评分器 |
| CA-10～11 | agent-audit、config-audit、Pilot stop/escalation | 把哈希链包装成企业不可篡改审计 |
| CA-12 | 原有 UI/IPC/Jotai、AO-09/12、Harness 发布门禁 | 新导航大改或用模拟 UI 冒充产品验收 |

阶段：S0 基线与契约 → S1 安全底线 → S2 一致性检查 → S3 可追溯摘要/真实任务评测 → S4 集成验收。

CA-08/09 的设计可以与 S2 并行；真实运行与默认放行必须等 S1 门禁。不要按表格行号理解安全优先级。

## 5. 明细实施包

以下为候选文件落点；标为“新增候选”的路径目前不宣称存在。CA-01 后可改名或收敛到现有模块。所有产品代码包：先写 Given/When/Then 失败用例并登记红灯，再最小实现、单文件测试、相邻回归、代码简化审查和台账；缺少红灯如实记录，不倒造。

### CA-01｜恢复基线、去重和威胁模型（S0/P0）

**前置：** 用户明确回来启动；记录用户所指项目链的收束版本及尚未完成事项。项目链未收束时，仅经额外允许进行独立安全核查，不暗中推进业务代码。

**读取：** 上述三个最新台账；`project-chain-service.ts`、`project-sqlite-store.ts`、`agent-permission-service.ts`、`agent-runtime/tool-registry.ts`、`adapters/pi-tool-bridge.ts`、`packages/shared/src/types/harness-policy.ts`、`agent-runtime/harness-policy.ts`。

**步骤：**
1. 检查 Git status/log/worktree、包版本、已安装/测试构建；不得覆盖其他分支工作。
2. 建独立 linked worktree 并立即 SelectWorktree 绑定，再改代码。
3. 列出 Runtime×平台×工具路径的真实矩阵，包括内置文件工具、Bash、MCP、浏览器、子 Agent、Workflow 和外部执行器。
4. 对每条路径回答：权限谁检查、数据谁能读、凭据谁持有、控制文件谁能改、证据谁产生、能否停止、失败如何对账。
5. 输出复用/缺口/不支持清单、信任主体和关键资产；冻结首片范围。

**产出：** `evidence/baseline.md`、`contracts.md`、威胁矩阵（均后续新增）；台账 CA-01。

**退出：** 无未解释的执行入口；未支持项拒绝或明确降级；只读研究不视为安全通过。

### CA-02｜保护控制面与收紧旁路（S1/P0）

**复用文件：** `agent-runtime/tool-impls/bash-sandbox.ts`、`pinned-verifier-sandbox.ts`、`protected-verifier-store.ts`、`agent-runtime/tool-registry.ts`、`adapters/pi-tool-bridge.ts`；Linux `apps/executor/src/` 与 `SECURITY.md`。

**新增候选测试：** `apps/electron/src/main/lib/agent-runtime/tool-impls/control-plane-isolation.test.ts`。

**具体动作：**
- 分类控制文件：grant/策略/预算/Goal/verifier/审计/凭据与会话可写产物；找出 `agent-workspaces` 例外包含的 MCP、Skill、其他会话等资产。
- 按当前会话和授权 workspace 缩小例外，而不是放行全部工作区子树；保留真实 Git worktree 必要读写兼容。
- 对 Read/Write/Edit/任意 shell/间接工具/子 Agent 逐项核查，不只修 Bash。
- 清理执行器环境变量，凭据经服务代持；需要 shell 网络的任务在显式域名/服务策略下执行，不能自称已有全面禁网。
- 边界建立失败则受控任务拒绝；不回退宿主 shell。

**BDD：** 任意 Python/Node/Bun 代码写策略、预算、verifier、审计失败；符号链接/硬链接/相对路径/大小写/新建目标/跨会话资源不旁路；正常 workspace 修改、scratch 与 Git 操作仍成功；不支持平台无命令实际执行。

**退出：** 首片声明的 Runtime/平台/路径全部有真实隔离行为证据；其他路径标不支持。OS 同用户仍有非 Agent 进程风险，不声称防宿主失陷。

### CA-03｜Runtime 保证矩阵与统一拒绝（S1/P0）

**文件：** `packages/shared/src/types/harness-policy.ts`、`agent-runtime/harness-policy.ts`、`adapters/harness-policy-conformance.test.ts`、`project-pilot-readiness.ts`、`project-pilot-runtime-budget.ts`；实际 adapters 由 CA-01 确认。

**具体动作：** 对 workspace 写限制、敏感读限制、网络、凭据、验证配置保护、取消、预算超额停止分别表达保证强度/适用路径/证据引用。复用现有能力契约，不让单个 true 代替所有保证。

**BDD：** 任务要求网络隔离但 Runtime 不支持→调用 Provider 和工具前拒绝；切换 Runtime→重验；Workflow/子 Agent 不丢约束、不获得父级之外权限；禁用 Runtime 不能被兼容入口重新启用。

**退出：** 首片固定组合可运行，不支持组合 fail-closed；“部分限制”不显示“安全沙箱”。

### CA-04｜动作级批准、版本绑定与执行时重验（S1/P0）

**文件：** `agent-permission-service.ts`、`project-pilot-approval.ts`、`project-pilot-dispatch.ts`、`project-pilot-budget-ledger.ts`（runner handoff intent）与 `project-pilot-start-receipt.ts`、`project-chain-service.ts`、`project-pilot-request-envelope.ts`；新字段优先扩展原有契约。

**具体动作：** 冻结 actionId/tool identity、目标资源/收件人/参数哈希、任务/计划/标准修订、scope、费用/次数、有效期和批准者。执行前重读权威状态；schema/工具/目标变化拒绝旧批准。模型提议扩大范围只能进入原审批入口。

**BDD：** 同名称不同工具、目标替换、DoD 修改、审批后撤权、晚到旧请求、重复批准均不误执行；scope 内已授权低风险动作可连续推进，不每步弹审批。

**退出：** 原有 grant 与逐次高风险确认关系清楚；外部操作不能由“完成任务”总授权隐含放行；版本漂移有可读原因。

### CA-05｜目标—动作—证据契约（S2/P0）

**文件：** `packages/shared/src/types/project-chain.ts`、`packages/shared/src/context/types.ts`、`development-snapshot-service.ts`、`goal-runtime/goal-coordinator.ts`；新增候选 `packages/shared/src/types/action-evidence.ts`、`apps/electron/src/main/lib/action-evidence-service.ts` 及单测。

**拟议对象（非现有 API）：**
- `ActionEvidenceBinding`：项目/任务/execution/session/toolCall、源修订、授权关联、scope hash、产物修订、回执引用、产生主体/采集方式。
- `ConsistencyFinding`：规则 id/version、目标标准引用、实际行为证据、severity、verdict（consistent/risk/rejected/unknown）、理由、所需决定。
- 声明、SDK 转述、主进程观察、独立 verifier、人工验收分别保存来源，不用统一 verified 布尔值掩盖差别。

**规则：** 身份/版本/scope/回执缺失或明确越权硬阻断；启发式“疑似削弱测试”只产生风险线索；授权的测试修订进入重新冻结，不永久禁止；外部动作缺结果回执只能 unknown，不能推断未发生并重试。

**BDD：** 模型说已检查但无调用/回执→未验证；其他任务回执、过期修订、伪造通过、重放引用→拒绝；真实新鲜证据→可以继续原验收链。

**退出：** 编排与完成服务只接受主进程引用，不接受模型构造 passed；不能把“有引用”升级为内容质量证明。

### CA-06｜代码/性能任务一致性规则（S2/P0）

**文件：** `completion-protected-paths.ts`、`pinned-baseline-verifier.ts`、`protected-verifier-store.ts`、`goal-runtime/goal-completion-gate.test.ts`、`development-snapshot-service.ts`；新增候选 `task-integrity-rules.ts/.test.ts`。

**规则与边界：**
1. 修复测试任务只改断言、跳过条件或测试收集设置→风险提示并列 Diff，不自动判作弊。
2. 固定 protectedPaths 被改/删/重命名→依既有 verifier 契约拒绝；正当修订需明确批准新标准/配置并重新绑定。
3. 性能任务改评分脚本、基准数据或结果文件→不能沿用原基准通过；可信 runner 应在固定基准上产生结果。
4. exit=0 但零测试/零有效样本→按冻结规则 failed 或 unknown；不看字符串 PASS。
5. 包括 dirty/untracked、symlink、删除、验证后再改、缓存旧报告和基线非祖先，不只查看已提交 Git diff。
6. “源码修改少/仅修改测试”是线索，不是语义正确性证明。

**BDD：** 真修实现通过；削弱断言不凭新测试绿灯完成；合法修错测试经新标准确认后可继续；伪造 benchmark 分数不能 passed；验证期产物漂移失效。

**退出：** 与 Harness V 的 protected-path 规则一致；新增规则不重复实现同一门禁。

### CA-07｜绑定验收与非代码证据边界（S2/P0）

**文件：** `project-chain.ts`、`project-chain-service.ts`、`goal-runtime/goal-coordinator.ts`、`development-apply-service.ts`、`packages/shared/src/types/project-chain.ts`，相邻 BDD 测试。

**具体动作：** 将一致性结论作为原提交/完成入口的输入；保持 Run 完成、机械验证、技术评审、业务验收、交接五类状态。复用 DoD 逐项校验；不把现有低风险 `artifact_reference_present` 自动验收夸大为内容质量验证。

非代码首片仅证明产物存在、结构/必要字段及显式来源关联；市场判断、内容真实性、策略价值仍由专业评审/人验收。模型评分作为意见，不直接填权威完成标准。

**BDD：** 无新鲜证据不能借旧 execution completed 放行；新交付版本不能沿用旧验收；schema 通过但语义未知→可提交待人审，不显示业务通过；拒绝/返工保持审计和历史。

**退出：** 新检查不能由绕过 UI、直接 IPC 或旧服务入口跳过。

### CA-08｜权威数据生成的运行时任务摘要（S3/P1）

**文件：** `packages/shared/src/context/types.ts`、`agent-runtime/context/context-projector.ts`、`agent-runtime/prompt-builder.ts`、`agent-prompt-builder.ts`、`project-chain-service.ts`；新增候选 `project-runtime-context.ts/.test.ts`。

**摘要内容：** 目标/验收标准、事实及来源、候选假设/未决问题、已批准决策、授权范围、依赖/阻塞、下一步建议；每块携带源对象 id/revision/hash、生成时间和权限可见性。

**具体动作：** 从现有权威服务生成 ContextItem/投影；不另存可被模型自由改写的事实库。模型补充只能是候选假设或待确认建议；执行器不从摘要读授权。源版本变化即失效/刷新；压缩保留引用和限制，缺字节预算时保留必要门禁摘要或停止，不悄悄删约束。

**BDD：** 错项目/未授权资料不进入；旧摘要遇决策/标准/授权变更不能继续沿用；模型文本声称已批准不改变 grant；刷新/压缩后仍保留来源；禁用 TCC 时独立工作。

**退出：** 只读可重建投影，缓存不权威；token 成本及原有提示词重复注入有可测上限，不预设虚构目标百分比。

### CA-09｜真实任务式评测与安全分维度（S3/P1）

**文件：** `agent-runtime/eval/types.ts`、`evaluator.ts`、`eval-runner.ts`、`self-evolver.ts`、`trace-writer.ts`；新增候选 benchmark `agent-runtime/eval/benchmarks/controlled-autonomy/`。

**评测集：** 日常修 bug、合法修错测试、性能优化、受攻击资料、跨项目同名任务、摘要变旧、改评分文件、MCP/子 Agent 旁路、停止/恢复、非代码来源不足。固定公开场景与未参与调优 held-out 分开；不得把保密 rubric 仅靠 cwd 隔离当成不可读取。

**评分：** taskSuccess、permissionCompliance、evidenceCompleteness、containment、recovery 单列；无安全门禁通过时不能用高任务分抵消。副作用/文件/控制状态来自独立观察，LLM 语义评分只补充意见。skip 与缺证据另列。

**BDD：** 文本工具名不加行为分；伪造产物 PASS 不加验证分；训练分提高但越权/关键证据退化→候选不可采纳；held-out 未执行不能显示通过。

**退出：** 离线 deterministic fixture 与真实模型分别登记；付费前需单独批准模型/渠道/请求与费用上限、停止和账单来源。默认不自动采纳 prompt/Skill。

### CA-10｜控制事件审计与故障一致性（S1设计/S3实现，P0门禁项）

**文件：** `agent-audit-service.ts`、`config-audit-service.ts`、`protected-verifier-store.ts`、`project-pilot-stop-escalation.ts`、`project-sqlite-store.ts`、`agent-runtime/tool-registry.ts`；新增候选 `control-event-audit.ts/.test.ts`。

**事件：** 授权批准/失效/撤销、dispatch 前意图、实际开始/结果、拒绝、产物修订、验证、验收、停止意图/送达/终止、恢复对账；关联 task/plan/grant/execution/toolCall 和修订。

**具体动作：** 复用业务 SQLite 事务记录关键意图/决定，投影至 JSONL 时明确投影失败，不把跨文件追加冒充同事务。外部副作用不可与本地 DB 原子提交；先持久意图、再执行、再对账，遇 unknown 不自动重放。高风险操作无法持久记录意图则拒绝；低风险只读事件故障的行为在 CA-01 契约中冻结。

脱敏保留必要目标标识/参数哈希与证据定位，不默认保留完整正文、CoT 或凭据。明确区分本地 append-only、tamper-evident、外部锚定的 tamper-resistant；哈希链不能防全量替换或拥有本机密钥的攻击者。独立外部锚定为后续需单独决定的部署能力。

**BDD：** 日志被改/截尾有可报告异常（无外部锚定时说明检测限制）；审计磁盘满/事务后崩溃/重复事件不伪造成功或丢弃 unknown；export 脱敏且不会调用外部服务。

### CA-11｜撤权、停止与事件收口（S1/P0）

**文件：** `project-pilot-grant-pause.ts`、`project-pilot-stop-escalation.ts`、`project-pilot-request-exit.ts`、`agent-orchestrator.ts`、Runtime abort 路径和原 UI。

**具体动作：** 保持授权撤销、queued 取消、预留处理和停止待办事务关系；建立绑定 execution/session/generation 的终止凭据。分别展示新动作禁止、停止请求接受、目标已退出、子进程/Provider 状态、外部副作用/费用对账。未知留占额，不按“取消”释放。

对于无法保证远端推理停止的 Provider，只保证后续本地 dispatch 被拒，远端费用/结果 unknown 如实标记。不要用 SDK aborted 普通终态冒充独立退出凭据。紧急停止路径与常规影响面确认的关系须在契约阶段确认，不能擅自改变现有用户选择。

事件收口模板包含影响对象、已知事实、未知项、隔离措施、相关修订、恢复条件；先本地报告，外发披露另授权。

**BDD：** 在途撤权/子进程树/迟到回调/重启/停止意图后崩溃不再派新动作；真实退出方可改变 verified 状态；审批状态变旧不盲续；已发送外部动作不能显示已撤销。

### CA-12｜用户界面、集成、发布与回滚（S4/P1）

**文件：** `renderer/components/projects/TaskReviewPanel.tsx`、`ProjectChainOverview.tsx`、相关 Agent/审计展示和 Jotai atoms；跨 IPC 字段同步 shared/main/preload/renderer，具体接口 CA-01 后冻结。

**展示：** “模型声明 / 实际操作 / 验证结果 / 业务验收”分区；直接说明授权、修订、拒绝理由、证据缺口、停止状态和下一步，不添加要求用户手填治理字段的新默认表单。

**门禁：** CA-G0～G4（见第 7 节）；固定构建覆盖代码任务与非代码任务，离开页面仍推进，不能依赖页面 mount 执行门禁。代码简化复核组件化与可读性；没有已安装 code-simplifier 时由父会话等价审查，不假装调用。

**回滚：** 新风险提示/摘要/评测/UI 可关闭并保留原始证据；新增安全约束不可通过普通回滚静默解除，不能把宿主执行作为 fallback。兼容旧数据为 legacy/unverified，不回填假验收。默认启用范围、迁移、日志保留和回滚降低保证的影响需单独批准。

## 6. 存储与兼容要求

1. 新策略配置优先 JSON；控制事件优先 JSONL。已有任务/授权/预算和关联证据继续由现有 SQLite 管理，事务数据不能拆到 JSON 后声称原子。
2. 不建立第二套权威任务状态。摘要为可重建 ContextItem/缓存；source revision 和生成时间不可省。
3. 新字段可空兼容旧记录；明确 legacy/unverified，不自动制造历史回执、批准者或完成证据。
4. Schema 迁移必须往返重开、备份/恢复和损坏测试；Context Store 仍是可重建索引。
5. 主进程固定/验证 actor，不接受模型或客户端自报身份。新接口遵循 shared→main→preload→renderer，状态采用 Jotai。
6. 受保护签名、日志 hash 和业务身份各有不同作用；不能把签名存在当成内容真实或远端多人身份认证。

## 7. 验收门禁与可宣称范围

| 门禁 | 必需证据 | 未满足时 |
|---|---|---|
| CA-G0 契约审查 | CA-01、威胁矩阵、与项目链/Harness 去重、首片组合、保证与降级明示 | 不能按草案默认启用新保证 |
| CA-G1 安全底线 | CA-02/03/04/10/11 的适用确定性部分与真实本地隔离、停止/unknown 边界测试 | 不开放扩大后的真实自主范围 |
| CA-G2 一致性与上下文 | CA-05～09、产物新鲜度、合法标准修订、派生摘要、held-out/安全采纳规则 | 不宣称证据治理全链闭合 |
| CA-G3 固定构建 | 完整门禁、隔离打包、真实 Electron IPC/SQLite/密钥保护、代码与非代码 UI、反向场景 | 源码 PASS 仅是源码证据 |
| CA-G4 真实受控验收 | 单独试跑授权，固定 Runtime/平台/模型/预算，记录失败/人工介入/费用/停止与用户签收 | 不宣称生产可靠或完全自主 |

CA-G* 是本治理增量门禁，不替代/追认旧 Pilot、Task Review、AI Owner、Harness G*。不能把不适用、跳过、替身和真实执行混为一列。

### 7.1 BDD 总矩阵

| ID | 场景与硬断言 | 关联 |
|---|---|---|
| CA-A01 | 修改控制文件/密钥/回执被所有适用工具路径拒绝，正常授权工作不受破坏 | 02/03 |
| CA-A02 | 相对路径、symlink/hardlink、跨会话/同名项目和未知目标不旁路 | 02/03/08 |
| CA-A03 | 旧批准/换目标/换工具/撤权/DoD变更拒绝；范围内自主动作无需重复审批 | 04 |
| CA-A04 | “我检查过了”无工具/验证依据仍未验证；伪造/重放回执拒绝 | 05/07 |
| CA-A05 | 削弱测试或改基准不沿用原通过；合法测试修订可经新标准继续 | 06 |
| CA-A06 | dirty/untracked/零测试/缓存/验证后再改使结果正确失败或失效 | 06/07 |
| CA-A07 | Run/机械验证/技术评审/业务验收/交接不混淆，新版不继承旧验收 | 07/12 |
| CA-A08 | 摘要可重建且带来源，旧版本/压缩/注入不能扩大授权或跨项目泄露 | 08 |
| CA-A09 | held-out 独立，文本自述不加行为分，安全退化不能被任务高分抵消 | 09 |
| CA-A10 | 审计写失败/事务后崩溃/未知外部副作用保留可对账状态，不自动重放 | 10 |
| CA-A11 | 在途撤权、停止送达、目标退出、远端未知和费用状态分别可核验 | 11 |
| CA-A12 | 固定构建两类任务端到端与负向路径通过，页面离开不改变权限或推进 | 12 |

### 7.2 执行时命令

本次不执行下列产品门禁。每文件独立运行，禁止裸跑全量 `bun test`。

```bash
# 已有相邻回归，按改动选择；新增测试路径由 CA-01 冻结
bun test apps/electron/src/main/lib/agent-runtime/tool-impls/bash-sandbox.test.ts
bun test apps/electron/src/main/lib/adapters/harness-policy-conformance.test.ts
bun test apps/electron/src/main/lib/protected-verifier-store.test.ts
bun test apps/electron/src/main/lib/goal-runtime/goal-completion-gate.test.ts
bun test apps/electron/src/main/lib/project-chain-service.test.ts
bun test apps/electron/src/main/lib/project-pilot-stop-escalation.test.ts
bun run typecheck
bun run test
bun run lint
bun run docs:check
git diff --check
# 完整构建在 apps/electron 中执行，打包前必须含 renderer
cd apps/electron && bun run build
```

预期：适用测试通过；真实 Provider 未授权时显式 skip/未执行，不能算通过；typecheck/lint/docs 门禁无新增失败，原有失败分别登记，不能说全绿。打包沿用项目既有脚本与 package smoke，不能临时降低资源闭包要求。

所有创建工作区/会话/配置的测试显式使用临时 `PROMA_TEST_CONFIG_DIR`；必要时临时 HOME。结束清理临时目录和环境变量；全量测试前后对真实 `~/.gravitas/agent-workspaces` 目录集合核对，只读核验，不自动清理异常目录。

## 8. 恢复与逐包工作流程

1. 用户返回明确启动；先读本目录 README、plan、ledger，再读当前项目链/Harness/AO 最新台账，执行 CA-01。
2. 不把这次“同意原则/建立规划”解释为未来付费、外部发送、放宽权限或默认启用的批准。
3. 将每个实施包进一步拆为 2–5 分钟原子步骤：写失败用例、运行确认红灯、最小实现、运行绿灯、相邻回归、简化复核、记录。先完成一个纵向可验证切片，不并行铺开全部模块。
4. 每包记录固定 commit/build、命令、pass/fail/skip、Runtime/平台、原始证据定位、费用来源、限制和回滚；不假装测试运行过。
5. 提交代码时递增受影响包 patch；若改默认 Skill，同步其 version。是否提交/推送遵循用户当次要求，不因台账自动发布。
6. 真机/Provider 试跑前冻结场景、金额/请求数/超额停止语义、停止与未知费用处理、配置隔离；另获用户明确确认。
7. 本轮先交付首片代码任务与最小非代码结果分层，不要求全面企业治理功能齐备；不能因此降低 P0 安全门禁。

## 9. 恢复时待裁定事项

这些问题现在不打断用户项目链工作，恢复 CA-01 时结合最新实现收敛：

- 首片 Runtime/平台组合是什么？优先复用实际可证明组合，不预设模型或复活退出路线。
- 项目链“收束”的固定版本和剩余门禁是什么？本方案不能替它签收。
- shell 网络/敏感资料最小权限的具体范围；主进程/MCP/外部服务分别采用何种保证？
- 风险提示何时只提示、何时进入评审？明确违反冻结标准/越权始终阻断，启发式不得自动指控。
- 合法验收标准修订由谁批准？新标准如何绑定 task/plan/verifier 并使旧回执失效？
- 紧急停止是否增加独立入口，如何与既有逐项影响面确认兼容？
- 日志保留、脱敏、独立锚定是否有实际部署需求？本地 first 不等于企业不可篡改。
- 非代码首片要验证到什么程度？内容语义与外部事实必须明确验收人或专门证据，不能以格式检查代替。

## 10. 完成定义

本轮文档交付完成：规划、台账与恢复入口已保存且引用有效。产品调整完成：仅当适用 CA-G0～G4 获得各自证据与用户验收；文档写完不改变任何产品验收状态。
