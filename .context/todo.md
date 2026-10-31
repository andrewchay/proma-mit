# 本轮任务：收拢仓库（2026-10-30 21:10 起）

目标：把 50 项未提交改动按主题提交，再与 origin/main（behind 16）对齐，处理重叠文件冲突。
授权边界：允许本地提交与建分支推送；禁止连生产环境、禁止产生真实 Provider 费用。

## 状态：已完成

- [x] 侦察：工作树 33 modified + 17 untracked，main 曾 ahead 3 / behind 16
- [x] 侦察：.context/glm-real-acceptance/ 8.1GB / 37621 文件，已加入 .gitignore
- [x] C1 `fix(autonomy): 拒绝同命令内的 Git 结构执行通道`
- [x] C2 `fix(agent): 以已接受的停止事实作为完成终态`
- [x] C3 `fix(owner): 统一权威交付终态并等待在途轮次退出`
- [x] C4 `fix(owner): 按原回执时间核验历史质量结论并支持显式续期`
- [x] C5 `test(owner): 补齐固定包与真实验收烟测工具`
- [x] C7 `docs(context): 记录 0.13.483 验收结果与 P1 进度台账`
- [x] 分支 `codex/p1-owner-delivery-harness` rebase 到 origin/main（8 提交全部重放）
- [x] C8 `chore(release): 0.13.494 / @gravitas/shared 0.2.149`

## 冲突处理记录

rebase 到 `32f17a5a`（origin/main）时只有两处真冲突：

1. `apps/electron/package.json` 版本号（两次）：取远端 0.13.493，最终统一提到 0.13.494。
2. `project-owner-management-conversation.ts`：远端 #66 新增 `fileChangeObservation`，
   本地新增 `frozenDeliveryReview`，两者都保留。

`project-owner-management-loop.ts` 由 git 自动合并（远端 3 行 fileObservation 改动 + 本地停止逻辑）。

## 验证结果（0.13.494，rebase 后）

日志：`.context/glm-real-acceptance/typecheck-0.13.494-rebase.log`、`typecheck-workspace-0.13.494-rebase.log`

- 全 workspace typecheck：9 个包全部 exit 0。
- `git diff --check`：通过。
- 聚焦测试 **133 pass / 0 fail**：

| 文件 | 结果 |
| --- | --- |
| project-owner-quality-actions.test.ts | 30 pass |
| project-owner-planning-run.test.ts | 19 pass |
| project-owner-execution-revalidation.test.ts | 13 pass |
| project-owner-planning-source.test.ts | 12 pass |
| project-owner-quality-protocol.test.ts | 8 pass |
| git-command-boundary.test.ts | 5 pass |
| owner-quality-revalidation-smoke.test.ts | 4 pass |
| owner-real-chain-smoke-budget.test.ts | 3 pass |
| project-owner-management-failures.loop.test.ts | 2 pass |
| project-owner-management-delegation.test.ts | 37 pass（额外） |

- `bash-sandbox.test.ts`：33 pass / 10 fail。10 项失败均为
  `sandbox-exec: sandbox_apply: Operation not permitted`，本机 Agent 沙箱内无法嵌套
  seatbelt，属环境性失败，与 P1 台账记录一致。

**未跑全仓回归**：本轮只做聚焦验证，不得声称 0.13.494 已完成全仓回归。

## 测试跑法纠正

`.context/` 根目录的 `bunfig.toml` 配置了 `preload = ["./tests/electron-mock.preload.ts"]`。
在 `apps/electron` 子目录跑 `bun test <绝对或相对路径>` **不会加载该 preload**，
表现为 `Export named 'BrowserWindow'/'shell' not found in electron/index.js`。
**必须在仓库根目录执行 `bun test <path>`。**

大文件（quality-actions 约 3 分钟）需后台运行 + 轮询日志，前台单条命令会被会话中止。

## 版本对应关系（重要）

0.13.483 的固定包验收（ZIP SHA-256 `29df89db…b905e6`）构建于 rebase 前内容，
基线不含 origin/main 新增的 16 个提交。0.13.494 引入这些提交后，**固定包结论
不能直接迁移**；若要据此签收，必须在 0.13.494 上重新构建并复跑固定包烟测。

## 已知问题（待后续处理）

