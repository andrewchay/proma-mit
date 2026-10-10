# Gravitas Harness Reliability Upgrade 实施台账

> 创建：2026-10-08 18:48 GMT+8 起；基线 HEAD：`6c71b384`。
> 来源：[Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents](https://arxiv.org/html/2609.00006v1)，主要依据 §6、§9、§16。
> 文档性质：实施控制面与验收账本，不是已实现能力声明。
> 当前总状态（截至2026-10-10 17:55 GMT+8，分支 `feat/harness-reliability-upgrade`）：**H00/H01、V01落地；V02部分（新鲜度/严格回读/闭包/配置漂移拒绝）；V03仍阻塞。E01–E05：effects元数据、锁规约、调度器（含跨批次唤醒与实例级并发计数修复）、生产接线（ai-sdk+Pi，锁域=本进程）、生命周期矩阵与重试硬规则已落地，真实运行矩阵未做。M4：P01策略模型/P02钉板/P03一致性矩阵与四Runtime接线/P04只读UI落地；拒绝原因未写审计流。M5：C01–C04压缩Golden链、boundary原文定位、审批链钉板、敏感拦截、Skill stale/幂等落地；矛盾语义检测未实现。M6：R01已有Pi/GLM真实30对调度开关试点（原始严格判定升级29/30、串行基线28/30），多Runtime与历史版本Provider基线未做；R02此前本机门禁+0.12.136打包烟测通过、R04回滚落地。0.12.138全仓门禁通过但未重新打包，CI隔离打包未做。HR07已有真实运行证据（冲突场景窗口零重叠 + 争用侧totalWaitMs=315ms真实锁等待）；HR08真实重叠未观测到（模型发起错峰464ms，调度即时派发）；HR09真实观测与G0–G3未做，正式签名版验证未做。**
> 授权变化：2026-10-08 21:44 GMT+8，用户要求切分支开始实施，已在`feat/harness-reliability-upgrade`独立worktree进行首批代码与离线测试。付费实验、外部操作、默认启用新能力、TCC及ACP接入不在本批范围。
> 执行交接：实施时使用当前工作区 `executing-plans` Skill；逐项先写失败的行为测试，再最小实现、回归、记录证据。不得依赖未安装的 Skill 名称。

**Goal：** 在保留多 Runtime、本地权威存储和既有业务验收规则的前提下，提高完成验证、工具上下文效率、执行安全与策略一致性。

**Architecture：** 复用既有 Goal、CapabilityDescriptor、ContextPacket、审批、研发快照和评测设施。在工具执行和 turn 结束边界增加薄层、版本化契约与主进程权威证据；不重写所有 Runtime，不复活已关闭的 TCC。

**Tech Stack：** Bun、TypeScript、Electron、React、Jotai、现有 JSON/JSONL 与业务 SQLite、既有 Claude/Pi/AI SDK 适配层。无新增依赖决定。

---

## 1. 目标、范围与产品原则

### 1.1 六条升级主线

1. **验证完成**：区分模型退出、机械检查通过、业务验收通过；验证必须对应最新产物。
2. **工具按需加载**：复用既有两层能力目录，评估独立生产接线，减少无关 schema。
3. **工具 effects 与调度**：按真实资源冲突串行，独立只读任务并行；截断调用不产生副作用。
4. **跨 Runtime 策略契约**：明确支持范围、执行边界和失败原因；不能兑现的受控保证 fail-closed。
5. **上下文与学习治理**：压缩保留关键约束和证据定位；记忆/Skill 候选经过原有审批。
6. **ACP 可选接入**：由明确的编辑器或宿主需求决定，非首轮发布前置。

### 1.2 不在本轮范围

- 新 Agent 框架、向量代码 RAG、Agent swarm、A2A 内部通信和重写所有循环。
- 自动改写项目或工作区 AGENTS.md；未经单独授权修改 README.md。
- 默认打开 TCC、重新运行 TCC Provider 实验、自动 relevance scorer。
- 将每次压缩变为新业务会话；新增第二套 Goal、审批、Memory 或权威数据库。
- 用 LLM 自述、日志中的“PASS”字符串或全局测试通过替代产物验证与业务签收。
- 因本台账存在就创建定时任务、真实员工派发、模型调用或 ACP 外部监听端口。

### 1.3 明确边界

- 论文是固定版本源码比较，不是统一基准或因果实验；其采用比例、性能百分比不是本项目验收值。
- 研究对象主要是 coding harness；文档、营销、研究任务需要独立验证器，不能强套代码测试。
- “同一份策略”不等于“所有 Runtime 实现同样的保证”；以能力矩阵和验证证据为准。
- 权限不是 sandbox；预算估算不是实际账单；abort 接受不是进程/Provider 已停止。
- 发现工具、加载 schema、选择模型均不产生执行授权。

## 2. 基线核验与上一轮建议修正

规划基线形成于2026-10-08早轮，只做源码/台账读取。21:44 GMT+8之后的首批实施另有源码审计和离线测试；当前明细见第13节及`contracts.md`。历史私有scoreboard未重新核验。

| 领域 | 已有入口（源码或台账） | 当前判断 | 本升级采取的动作 |
|---|---|---|---|
| AgentGoal | `apps/electron/src/main/lib/goal-runtime/goal-coordinator.ts`；`packages/shared/src/types/agent.ts` | complete 对有验收条件的 Goal 仅要求 evidence 非空；尚非新鲜证据的逐条件核验 | 扩展现有完成门禁，不新建 Goal 系统 |
| 另一类 Goal | `packages/shared/src/types/goal.ts`；`apps/electron/src/main/lib/goal-service.ts` | 长生命周期 Goal 与 AgentGoal 是不同现有对象 | M0 明确关联身份，不从标题匹配或合并存储 |
| 工具目录 | `packages/shared/src/context/capability.ts`、`capability-summary.ts`、`capability-schema-projection.ts` | 已有 access、confirmation、parallelSafe 和按需 schema 模块 | 修正“需要从零开发”的建议；重点为独立生产接线和验收 |
| 工具执行类型 | `apps/electron/src/main/lib/agent-runtime/types.ts` | RuntimeToolDefinition 未表达完整资源 effects | 与已有 descriptor 同源扩展，而非复制目录 |
| TCC 历史决定 | `docs/plans/2026-09-22-typed-context-compiler-ledger.md` M3-07 | 用户决定关闭 TCC、不再实验；M4–M6 作为独立工程里程碑保留 | 禁止借本升级重新开启；独立能力也需新验收，不继承历史 PASS |
| 压缩 | `apps/electron/src/main/lib/agent-runtime/context-compaction.ts`、`agent-session-manager.ts` | 已有结构化 packet、预算缓冲、旧工具裁剪及 compaction archive | 补 fidelity/provenance 测试，不用 lineage 旋转替换业务 session |
| 研发证据 | `apps/electron/src/main/lib/development-snapshot-service.ts`、`development-apply-service.ts`；`docs/storage-contract.md` | 已有快照、验证/应用记录及会话私有产物 | M0 先审计可复用证据结构，避免第二套验证来源 |
| Runtime 能力 | `packages/shared/src/types/agent.ts` 的 AGENT_RUNTIME_CAPABILITIES | 当前 ai-sdk 与 claude 的预算停止能力位为 true，pi/proma 为 false；强度和适用路径不同 | 修正旧上下文可能过时的判断；不能把位值当真实全链验收 |
| Memory/Skill | `memory-plugin-service.ts`、`memory-governance.ts`；`agent-runtime/skill-porting/*` | 已有候选/审批、来源元数据、scanner/auditor；scanner 名称不代表安全扫描 | 先审计既有门控覆盖，再补缺口，不另造自动学习系统 |
| 评测 | `apps/electron/src/main/lib/agent-runtime/eval/self-evolver.ts`、`eval-runner.ts` | 已有 baseline、候选、回滚和 held-out 设施 | 为本升级新增独立 benchmark；不运行关闭的 TCC benchmark |
| ACP | 本轮查阅官方介绍；相关范围源码搜索未发现明确接线 | 不足以证明全仓完全没有 ACP | 可选阶段先做全仓核验和需求确认，不把缺失当已证明事实 |

**工作树保护：** 开始时 `.context/note.md` 已有用户/其他工作改动；本任务不触碰它。后续实施先检查工作树并使用独立 linked worktree、立即 SelectWorktree 绑定，再编辑代码。

## 3. 状态、证据与完成规则

### 3.1 状态枚举

`待开始` / `进行中` / `阻塞` / `部分完成` / `已完成` / `取消`。

- 已有模块记为“复用基线”，不把新增工作项标成已完成。
- 测试 pass、fail、skip、未执行分别记录；skip 永远不是 pass。
- 完成必须具备代码/文档位置、固定版本、测试命令与结果、限制、回滚方式。
- 取消保留记录和理由，不删除历史。
- 阻塞必须记录解除条件，不以“以后再做”替代。

### 3.2 每次执行必须追加的证据字段

`recordId`、时间/时区、workItemIds、commit/build 标识、工作树差异、Runtime/SDK/Provider/model、平台、配置作用域、fixture/真实运行、命令、pass/fail/skip、artifactRef、费用来源、限制、下一步。

- 本 ledger 只放证据摘要及定位，不写密钥、聊天正文、私人路径明细或完整工具敏感参数。
- 敏感原始证据放会话私有目录；公开 fixture 必须脱敏。
- 新运行记录采用 `HARNESS-YYYYMMDD-NNN`；新设计决定采用 `DECISION-HARNESS-NNN`。

## 4. 里程碑与依赖

| ID | 里程碑 | 退出条件 | 依赖 | 当前状态 |
|---|---|---|---|---|
| M0 | 范围、契约与基线 | 现有证据/目录/Runtime 接线审计，方案和门禁冻结 | 本 ledger | 部分完成：H00/H01及V01子契约；H02完整决策/H03仍待补 |
| M1 | 产物绑定的完成验证 | coding AgentGoal 仅凭权威、新鲜证据完成；人工验收不变 | M0 | 部分完成：V01与V02切片；无V03完成门禁接线 |
| M2 | 独立按需工具接线 | 复用目录，权限不降级，关闭 TCC，工具选择与成本通过门禁 | M0；上线需 M3 截断保护 | 待开始 |
| M3 | Effects、安全调度与截断保护 | 冲突序列化、未知保守、取消清锁、不执行截断调用 | M0 | 部分完成：E01–E05 离线+生产接线落地（锁域=本进程）；截断批次判定未接线；真实运行矩阵未做 |
| M4 | 跨 Runtime 策略一致性 | 能力矩阵、版本化策略、契约测试和不支持清单 | M1/M2/M3 的契约 | 完成（离线/本机级）：P01–P04 落地；审计流接线与策略写入路径无需求未做 |
| M5 | 压缩与学习治理补强 | 多轮 fidelity、原文定位、候选审批/撤销覆盖 | M0；M4 | 部分完成：C01–C04 离线落地；真实模型连续压缩 fidelity 属 R01 held-out，未做 |
| M6 | 集成、性能与发布 | 完整回归、隔离打包、真实 opt-in 验收、恢复/回滚 | M1–M5 | 部分完成：R01骨架/R02本机门禁与烟测/R04回滚落地；真实 opt-in 验收与 CI 隔离打包未做 |
| M7 | ACP 可选探索 | 有明确宿主与授权，固定协议版本，离线契约通过 | M4；M6 稳定路径 | 阻塞：尚无接入需求和实施授权 |

推荐交付顺序：M0 → M1 → M3 安全地基 → M2 独立接线 → M4 → M5 → M6；M7 单独决策。M2 设计可与 M1 并行，但不能让工具加载绕过尚未建立的安全执行边界。

## 5. 共享契约与存储设计要求

### 5.1 验证与完成

拟议契约最终在 M0 冻结，以下不是现有 API 声明。

- **ArtifactRevision**：稳定 artifactId、所属 workspace/session/execution/task、内容 hash、scope hash、捕获时间、来源快照引用。不能只有全局 Git HEAD，必须覆盖 dirty/untracked 文件；symlink、删除、生成文件和范围变更有明确定义。
- **VerificationReceipt**：version、receiptId、criteriaId、verifierId/version、artifactRevision、runId/toolCallId、开始/结束、exitCode、result（passed/failed/unknown/skipped）、evidenceRef、主进程来源。模型不能自己构造 passed 回执。
- **VerificationDecision**：required criteria 的逐项结果、freshness、overallStatus、阻塞原因、引用。任一缺失、失败、过期或 unknown 不通过。
- **Lifecycle**：保留现有 execution 状态；另加验证投影，不把所有历史 completed 重置或伪造已验证。历史记录没有回执显示 legacy/unverified。
- 首片只覆盖显式配置验证要求的 coding AgentGoal。业务任务完成、交付物验收和交接继续由既有 project-chain 权威服务决定。
- 验证器来自用户/项目认可的固定配置，Agent 不得用空测试命令替换验收标准。退出码 0 不足以证明收集到了测试；记录测试计数和命令适用性，零测试按预定规则拒绝或 unknown。
- 测试运行期间和结束后再检查产物修订；外部编辑、验证器执行造成产物变化或退出前再次修改会使证据失效。

### 5.2 工具身份、目录与 effects

- 复用 CapabilityDescriptor 的稳定 id/schemaRef/source/confirmation；建立与 RuntimeToolDefinition 的单一映射。
- 目录修订绑定 builtin 版本、MCP server/tool 身份和 schema hash；禁用/断连/更新使旧选择失效。缓存不是授权来源。
- 常驻工具集合按任务与 Runtime 契约冻结，不以论文“15个”作硬阈值；schema token 预算包括 discovery 元数据。
- unknown tool/schema load failed：明确返回不可用原因；不能执行未注册工具。正常发现失败可回退获授权的 baseline catalog，受控运行不能借回退绕过 scope/privacy policy。
- effects：read/write/delete、local/external、资源键、scope、unknown。路径键做 realpath/根边界校验，目录冲突覆盖子路径，大小写/符号链接/不存在目标按平台契约处理。
- 任意 Bash、MCP side-effect metadata 或模型声明均不能自动成为“并行安全”；默认 unknown，除非有可信工具实现/配置约束。

### 5.3 策略与运行保证

- JSON 版本化策略，主进程校验；workspace/session 可收紧，不能放宽应用硬底线或现有审批。
- 归一化 deny/ask/allow、路径/数据/模型 scope、回合/时间/费用限制、验证要求、可支持的恢复与取消。
- 能力位同时声明强度和边界：预算预请求准入、超额后停止、进程终止核验、OS sandbox 不混用。
- policy revision/fingerprint 绑定运行和证据；撤权后尚未开始的操作拒绝。执行中取消/外部效果未知需要保留 unknown 与待对账。
- 所有新 UI 状态采用 Jotai；新增 IPC 遵循 shared → main → preload → renderer 四层同步。

### 5.4 权威记录与兼容性

- 优先复用研发验证、业务账本和 session JSONL；M0 先决定适合的权威落点，禁止“为了方便”建立重复真相。
- 若需要新的技术回执日志，优先在会话私有目录追加 JSONL，并通过已存在的业务身份引用；若原子业务迁移需要 SQLite 表，单独说明理由及迁移/恢复方案。
- hash 只能证明绑定内容/一致性，不证明成果质量或防篡改真实性；审批/Provider/外部证据仍需来源核验。
- 旧数据读取兼容、不伪造历史回执；未知 schema version fail-closed 且保留原件。
- 禁止在文档规划阶段迁移、清理或修复用户真实配置。

## 6. 可执行工作项

以下路径中“新增”均为拟议位置，尚不存在；实施前若已有等效模块应复用并在账本记录调整。

### M0：冻结基线

| ID | 工作项与文件入口 | 交付与BDD验收 | 依赖 | 状态 |
|---|---|---|---|---|
| H00 | 审计既有验证/Goal：goal-coordinator.ts、development-snapshot-service.ts、development-apply-service.ts、project-chain-service.ts | 映射 AgentGoal/Goal/Task/Execution/Deliverable 身份和证据；Given 同名不同任务，Then 不互认回执 | 无 | 已完成：contracts.md身份映射/缺口审计；V01只覆盖结构不串项 |
| H01 | 审计工具目录与 Runtime：capability*.ts、tool-registry.ts、pi-tool-bridge.ts、各 adapter | 输出 schema 进入模型和执行路径图；分别标注已生产、实验、关闭、未知；不调用 Provider | H00 | 已完成：contracts.md接线表；SDK先验截断阻断仍未知 |
| H02 | 冻结契约/benchmark；新增本目录 `contracts.md`、`benchmark-spec.md` | 记录验证配置、存储、非劣门槛、固定样本和错误语义；Given 旧 completed，Then 不补造 verified | H00/H01 | 部分完成：V01子契约和14-case规格；完整权威落点/flags/策略仍未冻结 |
| H03 | 无副作用基线与 feature flag 设计；复用 eval/trace-writer.ts、context-metrics.ts | 同版本 baseline 可复现；flag off 无新行为、无 TCC，日志无敏感正文 | H02 | 待开始 |

### M1：完成验证

| ID | 工作项与文件入口 | 交付与BDD验收 | 依赖 | 状态 |
|---|---|---|---|---|
| V01 | Shared 技术回执；`packages/shared/src/types/verification.ts`、`utils/verification.ts`及`.test.ts`，更新types/utils导出 | schema/version/身份/未知状态；拒绝 malformed、未来时间和不同 task/session/artifact 回执 | H02的V01子契约 | 已完成：纯DTO解析；真实来源与新鲜度不在本项能力范围 |
| V02 | 复用快照与运行证据；已有development-snapshot/validation-service及新development-validation-record.ts；暂不另建verification-service | 主进程创建回执；修改/untracked/delete/外部改写使旧证据失效；模型字符串不能变成 passed | V01 | 部分完成：完整Git内容变化集、scope/config绑定、严格回读；Goal/session/run闭包和prepared-request上下文已接线；Provider确认/业务映射/verifier/test来源未闭合，见v02-evidence.md、goal-run-evidence.md与invocation-context-evidence.md |
| V03 | 固定基线验证 + Goal 门禁 + 受保护路径(b) + seatbelt 验证沙箱 + 签名存储 + Goal修订绑定 + 验证器设置界面 + Goal门禁绑定UI（Agent 横幅）均已实现；Agent Bash 沙箱已启用 | 用户决策见 protected-verifier-storage-design.md §0 | V02 | 部分：V03 主要链路完整；正式签名版未验证；自定义历史基线仅 API；见 goal-gate-binding-ui-evidence.md |
| V04 | 有界修复续跑；goal-coordinator.ts、goal-store.ts | 保留现有连续上限；计数跨重启不被绕过；预算/撤权/用户输入/暂停立即阻止新续跑；未知外部副作用不重放 | V03；P01 | 待开始 |
| V05 | 显示验证状态；AgentMessages.tsx，必要时更新 shared/main/preload/Jotai | run finished、verified、accepted 文字和证据链接清晰；legacy 未验证；不同身份的证据不串项 | V03 | 待开始 |

**首片限制：** 开始仅支持固定、本地、已授权的确定性验证命令。研究真实性、文案语义质量、外部投放成功都不能因通用 guard 而宣称已验证。

### M2：复用目录并独立接线

| ID | 工作项与文件入口 | 交付与BDD验收 | 依赖 | 状态 |
|---|---|---|---|---|
| D01 | 扩展已有 capability.ts、capability-summary.ts、capability-schema-projection.ts 及测试 | 保持版本兼容和稳定id；失效目录/未知 schema 明确 omitted；不重复实现 catalog | H01/H02 | 待开始 |
| D02 | 拟新增 `agent-runtime/tool-discovery.ts` 及测试；接线 tool-registry.ts | 词法/规则发现，按 token 预算选择；目录修订生效；CJK/同名工具/大型MCP目录；required工具不静默丢失 | D01 | 待开始 |
| D03 | 先选一个合适生产 Runtime 的独立 opt-in 路径；ai-sdk-runtime-core.ts 或 pi-tool-bridge.ts 的选择由H01冻结 | 没选中的schema不进入模型；加载不提权；拒绝未加载/旧schema调用；每Runtime明确支持/不支持 | D02；E03/P01 | 待开始 |
| D04 | 接入新独立 benchmark，复用 eval-runner.ts；新增本目录结果引用 | 多步工具选择与恢复非劣，统计schema token、总token/cache、时延、失败；不能拿历史M4单轮结果作新PASS | D03 | 待开始 |

**TCC 保护：** 独立 discovery flag 默认 false，不修改 typedContextCompiler 默认、不调用 TCC spawn 实验。需要额外上下文治理时必须另行说明，不能以工具目录作为复活 TCC 的依赖。

### M3：安全执行地基

| ID | 工作项与文件入口 | 交付与BDD验收 | 依赖 | 状态 |
|---|---|---|---|---|
| E01 | 从 capability.ts 映射 effects；`packages/shared/src/context/tool-effects.ts`及main实例绑定/测试；扩展RuntimeToolDefinition | 三个文件工具实际name/execute同源，Write涵盖mkdir祖先；unknown保守，Bash/MCP不因自述安全，旧工具不自动并行 | H02子契约 | 部分：文件声明与实例来源已落地；其他资源/完整策略映射未完成，见effects-evidence.md；未启用调度 |
| E02 | `tool-scheduler.ts` + 共享单例 `tool-scheduler-service.ts` 已接入 ai-sdk runtime 与 Pi 桥（生产执行）；指标快照 available；交互工具旁路 | 目标：资源冲突串行、独立读取并行、锁域声明 | E01 子契约 | 已接线（部分完成 E05 范围）：锁域=本进程内，跨进程不支持已声明；真实运行矩阵与性能基准未做，见 tool-scheduler-wiring-evidence.md |
| E03 | `packages/shared/src/context/tool-call-integrity.ts`判定及测试；接线ai-sdk-runtime-core.ts、pi-tool-bridge.ts仍未做 | 目标：不完整批次不执行待执行mutation；已执行流式调用单独记录不谎称撤销；SDK无法先验检查则不声明支持 | E01 | 部分：已核验ai@7.0.31无宿主先验gate，事后分类+AI SDK结果消息观察接线完成；零执行/Pi/调度消费未做，见tool-call-integrity-{evidence,wiring-evidence}.md |
| E04 | 取消/错误/重启矩阵；`tool-scheduler.ts` 与 adapter 测试 | queued取消不开始；错误释放锁；幂等read可按策略重试，unknown写/外部调用不自动重放；禁用后仍保留硬底线 | E02 | 部分完成：矩阵、重试硬规则、禁用退化（全串行仍持锁）与复用测试落地；运行中调用不打断为既定语义；禁用开关未持久化；见 tool-scheduler-lifecycle-evidence.md |
| E05 | 小范围 Runtime 生产接线与调度指标 | 给出同资源跨 session/父子 Agent 的锁域；不支持跨进程共享锁时禁止宣称全局安全；同一 browser/terminal 始终序列化 | E04 | 部分：接线与锁域声明完成；指标未在 UI/审计中展示；真实运行观测未做 |

### M4：策略一致性

| ID | 工作项与文件入口 | 交付与BDD验收 | 依赖 | 状态 |
|---|---|---|---|---|
| P01 | `types/harness-policy.ts`（版本化/强度/只收紧/严格解析）+ 能力扩展 supportsInProcessToolScheduling + ai-sdk adapter Provider 前校验 | 版本化配置与保证强度；不支持required保证在Provider前拒绝；策略只能收紧、不放宽硬底线 | H02 | 部分完成：模型与 ai-sdk 接线落地；proma/pi/claude 接线与 UI 归 P03/P04；policy-conformance-evidence.md |
| P02 | `policy-invariants.test.ts` 钉板：plan 写范围、safe+scope 逃逸拒绝、预算闸与权限模式无关、接线不吞结果 | Plan只允许既有plan写范围；高风险/外发审批不旁路；allow-all不吞硬deny；保留真实费用unknown | P01 | 部分完成：权限层钉板落地；bypassPermissions 在工具权限层全放行属现状（硬底线在独立层）；费用 unknown 由既有 pilot 测试覆盖 |
| P03 | `adapters/harness-policy-conformance.test.ts` 声明式矩阵 + 四 runtime Provider 前接线 | claude/pi/ai-sdk/proma分别填写 support/unsupported/retired；不为了测试恢复retired runtime；撤权/预算/取消一致 | P02；V03/D03/E05 | 完成（数据级）：矩阵钉板+四 runtime 入口 fail-closed 接线；retired 仅数据级断言；policy-conformance-evidence.md |
| P04 | IPC get-state + AgentSettings「策略」Tab 只读卡 + 配置损坏拒绝 | 展示作用域、策略revision、拒绝原因、sandbox与approval区别；未知字段/损坏配置保留原件并拒绝受控运行 | P03 | 部分完成：UI 只读说明与配置拒绝落地；拒绝原因未写审计流（仅异常上浮）；policy-conformance-evidence.md |

### M5：上下文与学习

| ID | 工作项与文件入口 | 交付与BDD验收 | 依赖 | 状态 |
|---|---|---|---|---|
| C01 | goldens 新增三连压缩样本 + 评估链/负例测试；尾部配对由 alignKeepStartToToolPairs 既有实现承担 | 连续3次以上压缩保留原目标、禁止项、关键决策和未解决阻塞；recent tail保留完整tool-call/result组 | H02 | 完成（离线评估级）：真实模型连续压缩质量仍属 R01 held-out；context-compaction-integrity.test.ts |
| C02 | boundary 携带 compactionSource（消息数/SHA-256/归档文件）+ assessCompactionArchiveIntegrity 三态 | 摘要有原文/修订定位；archive缺失显示unrecoverable；中止/空结果/错误不写成功；overflow恢复不重放mutation | C01；P03 | 部分完成：定位与 unrecoverable 落地；中止不写成功由既有生命周期测试承担；overflow 不重放为构造性保证（恢复只重读持久化历史），未做端到端故障注入 |
| C03 | `memory-approval-chain.test.ts` + 敏感候选上游拦截 + AuditReport.disclaimer | session lesson → candidate → existing Approval → approved写入；跨项目/敏感/矛盾事实不自动推广；安全scanner不作无恶意证明 | H00；P03 | 部分完成：审批链与敏感拦截钉板落地；矛盾语义检测未实现（无自动推广通道是现状底线）；memory-governance-evidence.md |
| C04 | installer contentHash + detectSkillDrift + stale拒绝/force/幂等跳过 | stale patch拒绝；重复批准幂等；更新失败旧版本可恢复；缺授权不写AGENTS/README；Skill变更遵守version契约 | C03 | 完成（installer 级）：stale/幂等/原子恢复/路径穿越测试落地；portSkill force 不区分 audit 与 stale 放行（记录为边界）；memory-governance-evidence.md |

### M6：验收与发布

| ID | 工作项与文件入口 | 交付与BDD验收 | 依赖 | 状态 |
|---|---|---|---|---|
| R01 | 离线矩阵 + GLM真实配对试点 | 多任务/多Runtime基线和失败样本；安全断言零容忍；未知费用不作0；不跑TCC实验 | M1–M5 | 部分完成：2026-10-10 16:53 Pi/glm-5.3-flash真实30对完成；升级29/30、当前构建串行基线28/30，双方通过28对；总预算占用约¥4.506（非账单）；多Runtime/历史baseline未覆盖；见r01-glm-real-evidence.md及合并JSON |
| R02 | 本批实际执行：全量门禁 + dist:fast + package-smoke | typecheck/test/lint/docs、完整build、隔离包启动/数据库重开；原生helper失败上抛 | R01 | 完成（本机 arm64）：567文件3844pass0fail；dmg 1m18s；smoke passed（tools26/defaultSkills3/skillSetToggle2）；Kimi 压缩烟测与 CI runner 未覆盖 |
| R03 | 单独授权的真实Provider opt-in试点 | 固定Runtime/model/build/budget/cases；逐调用留证；验证真实工具/权限/最新产物；skip不记通过 | R02 | 已执行（用户授权 Pi + deepseek-flash/deepseek-v4-pro，¥5 上限）：36 次运行，17/18 与 18/18 通过，估算累计 ≤ $0.302；唯一失败 text-ok 已如实记录；见 pi-deepseek-pilot-evidence.md。仍非发布门禁 |
| R04 | `harness-rollback.test.ts` 四例回滚演练 | 关闭新flags恢复baseline，硬安全底线不降低；旧数据可读、日志不删；扩容需正式门禁决策 | R03 | 完成（本批机制级）：调度禁用/策略删除/旧 boundary 可读/预算闸不降低；历史 flags 不在范围；runtime-acceptance-evidence.md |

### M7：ACP 可选分支

| ID | 工作项与文件入口 | 交付与BDD验收 | 依赖 | 状态 |
|---|---|---|---|---|
| A01 | 新增本目录 `acp-decision.md`：需求/全仓能力/协议版本/依赖调研 | 决定client或server及一个真实宿主；没有需求则取消实现，仅保留研究结论 | 用户需求；M4 | 阻塞：待用户决定用途 |
| A02 | 只实现一个方向的离线adapter；候选目录 `main/lib/acp/` | 初始化、能力协商、session、prompt、updates、cancel、permission映射；未知方法版本明确拒绝 | A01 | 待开始 |
| A03 | MCP/ACP权限分离与宿主测试 | client提供filesystem/terminal能力不能越scope；Agent拒绝也不能由宿主“已批准”覆盖；连接断开不静默自动批准 | A02 | 待开始 |
| A04 | 一个固定宿主的实际互通 | 协议版本/宿主版本/本地stdio链路可复现；resume等仅对声明支持测试；远程不作为首片 | A03；单独授权 | 阻塞：待宿主与试跑授权 |

## 7. 必须通过的横向行为场景

| Case | Given / When / Then | 对应项 |
|---|---|---|
| B01 | 最后一次修改后无新验证，完成请求被拒绝；通过验证后再修改仍被拒绝 | V02/V03 |
| B02 | 回执对应别的任务、session、artifact、criteria或revision，不互认 | V01/V02 |
| B03 | 工具stdout含PASS但exit非0、测试数为0、验证器不匹配，不能判已验证 | V02/V03 |
| B04 | 验证时外部修改、权限撤销、用户暂停或输入，不能在旧结果上继续完成/续跑 | V03/V04 |
| B05 | 数据库重开/进程重启，修复计数、证据版本和unknown保留；非幂等副作用不重放 | V04/E04/R04 |
| B06 | discovery选中敏感工具，仍需原审批；未授权schema不因fallback曝光或执行 | D02/D03/P02 |
| B07 | MCP断连/禁用/同名跨server/目录更新，旧schema引用失效；明确错误而非幻觉执行 | D01/D03 |
| B08 | 相同文件的realpath别名、父子路径、跨session写入冲突，实际锁域内安全串行 | E02/E05 |
| B09 | 任意Bash、未知MCP effects、external操作，默认保守；模型声明不提权 | E01/P02 |
| B10 | 模型输出截断、参数不完整或batch损坏，尚未开始的mutation零执行；已执行效果明确unknown/事实 | E03 |
| B11 | queued取消、running错误/超时，锁正确释放；并发上限生效，无deadlock或工具结果错配 | E04 |
| B12 | Runtime缺必要能力，首次Provider请求前拒绝；unsupported/skip与passed区分 | P01/P03 |
| B13 | 连续压缩不丢原目标/禁令/未完任务；归档丢失不假装可恢复，不伪造成功boundary | C01/C02 |
| B14 | 记忆/Skill候选未批准、旧patch、重复审批、安装中断，不覆盖权威内容或扩大scope | C03/C04 |
| B15 | flags off：行为兼容；TCC始终关闭；retired Runtime不恢复；现有Pilot/Task Review门禁不降低 | H03/P03/R04 |
| B16 | 同一coding请求run finished ≠ verified ≠ accepted，UI不会一律显示业务完成 | V05/P04 |
| B17 | ACP宿主请求越权filesystem/terminal、断连后代批准、未知版本，不绕原策略 | A02/A03 |

## 8. 评测与发布门禁

### 8.1 新benchmark设计（拟议，M0冻结）

- 固定至少12个代表性case：完成/陈旧证据/验证失败、简单/复杂工具选择、CJK/MCP目录、资源冲突、截断、取消恢复、压缩fidelity、Memory审批。
- 安全与状态机case走确定性fixture；模型选择case采用相同版本、模型、任务的paired baseline/upgrade，并覆盖多轮工具交互。
- fixture矩阵至少覆盖当前正式受支持的主要Runtime；无法接线的Runtime为unsupported，不填PASS。
- 真实Provider试点初拟每个模型工具选择至少30对样本，样本数和费用在单独授权前冻结；这是筛查，不冒充统计充分或生产普适性证明。
- 记录全体样本，包括失败、超时、重试、schema发现失败和人为中止；不得只统计成功样本。
- 质量：task success、required-tool recall、验证漏拒/误拒、evidence freshness、敏感泄漏、人工纠正。
- 效率：schema tokens、总input/output、cache read/write、wall time p50/p95、discovery往返、重试、真实/估算费用来源。

### 8.2 初拟阈值（不是已测结果）

- B01–B17适用项100%通过；任何越权、伪造完成、截断mutation执行或敏感泄漏均阻断发布。
- 固定确定性case中的陈旧/缺失/错身份证据拒绝率100%；合法新鲜证据误拒绝为0。
- paired试点 task success 不低于baseline，required-tool recall不低于baseline；小样本不能据此宣称普适非劣。
- 大工具目录case的schema token平均减少至少20%；总token/费用和p95时延必须同时报告，不以schema节省掩盖净退化。
- 总token或p95时延恶化超过10%时阻断默认启用，除非用户依据质量收益明确接受；不改变安全硬门槛。
- compaction固定关键约束/未完任务保留率100%，recent tool协议完整率100%。
- 默认推广需要更多代表性试用证据和用户决定；一轮小样本通过只赋予限定组合opt-in资格。

| Gate | 要求 | 当前状态 | 可宣称能力 |
|---|---|---|---|
| G0 | H00–H03、contracts/benchmark/存储和支持矩阵冻结；实施获授权 | 未通过 | 仅规划已写入 |
| G1 | 离线BDD、隔离故障矩阵、相关Runtime接线与硬安全断言 | 未执行 | 仅有逐项真实证据后可称确定性机制通过 |
| G2 | PR门禁、完整构建、隔离包启动、最新数据兼容和回滚 | 未执行 | 仅固定构建工程验收 |
| G3 | 单独授权真实Provider、工具/验证链和新benchmark opt-in验收 | 阻塞：未授权 | 仅已测平台/Runtime/model组合 |
| G4 | 代表性使用观察、失败对账、默认推广授权和支持清单 | 未执行 | 才能在明确范围宣称默认可靠升级 |
| GA | ACP官方版本核验、离线契约与固定宿主互通 | 阻塞：未定义宿主 | 与G0–G4独立，不阻塞核心升级 |

## 9. 验证命令与测试隔离

下面是未来执行命令，不是本轮执行记录。新增测试文件须先存在；全量不要裸跑 `bun test`。

```bash
# 既有相关测试逐文件运行
bun test apps/electron/src/main/lib/goal-runtime/goal-coordinator.test.ts
bun test packages/shared/src/context/capability.test.ts
bun test packages/shared/src/context/capability-schema-projection.test.ts
bun test apps/electron/src/main/lib/agent-runtime/context/capability-schema-projection.integration.test.ts
bun test apps/electron/src/main/lib/agent-runtime/context-compaction.test.ts
bun test apps/electron/src/main/lib/agent-permission-service.test.ts
bun test apps/electron/src/main/lib/adapters/pi-tool-bridge.test.ts
bun test apps/electron/src/main/lib/memory-plugin-service.test.ts

# 新增机制的定向测试（实施后）
bun test apps/electron/src/main/lib/development-validation-service.test.ts
bun test apps/electron/src/main/lib/development-validation-record.test.ts
bun test apps/electron/src/main/lib/development-snapshot-service.test.ts
bun test apps/electron/src/main/lib/agent-runtime/tool-discovery.test.ts
bun test apps/electron/src/main/lib/agent-runtime/tool-scheduler.test.ts
bun test apps/electron/src/main/lib/agent-runtime/tool-call-integrity.test.ts
bun test apps/electron/src/main/lib/adapters/harness-policy-conformance.test.ts

# 完整PR门禁
bun run typecheck
bun run test
bun run lint
bun run docs:check
git diff --check

# 打包前必须完整构建；实际打包方式按目标平台与现有脚本选择
bun run build
# 对隔离构建的实际可执行文件运行；没有显式Kimi配置不得连接Provider
bun scripts/package-smoke.ts /absolute/path/to/isolated/Gravitas.app/Contents/MacOS/Gravitas
```

- 创建workspace/session/config的测试必须在导入相关模块前隔离 `PROMA_TEST_CONFIG_DIR`，或以现有测试约定mock homedir；finally清理临时目录并删除环境变量。
- 原生运行需要HOME/配置隔离；真实配置只核验workspace目录数量/名称变化，不扫描或导出内容。测试不应在 `~/.gravitas/agent-workspaces/` 产生新目录。
- 禁止测试创建可用真实凭据或访问真实外部资源；fixture端点使用不可达占位地址。
- 定向测试期待“全部适用case通过”；精确数量按实际记录，不预填PASS。
- 不安装新依赖直到完成官方文档/版本/许可证/打包闭包调研；有依赖才另行记录决定。
- 每个代码切片进行简化审查：同源契约、组件化、无重复状态、无any；有可用code-simplifier时使用，否则明确记录人工同等审查，不虚构执行。
- 提交受影响包时patch递增；default-skills内容变更同步SKILL.md version；只写此文档不递增软件版本。

## 10. 发布、回滚与恢复

### 10.1 分阶段启用

1. 契约和离线测试，默认行为不变。
2. 显式opt-in的一个Runtime、一个workspace；不打开TCC。
3. 离线故障矩阵和隔离打包通过。
4. 单独授权的小规模真实验证；限定费用、次数、数据范围和停止条件。
5. 对失败/unknown人工对账并形成门禁决策，之后才考虑扩大范围或默认启用。

### 10.2 回滚原则

- discovery/performance flag关闭可回baseline完整目录，但不能恢复已拒绝的权限或泄漏不允许的schema。
- effects调度功能关闭时回保守串行，不回未知并行；完整调用校验属于硬底线，不作为性能回滚牺牲项。
- verification关闭不得把未验证任务变已验证；受控任务要求的验证不能因flag被静默取消。
- 证据日志、失败记录、业务回执保留；禁止删除unknown或用迁移伪造成功。
- 新字段保持可选读取并注明legacy；老版本是否可读取/执行新记录必须实际测，不假设可以直接降级运行。
- 安装/写入中断先核验实际磁盘状态；rename成功后fsync失败不宣称旧版本仍在。
- 崩溃后不得自动重放mutation、付款/发布或未知外部请求；停止接受与真实终止分开记录。
- 退出应用后的本地功能不能宣称仍持续执行；远程执行属于独立部署/验收范围。

## 11. 风险与待决事项

| ID | 风险/问题 | 处置或解除条件 | 状态 |
|---|---|---|---|
| K01 | 两种Goal和业务身份混用，证据串项 | H00精确ID映射；回执校验task/session/artifact | 开放 |
| K02 | 测试0收集、Agent替换验收器、生成日志伪PASS | 固定验证配置、主进程来源、收集/退出/修订一致核验 | 开放 |
| K03 | 外部编辑或验证器自己修改文件造成TOCTOU | 捕获前/后revision，最终完成边界再检查 | 开放 |
| K04 | directory已存在却另建目录、重复状态或误启TCC | 复用M4模块，独立flag，B15固定回归 | 开放 |
| K05 | discovery往返/输出增大抵消token收益 | 同时报总token/cache/费用/时延，超过门槛不推广 | 开放 |
| K06 | MCP/Bash effects不可知、path alias/跨session冲突 | unknown串行，realpath范围与锁域声明，跨进程限制 | 开放 |
| K07 | SDK流式执行早于完整输出判定 | H01/E03核验先验阻断能力；不支持时明确受控拒绝 | 开放 |
| K08 | Runtime能力位过时、retired路径被恢复 | 当前源码+真实支持矩阵，未知拒绝，不继承旧AGENTS结论 | 开放 |
| K09 | 续跑次数只在内存、重启绕过限额 | V04持久计数/幂等，复用现有业务预算门禁 | 开放 |
| K10 | 记忆/Skill审批或安装路径不一致 | C03覆盖全部入口，来源/patch/安装失败保护 | 开放 |
| K11 | 验证日志成为敏感信息扩散路径 | ledger只写摘要；原件私有、最少必要、来源权限 | 开放 |
| K12 | sandbox/费用封顶/真实停止被文案夸大 | 能力强度与验证证据分离，明确unsupported/unknown | 开放 |
| K13 | ACP远程协议/版本演进或宿主提升权限 | 首片stdio、固定版本、permission映射，单独远程安全评审 | 开放 |

待决定：首个生产Runtime、验证配置所有者/审批入口、回执权威落点、跨session锁域、策略硬底线清单、验证误拒的人工处理路径、真实矩阵预算、ACP用途及宿主。这些问题在对应工作项开工前解决，不预设用户已认可。

## 12. ACP 说明与选择标准

### 12.1 ACP 是什么

这里的 ACP 是 **Agent Client Protocol**，不是其他同缩写的协议。它标准化代码编辑器/IDE等客户端与coding agent的通信。官方介绍类比LSP：客户端不必为每个Agent重新实现一套专有接口，Agent也不必为每个编辑器单独集成。

官方资料截至本轮读取：本地Agent通常由客户端作为子进程启动，使用 **JSON-RPC over stdio**。官方同时描述远程HTTP/WebSocket场景，但明确完整远程支持仍在推进，不能假设本地/远程能力已完全一致。

典型交互包含初始化和能力协商、创建或支持条件下加载session、发送prompt、接收文本/计划/工具状态更新、取消、权限请求；具体方法/字段/支持范围必须在A01依据固定协议版本核验。

### 12.2 与 MCP、A2A 的区别

| 协议 | 主要边界 | Gravitas例子 |
|---|---|---|
| ACP | Client/editor ↔ Agent | 编辑器驱动Gravitas，或Gravitas宿主驱动外部coding harness |
| MCP | Agent/application ↔ tools/resources | Agent调用数据库、搜索、文件或SaaS集成 |
| A2A | 独立Agent服务 ↔ Agent服务 | 跨组织/远端Agent任务协作；非本项目内部子Agent前置 |

ACP可能复用MCP的一些JSON表达，但用途不同，也不能互相替代。ACP自身不保证sandbox、正确性、隐私、费用上限或业务验收。

### 12.3 Gravitas 两种角色

- **ACP client/host**：Gravitas提供交互/权限界面，连接外部ACP Agent。价值是引入更多harness；风险是重复宿主和权限映射。
- **ACP agent/server**：Gravitas提供Agent协议边界，由兼容编辑器或其他宿主驱动。价值是外部可消费；不等于必须新开公网HTTP服务。

先实现一个方向与一个真实消费者。没有明确消费者则保持deferred；不为内部子Agent引入ACP，不为“平台化”口号扩大暴露面。

## 13. 决策与执行记录

### 13.1 决策

| ID | 时间 | 决定/依据 | 授权边界 |
|---|---|---|---|
| DECISION-HARNESS-001 | 2026-10-08 18:48 GMT+8 用户请求起 | 用户要求为前轮六条建议写完整ledger，并询问ACP | 仅文档，不授权代码或实验 |
| DECISION-HARNESS-002 | 2026-10-08 本轮核验 | 已有CapabilityDescriptor/summary/schema projection，升级复用；先前“缺发现层”只适用于尚未核验的生产接线，不能称模块缺失 | 技术规划修正，不擅自开启功能 |
| DECISION-HARNESS-003 | 2026-10-08 本轮核验 | 保留2026-09-22 TCC关闭决定；M2是独立目录接线，禁止复活TCC | 旧用户决定不因本ledger失效 |
| DECISION-HARNESS-004 | 2026-10-08 本轮核验 | 当前ai-sdk预算停止能力位为true；所有强保证按路径和证据评估，不照抄旧状态 | 不等于真实全链G3通过 |
| DECISION-HARNESS-005 | 2026-10-08 21:44 GMT+8 | 用户要求切分支开始实施；首批为H00/H01审计、H02子契约和V01，不将解析DTO当可信来源 | 实施/离线测试获授权；默认启用、付费、ACP/TCC不属于本批 |

### 13.2 实施记录

| Record | 时间 | 工作项 | 结果 | 证据与边界 |
|---|---|---|---|---|
| HARNESS-20261008-001 | 2026-10-08 本轮 | 文档准备 | 读取论文相关节、现有ledger、相关源码和ACP官方介绍；建立本ledger | HEAD 6c71b384；仅文档交付；无代码、无行为测试、无付费或外部副作用 |
| HARNESS-20261008-002 | 2026-10-08 本轮 | 文档校验 | 34个唯一工作项；引用的明确既有路径存在；新增路径已标为拟议；`git diff --check`、`bun run docs:check` 通过 | 仅文档格式/路径/事实摘要检查，不证明任何升级机制或G0–G4通过；未改已有 `.context/note.md` |
| HARNESS-20261008-003 | 2026-10-08 21:44–22:10 GMT+8 | H00/H01、H02部分、V01 | 独立worktree/分支；新增contracts、benchmark-spec、VerificationSubject/ArtifactRevision/Receipt及纯解析器，types/utils导出；shared 0.2.29→0.2.30，事实摘要同步 | 基线6c71b384；无生产调用方/新配置/持久化/flags；H02完整决策与H03未完成，M0/G0不通过。审计发现旧验证遗漏delete复现/新增变化集，留给V02 |
| HARNESS-20261008-004 | 2026-10-08 22:10 GMT+8 | V01 red/green与工程回归 | 初始模块缺失red；fixture类型问题修复；原型对象测试red后修复；最终26测试/69断言。全仓541文件：3572 pass/0 fail/27 skip；九包typecheck、全仓lint（1968文件）、docs:check、diff检查通过 | 私有工作台日志`harness-full-tests-final.log`、`harness-typecheck.log`、`harness-lint.log`。测试runner每文件临时配置隔离；未运行真实Provider/打包。新模块无I/O；没有测试前真实目录清单快照，不额外宣称真实配置目录前后比对已验收。skip不计真实通过 |
| HARNESS-20261008-005 | 2026-10-08 22:14–22:37 GMT+8 | V02切片 | 复用快照采集，修复冻结后新增/删除重现/符号链接/验证中变化；新记录scope/config绑定；按主进程身份派生路径回读，fresh/stale/legacy分离；未另建内容存储 | 基线0f150de3，详情v02-evidence.md；新binding仅本机受信私有存储一致性，不是不可伪造来源证明；忽略文件、mode与原子文件系统快照不在保证内；V02整体仍部分完成 |
| HARNESS-20261008-006 | 2026-10-08 22:37 GMT+8 | V02 red/green与回归 | 新鲜度6例先红、回读7例先红后修复；最终5个定向文件53 pass；全仓542文件3595 pass/0 fail/27 skip；九包typecheck、全仓lint1970文件、docs/diff检查通过；真实workspace清单36→36且一致，新增0 | 日志harness-v02-*.log（会话私有工作台）；临时配置/Git真实本地验证命令，不调用真实Provider；没有打包、原生强杀或V03 UI验收。shared 0.2.31/electron 0.12.114；不触碰原主工作树已有或并行新增文件 |
| HARNESS-20261008-007 | 2026-10-08 22:47–23:25 GMT+8 | V02 Goal身份切片 | 复用Goal activeRunId、追加可选checkpointRunId，主进程闭包固定Goal/run；实际Orchestrator准入后签发，AI SDK/Pi/headless/队列同边界；内部token防相同startedAt旧回调/finally；暂停/停止/新Goal/重复提交隔离 | 基线70908394；goal-run-contract.md/goal-run-evidence.md；只证明已准入尝试，不是Provider/SDK/toolCall身份，未冻结完整InvocationContext；旧complete/evidence未验真，V03仍阻塞 |
| HARNESS-20261008-008 | 2026-10-08 23:25 GMT+8 | V02接线red/green与回归 | Coordinator API red12 fail（含迁移4旧例）后通过；修复fixture重名后Orchestrator red4 fail后通过；最终5定向文件76 pass；全仓543文件3612 pass/0 fail/27 skip；九包typecheck、lint1971文件、docs/diff通过；真实目录36→36一致新增0 | 私有harness-v02-goal-*.log；真实Orchestrator/离线adapter，不调用真实Provider，不做打包/停止真机验收。shared 0.2.32/electron 0.12.115；发现现有runner无受保护收集协议，冻结阻塞而非伪造test passed |
| HARNESS-20261009-001 | 2026-10-09 07:17–07:35 GMT+8 | V02已准备请求切片 | 早期nonce闭包保留，query前一次准备；存实际workspace/cwd/runtime/channel/provider/requestedModelId，Pi会话模型回退；跨环境、配置/投影漂移拒绝；query前复查slot避免准备后停止迟到启动 | 基线72793fb5，invocation-context-contract.md/evidence.md；只证明准备请求，不代表Provider确认。独立目录/渠道配置撤权、task/execution、可信verifier/test仍未闭合；V02部分、V03阻塞 |
| HARNESS-20261009-002 | 2026-10-09 07:35 GMT+8 | V02请求接线red/green与回归 | 新准备API13例red后green；接线2 pass/10 fail后通过；移除query前guard离线回归12 pass/2 fail后恢复通过。最终4定向文件60 pass；全仓544文件3644 pass/0 fail/27 skip；九包types、lint1972、docs/diff通过；真实workspace36→36一致新增0 | 私有harness-context-*.log；初次fixture错误期待异常返回、ProviderType导入与可选cwd类型错误均记录并修复。shared0.2.33/electron0.12.116；无真实Provider/build/package/native强停或新flag启用 |

| HARNESS-20261009-003 | 2026-10-09 09:14–09:36 GMT+8 | E01文件effects声明子契约 | shared v1严格保守解析；实际Read/Write/Edit name/execute绑定，WeakMap实例声明冻结与失效保护；Write涵盖祖先目录；catalog真实实例投影与候选资格仅收紧；Bash/MCP/副本/缺字段unknown | 基线9d426f60，effects-contract/evidence.md；不是OS隔离/权限/并行保证。E01部分，E02–E05未启动；未开并行/TCC |
| HARNESS-20261009-004 | 2026-10-09 09:36 GMT+8 | E01工程验证 | 新main10/shared20例；定向10文件73pass/0fail；全仓546文件3674pass/0fail/27skip，九包types/lint1976/docs/diff通过；真实workspace36→36一致新增0 | red为缺模块加载失败；不完整Electron mock与测试literal类型错误修复后green，未冒充行为通过。shared0.2.34/electron0.12.117；私有harness-effects-*.log；V02部分、V03仍阻塞 |

| HARNESS-20261009-005 | 2026-10-09 09:43–09:56 GMT+8 | E02观察性资源解析 | actual实例+自有参数；真实cwd/完整canonical目标、缺失Write尾部重建、hardlink dev/ino、Write完整祖先；悬空/外部link、EACCES/ENOTDIR、目录/socket及非规范绝对路径unknown | 基线35ea1abc，resource-resolution-contract/evidence.md；纯观察非授权/锁/TOCTOU防护。E02部分、HR06–HR09/G2未过 |
| HARNESS-20261009-006 | 2026-10-09 09:56 GMT+8 | E02工程验证 | 新25例；定向4文件72pass/0fail；全仓547文件3699pass/0fail/27skip；九包types/lint1978/docs/diff通过；真实workspace36→36一致新增0 | red为缺模块加载失败，mac新用例无skip；Windows/root条件显式skip未算跨平台验收。electron0.12.118/shared仍0.2.34；私有harness-resources-*.log，V03来源仍阻塞 |

| HARNESS-20261009-007 | 2026-10-09 10:08–10:14 GMT+8 | E03批次完整性判定（不接线） | 核验ai@7.0.31 streamText同流执行/无先验gate结论入契约；shared事后分类finishReason截断/invalid/duplicate/空名，原因码稳定；未改执行路径 | 基线b3a6ca40，tool-call-integrity-{contract,evidence}.md；判定非鉴权/撤销/回执。AI SDK不能宣称零执行支持；Pi未核验 |
| HARNESS-20261009-008 | 2026-10-09 10:14 GMT+8 | E03工程验证 | 新13例；定向9文件89pass/0fail；全仓548文件3712pass/0fail/27skip；九包types/lint1980/docs/diff通过；真实workspace36→36一致新增0 | red为缺模块加载；自引用断言fixture失败与dynamic类型错误修复后green，如实记录。shared0.2.35/electron0.12.119；V02部分、V03来源仍阻塞 |

| HARNESS-20261009-009 | 2026-10-09 10:17–10:23 GMT+8 | E03 AI SDK结果消息观察接线 | 判定词表接受end_turn/tool_use映射理由；SDKResultMessage可选toolCallBatchIntegrity随JSONL持久化；逐step编号原因码；不改审批/重试/续跑 | 基线15439d40，tool-call-integrity-wiring-evidence.md；仅事实观察，invalid调用在快照不可见，非零执行保证 |
| HARNESS-20261009-010 | 2026-10-09 10:23 GMT+8 | E03接线工程验证 | shared14+main4例；定向5文件93pass/0fail；全仓549文件3717pass/0fail/27skip；九包types/lint1981/docs/diff通过；真实workspace36→36一致新增0 | 一处测试标题与断言不符已改名如实；无生产网络调用。shared0.2.36/electron0.12.120；V02部分、V03来源仍阻塞 |

| HARNESS-20261009-011 | 2026-10-09 10:55–11:03 GMT+8 | Pi批次语义核验与观察接线 | 源码核验pi-agent-core 1.0.2：length截断批次由SDK判失败不执行，error/aborted不执行；final assistant附toolCallBatchIntegrity（toolUse→tool-calls）；deferred/pending未核实按不完整 | 基线2eef8041，pi-tool-call-batch-evidence.md；零执行结论来自源码阅读，非仓库运行时测试。E03 Pi观察接线完成，执行路径未改 |
| HARNESS-20261009-012 | 2026-10-09 11:03 GMT+8 | Pi接线工程验证 + verifier设计草案 | pi-message-adapter新增4例（13pass）；typecheck九包、lint1981、docs/diff通过；全仓549文件3721pass/0fail/27skip；真实workspace36→36一致新增0；verifier-config-design.md列三项待判断风险 | shared0.2.37/electron0.12.121；V03仍阻塞待用户选择方案；Provider试点未授权未调用 |

| HARNESS-20261009-013 | 2026-10-09 11:10–11:20 GMT+8 | V03固定基线验证器 | `git archive`完整SHA干净副本，argv非shell，JUnit根计数判定；工作树未提交改动不影响；9例（真实git/bun） | 用户决策方案(a)；未接入Goal门禁与受保护配置存储。pinned-baseline-verifier-evidence.md |
| HARNESS-20261009-014 | 2026-10-09 11:20–11:40 GMT+8 | Pi+DeepSeek受控试点与费用闸门修复 | 修复渠道模型恒为0费用（官方端点+目录命中才用目录价，其余保持0失败关闭，3例）；发现并修复 Pi deepseek 端点、统计重复计数、项目库初始化；flash 17/18（12+6用例），v4-pro 18/18；估算有效运行 $0.1949，账本上限 $0.302 | 用户授权 deepseek-flash、deepseek-v4-pro；¥5 按 $0.6 保守折算；key 经 Electron 解密仅入子进程环境，KEY_LEAK=0；pi-deepseek-pilot-evidence.md；原始数据在会话工作台 |

| HARNESS-20261009-015 | 2026-10-09 11:46–12:00 GMT+8 | Goal完成门禁接入固定基线验证 | `completionGate`可选字段；complete时对HEAD已提交内容运行验证，未通过拒绝并返回原因，通过写回执；验证途中配置漂移拒绝；创建时校验；无门禁旧行为不变 | 7例（真实临时git仓库含一例）；门禁仅经协调器API创建，无UI；测试削弱缺口未解决。goal-completion-gate-evidence.md |
| HARNESS-20261009-016 | 2026-10-09 12:00 GMT+8 | 受保护验证配置存储与写入权限设计 | 设计文档：存储布局、0700/0600、哈希链审计、写入权限矩阵；列出同用户Bash可绕过文件权限、测试削弱、签名密钥位置等需决策问题 | 仅设计，未写入配置、未新增IPC；protected-verifier-storage-design.md |

| HARNESS-20261009-017 | 2026-10-09 12:16–12:30 GMT+8 | 受保护路径（决策b）+ seatbelt验证沙箱 | 基线为HEAD祖先；基线后受保护路径改动拒绝（删除/移动计入旧路径）；验证命令在seatbelt中运行，受保护目录读写被拒，非darwin fail closed | 11+13例；seatbelt路径需realpath（实验确认）；Agent Bash未覆盖 |
| HARNESS-20261009-018 | 2026-10-09 12:30–12:45 GMT+8 | 签名受保护存储 + Goal修订绑定 | HMAC签名记录、safeStorage加密密钥、0700/0600、哈希链审计、修订/哈希绑定拒绝、配置更新需重建Goal | 8+12例；测试用可逆异或保护器，生产safeStorage未在Electron运行时验证 |
| HARNESS-20261009-019 | 2026-10-09 14:00–14:25 GMT+8 | 受保护路径统一维护 + 生产 safeStorage 运行时验证 | 路径进入签名记录（统一存储），门禁只引用修订与哈希；生产 safeStorage 在 Electron 中完成加密、跨实例读取、篡改与密钥损坏拒绝验证（dev 二进制） | 相关7文件9例通过；探针修正后全部通过；未验证签名打包版与 Windows/Linux；safestorage-runtime-validation-evidence.md |

| HARNESS-20261009-020 | 2026-10-09 14:25–14:40 GMT+8 | Agent Bash 沙箱（折中） | macOS seatbelt：可写工作目录与会话 scratch（TMPDIR/缓存）及链接 worktree 的对象库/引用/日志/自身 gitdir；禁写 hooks、config、.git 指针、其他 worktree；拒读写配置目录；非 darwin 默认拒绝 | 13 例（真实沙箱与链接 worktree 提交）；tool-impls 等 20 例通过；Claude SDK Bash 未覆盖；bash-sandbox-evidence.md |
| HARNESS-20261009-021 | 2026-10-09 14:40 GMT+8 | 打包版 safeStorage 验证脚本 | scripts/verify-packaged-safestorage.sh：签名、钥匙串条目、渠道密文计数（不输出内容）、手动“测试连接”步骤 | 脚本语法与错误分支已验证；打包版结果待用户执行；packaged-safestorage-verification.md |
| HARNESS-20261009-022 | 2026-10-09 14:33 GMT+8 | 用户决定 | Claude SDK 运行时将下线，其 Bash 无沙箱缺口不处理；git config 写入限制已接受 | 仅文档记录，无代码变更；bash-sandbox-evidence.md |
| HARNESS-20261009-023 | 2026-10-09 15:00–15:10 GMT+8 | 打包版手动验证（用户执行） | 渠道“测试连接”成功（打包版0.12.126可解密safeStorage）；Bash沙箱拦截/tmp写入；发现缺陷：会话目录位于配置目录下导致git无法stat父目录 | 已修复：配置目录禁写（agent-workspaces例外），读取仅禁verifiers/；新增14例沙箱测试全部通过 |
| HARNESS-20261009-024 | 2026-10-09 16:42 GMT+8 | 打包版复测通过 | 用户在 0.12.127 打包版中确认 git add/commit 成功；渠道解密与沙箱拦截此前已验证 | 打包版手动验证完成（ad-hoc 签名；正式签名版待 Developer ID 构建复验）；packaged-safestorage-verification.md |
| HARNESS-20261009-025 | 2026-10-09 16:50–17:00 GMT+8 | 验证器设置界面 | 四层 IPC（verifier:list/save）；服务层校验与损坏记录标记；设置页列表+表单+修订警告；存储新增listIds | 服务3例；全仓557文件3786pass0fail；build/renderer/typecheck/lint通过；Goal绑定UI未做；verifier-settings-ui-evidence.md |
| HARNESS-20261009-026 | 2026-10-09 17:10–17:30 GMT+8 | Goal门禁绑定UI | 协调器bindCompletionGate（运行中拒绝）；buildCompletionGateForGoal（最新修订+HEAD基线）；IPC agent:bind-completion-gate；Agent横幅绑定弹层与已绑定显示 | 5例；相关5文件通过；UI未在真实应用点击；goal-gate-binding-ui-evidence.md |
| HARNESS-20261009-027 | 2026-10-09 18:00–18:10 GMT+8 | E02调度器模块 | planLockSpec（读共享/写排他含祖先/unknown全局）；只在全锁空闲时派发+同步加锁逆序释放（结构性无死锁）；跳过队首；abort取消；10例 | 全仓559文件3801pass0fail；偶发无关超时重跑通过；未接线生产；tool-scheduler-evidence.md |
| HARNESS-20261009-028 | 2026-10-09 21:35–21:50 GMT+8 | E05生产接线 | 共享调度器接入ai-sdk executeRuntimeTool与Pi桥；交互工具旁路；锁域=本进程内声明；指标快照；修复跨批次等待唤醒缺陷（服务测试看门狗暴露） | 服务7例+接线回归5文件；全仓560文件3807pass0fail；锁等待无超时；HR07–HR09/G2未过；tool-scheduler-wiring-evidence.md |
| HARNESS-20261009-029 | 2026-10-09 21:55–22:10 GMT+8 | E04取消/错误/重启与重试 | 重试硬规则（仅共享锁、取消不重试、默认不重试）；禁用退化全串行仍持锁；修复跨批次并发计数缺陷（禁用测试复现） | 生命周期5例；全仓561文件3812pass0fail；重试无退避、禁用未持久化；HR07–HR09/G2未过；tool-scheduler-lifecycle-evidence.md |
| HARNESS-20261009-030 | 2026-10-09 22:40–22:55 GMT+8 | M4a策略模型P01+钉板P02 | harness-policy共享模块（严格解析/只收紧/能力映射）；supportsInProcessToolScheduling；ai-sdk Provider前校验；policy-invariants钉板 | shared8例+electron9例；全仓564文件3826pass0fail；proma/pi/claude接线与UI归P03/P04；policy-conformance-evidence.md |
| HARNESS-20261009-031 | 2026-10-09 22:55–23:20 GMT+8 | M4b一致性矩阵P03+UI P04 | 声明式能力矩阵钉板；四runtime入口Provider前fail-closed；harness-policy:get-state IPC+策略Tab只读卡 | 一致性6例；全仓565文件3832pass0fail；拒绝未写审计流；policy-conformance-evidence.md |
| HARNESS-20261009-032 | 2026-10-09 23:20–23:40 GMT+8 | M5压缩侧C01/C02 | 三连压缩golden+评估零容忍负例；boundary原文定位（sha256+归档文件）；归档完整性三态评估 | 完整性5例+压缩回归4文件全绿；overflow端到端故障注入未做；ledger C01/C02更新 |
| HARNESS-20261009-033 | 2026-10-09 23:40–23:55 GMT+8 | M5记忆/Skill侧C03/C04 | 审批链钉板（批准前零写/幂等/拒绝不写）；敏感候选上游拦截；audit免责声明；installer stale拒绝+幂等跳过+contentHash基线 | 记忆链2例+installer4例+auditor1例；全仓567文件3844pass0fail；矛盾语义检测未实现；memory-governance-evidence.md |
| HARNESS-20261010-034 | 2026-10-09 23:55–2026-10-10 00:20 GMT+8 | M6离线基准R01+门禁R02+回滚R04 | benchmark runner（安全零容忍/费用unknown/矩阵）；dist:fast dmg+package-smoke passed；回滚演练四例 | 基准3例+回滚4例；全仓门禁+真实打包烟测通过；真实Provider基线/CI隔离打包未做；runtime-acceptance-evidence.md |
| HARNESS-20261010-035 | 2026-10-10 00:20–00:35 GMT+8 | 台账刷新与推送 | 分支推送 origin（29提交）；M3/M4/M5/M6里程碑状态刷新；头部总状态对齐当前事实 | 无新代码；发布门禁状态不变（HR07–HR09/G0–G3未过）；ledger.md |
| HARNESS-20261010-036 | 2026-10-10 00:00–15:49 GMT+8 | GLM真实试点与30对扩样授权 | 普通任务两臂8/8，缺权限回调导致的冲突无效样本保留说明；修复后冲突两臂通过、8派发8完成；用户授权¥10扩至30对 | 扩样脚本与请求前保守预留准备完成，真实30对未运行；费用仍非Provider账单；r01-glm-real-evidence.md |
| HARNESS-20261010-037 | 2026-10-10 16:18–16:53 GMT+8 | GLM30对真实配对结果 | 本地输入额度/协议角色修复，完整usage结算与历史预留延续；协议1对+剩余29对全部完成；严格判定57/60通过，三项失败保留 | 预算占用¥4.5060184（含未知预留，非Provider账单）；111派发111完成；单模型Pi/current-build串行基线，不替代完整R01或发布门禁；r01-glm-real-evidence.md |

| HARNESS-20261010-038 | 2026-10-10 17:49–17:55 GMT+8 | GLM真实试点收束 | 数值比较与终态/工具错误诊断补强；历史57/60原始判定保留；Electron0.12.138 | 574文件3862pass0fail29skip；typecheck/lint/docs/diff通过；workspace36→36；无新增Provider调用、无新打包；r01-glm-real-evidence.md |
| HARNESS-20261010-039 | 2026-10-10 21:20–21:40 GMT+8 | HR07–HR09锁事件验证 | LockEvent采集（键+阶段，无参数，环形1000）+service快照；6例矩阵：互斥写窗口不重叠、别名同键、共享读重叠、取消零执行、出错释放、unknown串行 | 全仓575文件3868pass0fail29skip；workspace36→36；锁域=本进程内；真实运行窗口证据与G0–G3仍未过；hr-lock-events-evidence.md |
| HARNESS-20261010-040 | 2026-10-10 21:56–22:04 GMT+8 | HR07真实运行锁事件证据 | GLM冲突场景两臂（授权¥10内）：生产调度器LockEvent导出；第二写者acquired严格晚于第一写者execute_end/released | 两臂冲突用例通过；预算累计¥4.5758（本次结算估计¥0.0698，非账单）；写者自然错峰、无实质阻塞等待；每臂1次；hr07-real-lock-evidence.md |
| HARNESS-20261010-041 | 2026-10-10 22:10–22:22 GMT+8 | HR07争用侧与HR08真实观测 | sleep争用两臂通过，totalWaitMs=315ms真实锁等待，事件同毫秒排队授予；并行读4例通过但执行窗口未重叠（发起错峰464ms） | 预算累计¥4.6679/¥10；HR08真实重叠未获证据不宣称；hr0809-real-evidence.md |

以上工程回归不替代G1新完成门禁/调度闭环；V01解析器只验证结构与调用方提供身份一致性，V02切片只补本机权威路径回读与内容/配置新鲜度，不能据此证明来源不可伪造、完整测试收集或业务验收。首批人工简化审查见contracts第6节。实施后逐条追加，不覆盖早期“未实施”历史。当前快照应另在文首标明新的截至时间；不能以文件修改时间代替状态日期。

## 14. 参考资料与执行交接

- 论文：https://arxiv.org/html/2609.00006v1 。架构模式依据，不作为本项目性能验收。
- ACP官方介绍：https://agentclientprotocol.com/get-started/introduction 。本轮已读取；协议细节在A01固定版本后核验。
- ACP官方代码：https://github.com/agentclientprotocol/agent-client-protocol 。本轮未审计源码。
- 既有目录/关闭决定：`docs/plans/2026-09-22-typed-context-compiler-ledger.md`。
- Pilot：`docs/plans/2026-09-26-project-pilot/ledger.md`。本ledger不改写其门禁或继承其PASS。
- 存储：`docs/storage-contract.md`。新权威数据落点和备份必须遵循该合同。

执行下一步：实施授权已取得，继续补齐H02/H03及V02剩余切片，优先冻结实际运行/业务身份映射、固定verifier/criteria配置和受保护测试收集来源（普通任意命令保持退出证据），解决私有证据写入信任边界后再接V03完成门禁；不得直接跳到真实Provider、开启功能或ACP接入。每项采用“失败行为测试 → 最小实现 → 定向回归 → 简化审查 → 记录证据 → 单独可审阅提交”，受影响包patch同步。README/AGENTS变更只提出最小候选并另行请求授权。