1. `project-owner-execution-command.ts` 与 `project-owner-development-artifact.ts` 用
   `require('./owner-quality-revalidation-smoke')` 接入生产路径，仅靠
   `GRAVITAS_PACKAGE_SMOKE=1` 保护。生产代码依赖烟测模块属于临时接线。
2. Git 词法门禁会误伤提交信息与 heredoc 正文：本文档编写过程中，
   提交信息里描述 `git init` 即被拒绝。需要区分命令与文本。
3. `.context/plan/p1-next.md` 中"远端多 1 个提交"已过期（实际曾是 16）。

---

# 追加任务：PR #73 macOS package smoke 失败修复（2026-10-30 22:00 起）

## 目标
让 PR #73 的 Package Smoke 三平台全绿，并修复 macOS 打包缺失 node-pty spawn-helper 的根因。

## 状态：已完成（PR #73 全绿，可合并）

- [x] 定位：macOS 作业报 `posix_spawnp failed`，打包日志有
      `file source doesn't exist from=node_modules/node-pty/build/Release/spawn-helper`
- [x] 结论：CI/发布流水线直接调用 electron-builder，不经过 `rebuild:natives`，
      `build/Release/spawn-helper` 不存在；旧 `mac.extraFiles` 只取该路径，
      electron-builder 仅告警后继续，产出缺 helper 的包
- [x] 新增 `beforePack` 钩子：`apps/electron/scripts/before-pack.cjs` +
      `node-pty-helper.cjs`（build/Release → build/Debug → prebuilds 依次查找，
      缺失即抛错；修补 unixTerminal.js；暂存到 `.packaging/`）
- [x] `mac.extraFiles` 改读暂存路径；`.gitignore` 忽略 `apps/electron/.packaging/`
- [x] `prepare-node-pty.ts` 复用同一实现，删除旧的 `node-pty-packaging.ts`
- [x] 单测 `node-pty-helper.test.ts`：7 pass / 0 fail
- [x] 本地模拟 CI（移走 `build/Release`）：`electron-builder --dir` 成功，
      产出包含 `Contents/MacOS/node-pty-spawn-helper`（0755）且 asar.unpacked 内
      `unixTerminal.js` 含 `GRAVITAS_MACOS_PACKAGED_HELPER`
- [x] Package Smoke 的 macOS 步骤新增 helper 存在性断言
- [x] 提交 `00b93933` 并推送
- [x] CI：macOS arm64 4m36s pass / Windows 6m13s pass / Linux 2m18s pass
- [x] `quality` 作业 pass（15m4s，全仓回归 + lint + docs:check）
- [x] rebase 到 origin/main（0.13.497 基线，含 #71/#72/#76）；重新生成 docs facts
- [x] rebase 后本地验证：typecheck 9 包全通过；聚焦测试 56 + 7 pass / 0 fail
- [x] 修复 CI 门禁：`docs:check` 生成文件过期、quality 作业 20 分钟超时被取消
      → 放宽到 35 分钟（`dac1b95d`）
- [x] 最终 head `f6a6dc38`：macOS 3m39s / Windows 5m53s / Linux 2m14s 全 pass，
      mergeStateStatus=CLEAN

## 环境限制（本地不可绕过）
本机 Agent seatbelt 内 Electron 无法启动（`sandbox initialization failed`），
node-pty 也无法真正起 shell（仓库内短路径同样 `posix_spawnp failed`）。
因此 PTY 行为只能以 CI 为准；本地只验证打包结构与补丁内容。

## 顺带发现
发布流水线（`.github/workflows/release.yml`）同样不跑 `rebuild:natives`，
过去发布的 macOS 包同样缺 helper；本次钩子覆盖该路径，未改发布工作流。

---

# 下一阶段：受控自主身份与恢复边界（2026-10-31 00:35 起）

## 目标
把进程内会话身份绑定从 AI SDK 扩展到 Pi / Proma，用测试覆盖四条绕过路径
（直接调用 / 子 Agent / 恢复会话 / 不同 Runtime），使「身份缺失或不匹配默认拒绝」成立。

## 前置事实核对（已完成）
- [x] PR #73 已合并（`dc4b6e44`）；PR #78 仍 OPEN，三平台包烟测已过、quality 在跑
- [x] `resolveOwnerExecutionGateSession`（project-owner-execution-gates.ts:135）在 sessionId
      无 Owner 证据时返回 `unrestricted` → 门禁结论仍取决于调用方提供的 sessionId
- [x] AI SDK 身份绑定：`ai-sdk-session-identity.ts`；绑定点 `ai-sdk-agent-adapter.ts:181`，
      撤销点 406/415/474；复核点 `ai-sdk-runtime-core.ts:122`
- [x] Pi：`pi-agent-adapter.ts:342` 构造 toolContext（sessionId/cwd 来自 input），
      仅按 sessionId 查账本，无进程内身份比对
- [x] Proma：`provider-agnostic-agent-adapter.ts:43` 直接用 `createCoreTools`，
      仅 `assertNoOwnerBusinessSession`，无身份绑定

## 实施项
- [x] 新增共享身份模块 `agent-runtime/runtime-session-identity.ts`（bind/revoke/assert），
      AI SDK 版改为兼容层委托
- [x] Pi：工具上下文创建即绑定、canUseTool 五处复核、finally 撤销
- [x] Proma：活动会话创建即绑定、执行前两处复核、query/abort/dispose 三处撤销
- [x] 模块级 11 条用例覆盖未绑定/不匹配/撤销/幂等/跨 Runtime；
      适配器级四条路径用例未补（需 electron mock 脚手架）
- [x] typecheck 9 包全通过；身份测试 32 pass；两个适配器测试 61 pass；biome 通过
- [x] PR #79 已开：三平台包烟测 + quality + executor + golden 全绿（head 0c3af055）
- [x] 首轮 quality 因 UI 时序 flake（OwnerManagementConversation.browser.test.ts）失败，重跑通过
- [ ] 等待合并决定；下一片计划见 `.context/plan/p1-identity-next.md`

## 边界
- 不改普通会话行为；只让身份缺失/不匹配时拒绝
- 不动 AGENTS.md / README.md；不声称生产验收
- Bash unknown 门禁、跨进程协调另立切片

## 环境备注
`.context/tmp/`（gitignored）在实施期间被清空，本轮早期临时日志（打包模拟、CI 模拟）已丢失；
结论仍可从 PR #73 与 CI 记录核对。

---

# 切片 2：门禁接收已绑定身份（2026-10-31）

## 状态：PR #80 待 CI/合并

- [x] #79（切片 1：Runtime 会话身份绑定）已被合并进主线 `68f3d304`
- [x] 切片 2 独立成支 `codex/p1-bound-session-gate`，cherry-pick 到最新 main → PR #80
- [x] 实现：`getRuntimeSessionIdentity`、`ToolContext.boundSession`、`assertBoundToolSession`、
      `guardOwnerTool` 与 Read/Write/Edit/Bash 四个入口在用途判定前校验、三 Runtime 注入
- [x] 测试：新增 6 条绑定用例；gates 15 处迁移 + 2 条新用例；stage-b 4 处补绑定
- [x] 本地验证：99 pass（绑定/身份/三适配器）；gates 34 pass / 1 fail（seatbelt 环境，基线同样失败）；
      typecheck 9 包全过；biome、docs:check 通过
- [ ] PR #80 CI 结果；合并后补 PR 说明与台账

## 下一片（未开始）
- 仍只信任 sessionId 的入口：`agent-orchestrator.ts:2870`、两个适配器的 `canUseTool`
- 门禁比对 runtime 种类；直接调用工具且不带 boundSession 的全局强制（需迁移 22 个测试文件）
- 之后：Bash 纳入 unknown 门禁 → 跨进程与崩溃恢复对账

---

# 切片 3：授权判定与 AI SDK 包装校验绑定身份（2026-10-31 11:55）

## 状态：PR #81 待 CI（栈在 #80 之上）

- [x] AI SDK 的 `tool.execute` 包装与 `canUseTool` 接入绑定校验（放行前后各一次）
- [x] `ToolContext` / Proma ctx 增加 runtime；三处注入点写入 'ai-sdk' / 'pi' / 'proma'
- [x] `assertBoundToolSession` 比对 Runtime 种类；未声明 runtime 时保持旧行为
- [x] 测试：绑定用例 8 条（新增 2 条 Runtime 相关）；六文件合计 118 pass
- [x] typecheck 9 包通过；biome / docs:check 通过
- [ ] PR #81 CI 结果；合并顺序：先 #80 再 #81

## 已知剩余
- `agent-orchestrator.ts:2870` 的 canUseTool 仍只按 sessionId：编排层无 Runtime 绑定对象，
  需要先给编排层补绑定点
- 直接调用工具且不带 boundSession 的全局强制（22 个测试文件待迁移）

---

# 切片 4：Bash 未知结果纳入动作门禁（2026-10-31 14:40）

## 状态：PR #83 待 CI

- [x] 前置：切片 1–3 已合并进主线（#79 squash、#80+#81 合并，主线 0.13.500）
- [x] Bash 派发前按「命令 + cwd」查未知记录，命中拒绝并提示 ResolveUnknownAction
- [x] `beginTrackedAction` 登记后才启动；按终止证据结算（exited 已知 / terminated、unconfirmed 未知 / pgid<=0 允许重试）
- [x] 执行抛异常按未知结算（无法证明命令未生效）
- [x] 新增 `bash-unknown-gate.test.ts` 5 条；`bash-launch-revocation.test.ts` 补 stub
- [x] 本地：6 pass（未知门禁 + 撤权）；gates+tool-impls 53 pass / 2 fail（均为 seatbelt 环境）；
      typecheck 9 包通过；biome、docs:check 通过
- [ ] PR #83 CI 结果

## 下一片候选
- 跨进程与崩溃重启对账：受管进程树之外的孙进程、重启后 pending 记录核对
- 编排层 `canUseTool` 绑定点（agent-orchestrator.ts:2870）
- 直接调用工具且不带 boundSession 的全局强制（22 个测试文件待迁移）

---

# 切片 5：身份缺失默认拒绝（2026-10-31 16:20 起，进行中）

## 目标
`assertBoundToolSession` 对「没有绑定对象」不再区分 Owner/普通会话，一律拒绝；
把受影响的测试夹具迁移到携带合法绑定。生产侧已确认只有三个 Runtime 构造 ToolContext 并注入 boundSession。

## 进度
- [x] 前置核对：#83 已合并（`d7b29176`），主线 0.13.500 含切片 1–4
- [x] 生产路径核对：工具实现只被 `tool-registry.ts` 引用，`boundSession` 仅在三个 Runtime 注入
- [x] 规则改造：缺绑定一律拒绝（不再区分 Owner/普通会话）
- [x] 新增 `testing/bound-tool-context.ts`：`bindTestToolContext` 就地绑定
- [x] 迁移 17 个测试文件，只补绑定不放宽断言；新增两条对照用例
- [x] 本地：58 + 58 pass；gates+tool-impls 55 pass / 2 fail（sandbox-exec 退出 71）；
      typecheck 9 包通过；biome、docs:check 通过
- [x] PR #84 已开（`codex/p1-identity-required`），CI 进行中

## 切片 5 补充：CI 暴露的迁移遗漏（2026-10-31 16:55）
- CI 全仓回归失败，定位到两个漏迁文件：
  - `agent-runtime/tool-impls/bash-sandbox.test.ts`（10 条，`run()` 辅助与两处直接调用未绑定）
  - `agent-runtime/tool-effects.test.ts`（1 条，夹具 ctx 未绑定）
- 已补 `bindTestToolContext`；本地复跑 `tool-effects` 10/0、`bash-sandbox` 33/10（失败原因回到
  `sandbox_apply: Operation not permitted`，不再是身份拒绝）
- 教训：改「工具入口必须带绑定」这类规则时，除了 grep 显式调用工具实现的测试，
  还要 grep **外壳辅助函数**（`run(`、`toolCtx(` 之类）和真实执行 Bash 的沙箱测试。

---

# 切片 6：RSI 评测来源冻结 + 对比接到自演化（2026-10-31 18:25 起）

## 现状核对
- 主线 `0.13.502`；#82（RSI run-provenance）、#84（身份缺失一律拒绝）、#86（OpenDesign）均已合并
- RSI 缺口：`shadow-comparison.ts` 无生产调用方；`compareScoreboardEvaluations` 因历史记录无来源，
  固定返回不可比 → 有对比能力、没有对比结论

## 实现
- [x] `BenchmarkEvaluation.definition`：写入时冻结 version / rubricVersion / definitionHash / frozenAt
- [x] `freezeEvaluationDefinition()`：只在写入评测时调用，不回填历史
- [x] `compareRecordedEvaluations()`：按记录自身来源判定；缺来源/哈希或版本不一致 → 不可比并写明原因
- [x] `compareScoreboardEvaluations` 改为委托新函数（不再固定拒绝）
- [x] `selfEvolve` 每轮产出 `comparison` + `comparisonSummary`；接受时复用同一条记录落盘
- [x] 证据文档追加 2026-10-31 节（含边界：历史仍不可比、非影子流量、无统计显著性、未接 UI）

## 验证
- [x] `shadow-comparison` 36 pass；`self-evolver` 12 pass；关联回归 28 pass
- [x] typecheck 9 包通过；biome、docs:check 通过
- [ ] PR #88 CI 结果

## 下一片候选（RSI 收口剩余）
- 报告落到可见处：把轮次对比报告写进 scoreboard 证据文件或 IPC 摘要（当前只在返回值里）
- 真实影子流量采集（需 Provider 授权与费用）
- 统计显著性口径（阈值法之外的检验）
- Provider 账单核对

---

# RSI 收口（2026-10-31 18:40 起）

## 背景核对
- 主线 `175d20f1`（含 #82 运行来源、#83 Bash unknown、#84 身份默认拒绝、#86 设计令牌提示）
- 已有开放 PR：#85（题目/规则摘要）、#88（来源冻结+影子对比接入）、#87（未知动作核对信息，动手领域）
- 上次会话中断点：本地 `main` 上有未提交的「每轮对比结论透到 IPC/EvalPanel」

## 关键发现
- #88 分支基线早于 #86，**直接合并会回退设计令牌缺失提示**（design-context -3 行、测试 -1 条）
- #85 与 #88 都改 `eval/types.ts` / `commands.ts`，分开合入要两轮冲突处理

## 采取的做法
以最新主线新建 `codex/p1-rsi-closeout`，把三部分合成一条分支：
- [x] `db478d74` #88 内容 rebase 到主线（不再回退 #86）
- [x] `55421490` #85 内容（题目/规则摘要）
- [x] `c1739055` 本轮新做：`ImproveSummary.rounds` + 三个门禁参数 + preload 类型 + EvalPanel 逐轮展示
- [x] `5ff2f7e5` 证据文档补「收口状态」与未闭环边界
- [x] 本地验证：eval 六个测试文件 79 pass / 0 fail；typecheck 9 包通过；biome、docs:check 通过
- [ ] PR #89 CI 结果
- [ ] 决定是否关闭被本分支覆盖的 #85 / #88

## 收口后 RSI 剩余（需真实环境/人工）
影子流量采集、统计分析（显著性）、Provider 账单核对、真实人工验收

---

# Harness 可靠性：目标 ↔ 产物 ↔ 验证回执贯通（2026-10-31 19:30 起）

## 用户口径
路线图第 4 项：补足「目标、当前产物、验证回执」的完整关联与新鲜度检查；
验收含：验证后改动产物、修改冻结标准、零测试、旧回执重放、独立评审缺失、真实人工接受（后者需人）。
同时明确：跨文件事务、跨进程、部分 Runtime 边界**不能视为已解决**，不得在文档/回执里写成闭环。

## 进度
- [x] PR #89（RSI 收口）CI 全绿：quality + 三平台包烟测 + executor 全 pass
- [ ] 只读审计五项验收的「已有实现 / 缺口」（委派中）
- [ ] 按审计结论做最小切片（字段 + 校验 + 测试）

---

# Project Owner 外部变化观察 · 一期方案（2026-10-31 23:20 起）

## 用户口径
在提供的方案文档基础上，先对照代码评审，再把第一至三批拆成可执行切片落盘，等审批后动手。
本轮**只做评审与方案**，不改业务代码。

## 产出
- [x] `.context/plan/project-owner-external-watch-p1.md`（现状核查 + 逐条对照 + 一期设计 + S0–S8 切片 + 测试映射 + 三个待决策开关）
- [x] `.context/note.md` 追加当日核查结论

## 关键事实（评审结论）
- 外网扫描与 Owner 零耦合，扫描结果进不了项目对话
- 判断为自由文本，无五种判断状态；通知依赖字面字符串匹配
- 去重仅 URL+snippet，窗口为最近 30 次运行；JSONL 不轮转
- 无用户反馈机制
- 可复用的同族样板：`file_change_observation` 六环节链路

## 待用户决定
- [x] 通知策略：S7 前保留现有通知，收敛只在 S7 做（2026-10-31 已定）
- [x] 判断费用归属：走 Owner 现有预算，无预算整轮跳过（2026-10-31 已定）
- [x] 历史保留数值：观察记录 500 条 / 90 天，扫描 JSONL 90 次并轮转（2026-10-31 已定）
- [ ] 是否启动 S0–S1

## 未开始
- [x] S0 前置核查（2026-10-31 完成；新发现：projects/web-watch/*.json/jsonl 不随项目删除清理，转 S4）
- [x] S1 观察账本（2026-10-31 完成：shared 类型 + 账本模块 + 建表 + 删除清理 + 11 项单测）
- [ ] S2 判断协议（结构化输出 + 不可信包裹 + 失败降级）
- [ ] S3 确定性去重
- [ ] S4 扫描链路改造（含 JSONL 轮转、web-watch 文件删除清理）
- [ ] S5 投递到项目对话
- [ ] S6 用户反馈
- [ ] S7 通知收敛
- [ ] S8 真实项目观察

## S1 验证结果
- 11 项单测全通过；typecheck 9 包 exit 0；biome 5 文件通过；docs:check 通过（已重新生成 repository-facts）
- 既有回归：project-file-change-policy 9 项、project-web-watch-service 5 项全通过
- 实现期修正：contentHash 不覆盖 createdAt（否则重复写入会误报内容不一致）

---

# 外部变化观察 S2：判断协议（2026-11-01 00:04 起）

## 状态：已完成（未提交）

- [x] `project-web-observation-prompt.ts`：可信区/不可信包裹、时间与相关性规则、截断标注、协议版本 1
- [x] `project-web-observation-parse.ts`：两级字段白名单、来源归属复核、发布时间归属、降级候选、账本入参转换
- [x] 15 项单测（含端到端落库、降级落库、零引用 record_only）
- [x] S1 两处修正：record_only 允许零引用；同源去重改为「来源 + 事实/推断性质」

## 验证
- 26 pass / 0 fail（S1 11 项 + S2 15 项）；typecheck 9 包 exit 0；biome 通过；docs:check 通过

## 未接线
- 提示词与账本之间还差 S4 的调用点，判断链路尚未进入扫描服务

## 下一步
- [ ] S3 确定性去重（URL 归一化查账本、关联指针）
- [ ] S4 扫描链路改造（含 JSONL 轮转与 web-watch 文件删除清理）

---

# 外部变化观察 S3：确定性去重（2026-11-01 00:20 起）

## 状态：已完成（未提交）

- [x] 事实新增 `snippetDigest`（来源摘要指纹），去重不再依赖扫描流水窗口
- [x] `snippetDigestOf` 单一实现；账本写入时自动计算
- [x] `listPriorObservationsBySource`：重复判定记录不参与，避免指针链
- [x] `applyDeterministicDedup`：同源同摘要 → duplicate；同源新内容 → 保留判定 + 关联；旧记录无指纹 → 保守重复
- [x] 10 项单测（含 40 次扫描后仍命中最早来源的窗口外验证）

## 验证
- 36 pass / 0 fail（S1 11 + S2 15 + S3 10）；typecheck 9 包 exit 0；biome 通过；docs:check 通过

## 边界
- `same_event`（多 URL 同一事件）仍由模型判断，本层不做语义归并

## 下一步
- [ ] S4 扫描链路改造（提示词 + 解析 + 去重接入；JSONL 轮转；web-watch 文件删除清理）

---

# 外部变化观察 S4：扫描链路接入（2026-11-01 00:48 起）

## 状态：已完成（预算结算除外，未提交）

- [x] `project-web-watch-store.ts`：路径 + 删除清理（脱离项目服务，避免循环引用）
- [x] `project-web-change-judgment.ts`：解析 → 去重 → 落账的编排，纯本地可测
- [x] 扫描服务：删掉自由文本分析，改为「上下文装配 → 提示词 → 模型 → 判断落账」
- [x] run 新增 `observationId` / `judgment` / `status: skipped` + `skipReason`
- [x] 模型/解析失败记 `insufficient_evidence` 留证，不再把整轮扫描判为 failed
- [x] 通知改为按 judgment（attention / decision_required）触发
- [x] 流水保留 90 次并自动轮转
- [x] 项目删除清理 web-watch 的 json/jsonl（S0 发现的泄漏）
- [x] 项目页 `skipped` 不再显示为"失败"

## 验证
- 48 pass / 0 fail（S1 11 + S2 15 + S3 10 + S4 7 + 既有调度 5）
- typecheck 9 包 exit 0；biome 6 文件通过；docs:check 通过

## 未闭环（不得写成已完成）
- [ ] 模型未复用 Owner 配置：仓库缺项目级 Owner 模型访问器，模型只存在于每次运行的 admission 绑定
- [ ] 预算门禁是只读：扫描费用未写入 Owner 委托账本，只能拦"额度已满"，不能让扫描消耗被记账
      → 需决定是否给扫描建认领与结算记录

## 下一步
- [ ] S5 投递到项目对话（shared kind + store 幂等 + conversation 四处 + 协议白名单 + UI 卡片）

---

# 外部变化观察 S5：投递到项目对话（2026-11-01 00:55 起）

## 状态：已完成（未提交）

- [x] shared：消息 kind `web_change_observation` + `webChangeObservationId`；规划上下文加 `webChangeObservation`；IPC 通道
- [x] store：该 id 只允许出现在 assistant 的观察消息；幂等比对补字段
- [x] conversation：账本复核、来源校验、触发白名单、目标变更提示、授权失效提示、就绪文案
- [x] planning-protocol：字段白名单、子结构校验、throughMessageId 允许观察消息、专用提示词、只允许 conversation_reply
- [x] 投递模块：只投 attention/decision_required；目标已变改写 attention 提示
- [x] IPC 四段式：shared 通道 → 主进程 handler → preload → 渲染层卡片
- [x] 观察卡片：事实+来源链接、推断单列、影响/建议/待决问题、未确认发布时间提示

## 验证
- 77 pass / 0 fail（6 个文件，含新增 4 项对话链路用例）
- typecheck 9 包 exit 0；biome 12 文件通过

## 未覆盖
- [ ] 观察卡片的浏览器用例未补（需界面环境）；无数据时回退为对话摘要文本

## 下一步
- [ ] S6 用户反馈（表 + IPC + 卡片按钮 + 反馈进判断上下文）
- [ ] S7 通知收敛与失败限流
- [ ] 预算结算口径待决定（只读门禁 vs 建认领结算）

---

# 外部变化观察 S6 / S7 / S8（2026-11-01 00:22 起）

## S6 用户反馈：已完成
- [x] 新表 `project_web_observation_feedback` + 反馈模块（helpful / irrelevant / snooze）
- [x] 静音策略：不相关长期、暂不关注 7 天（1–90 可调）到期失效；重复提交幂等
- [x] 判断层：来源全静音时 attention / decision_required 降级 record_only 并写明原因
- [x] 提示词接入最近 20 条反馈；IPC 四段式 + 卡片三个按钮
- [x] 5 项单测

## S7 通知收敛：已完成
- [x] `shouldNotifySuccess` / `shouldNotifyFailure` 移入 policy 模块（纯函数）
- [x] 成功提醒当天最多一条；失败 24 小时最多一条；连续 3 次失败后不弹系统通知
- [x] 成功一轮重置 `consecutiveFailures`
- [x] 7 项 policy 单测

## S8 真实项目观察：未执行（需真实环境）
- [x] `.context/plan/web-observation-s8-runbook.md`（前置条件、7 天步骤、记录表、结论模板、已知限制）
- [x] `project-web-observation-metrics.ts` 质量汇总 + 4 项单测
- [ ] 真实 7 次扫描与人工对照（需真实 Provider/搜索凭据/真实项目，且需你授权花费）

## 验证
- 64 pass / 0 fail（7 个测试文件）；typecheck 9 包 exit 0；biome 13 文件通过；docs:check 通过

## 未闭环（跨切片）
- [ ] 预算结算口径：扫描费用未写入 Owner 委托账本，只有只读门禁
- [ ] 模型未复用 Owner 配置（缺项目级 Owner 模型访问器）
- [ ] 观察卡片无浏览器用例
