# Pi mid-turn 崩溃恢复：落地方案与执行台账

日期：2026-10-05 · 状态：方案待确认，未实现 · 适用范围：Gravitas 现有 Pi coding-agent adapter；不引入 pi-durable

## 目标和不可妥协边界

- 目标：应用异常退出后能说明停在哪一步，保留**已提交**的输出；仅在证明请求未发送、工具无副作用且费用可控时自动继续。不是恢复已断开的 HTTP 流。
- 数据权威：已完成对话继续以 `agent-session-manager.ts` 的会话 JSONL 为权威；新增恢复流水只记录未完成 turn 的临时事实。不能从 UI 看到的 partial 推断它已持久化。
- 第一版仅 Pi 人工会话；Pilot/AI 员工、自动化、委派子会话、MCP 写调用**只观测/停等**。Pi Pilot 的 readiness/capability 不变。应用内 Crash/强杀测试只在隔离数据目录和独立测试进程执行，不在当前生产进程做。
- 不自动重放副作用未知的工具；不自动重发已经可能到达 Provider 的请求；未知费用计入待对账而非“免费失败”。普通非 Pilot 也明确告知可能重复计费。
- 实施前确认两项产品决策：第一版的默认恢复是“仅显示中断并等待用户确认继续”还是“仅发送前状态自动继续”；历史 partial 是否展示为中断草稿（默认仅展示，不作为模型上下文）。

## 事实基线（必须保留）

- `agent-orchestrator.ts:1003` 先追加 user SDKMessage；`:1120-1141` 在 `adapter.query()` 结束后才批量追加非 `_partial` 消息。崩溃窗口内已显示的 assistant/tool 消息可能未入会话 JSONL。
- `pi-agent-adapter.ts:544-600` Pi `message_update` 被合并为 50ms UI partial；`message_end` 发最终消息；`:611-630` 的 `tool_execution_start/end` 是观察事件，不是副作用前可靠提交点。
- `pi-tool-bridge.ts:createBridgeTool().execute` 在权限通过后执行 `runtimeTool.execute()`；另有 collaboration/VisionRelay 等直接构造 ToolDefinition 的入口。所有工具入口须统一审计，否则不得标为可恢复。
- `agent-session-manager.ts:271` 现有 `appendSDKMessages()` 直接 appendFileSync，按 256K chars 截断；未提供多文件事务、尾损坏修复或 fsync 保证。不能宣称会话 JSONL 与恢复流水原子提交。
- `pi-agent-adapter.ts:458-486` 有 Pi 有限费用门禁；`:761+` 普通 Pi 有断流重试，有限费用模式禁止重试。新增恢复不能绕过这两条；`project-pilot-recovery.ts` 和员工心跳现有失联停等语义不得被覆盖。

## 决定性的架构选择

**新增一份按 sessionId 分隔的 Recovery Journal，不直接修改现有会话 JSONL 行格式。** Journal 按 `turnId`、`attemptId`、`requestId`、`toolCallId` 建索引，只有一个主进程写者。先用追加式 JSONL + commit marker + 尾截断恢复；关键状态（发送准入、工具执行意图、结果、完成）要求 fsync 文件及需要时目录。若评估发现文件锁/多记录原子提交无法证明，则改在已有项目 SQLite 单写者里建表，而非另起数据库。评审门禁 G0 必须选定一种存储并用故障注入证明；不能混用两种权威。

Journal 的事务写入要有 seq、schemaVersion、turnId、parent seq、时间戳、校验和、commit marker。重启仅读完整事务；损坏尾部先隔离原文件，再修复。`(sessionId,turnId,eventId)` 唯一，重复回调不重复追加。运行实例持有 epoch/lease；若旧进程仍在运行或 lease 不明，停止恢复，不抢占。

建议记录：`turn_accepted`（用户 UUID + prompt 摘要/附件指纹、非明文密钥）、`request_prepared`（模型/渠道/上下文指纹）、`request_send_intent`（不等于已送达）、`request_settled`（可信响应/用量）、`assistant_partial`（可覆盖的 UI 草稿）、`assistant_final`、`tool_intent`、`tool_result`、`turn_terminal`。只存最少必要信息；敏感 tool 参数/图片不重复落盘，可用哈希+会话授权引用，重启若无法重构则停等。

## 分阶段执行台账（BDD：Given / When / Then）

| ID | 交付与明确步骤 | 涉及文件 | 验收门槛 | 状态 |
|---|---|---|---|---|
| G0 | 先画状态机/失败矩阵并定存储：请求的 `not_sent / possibly_sent / response_committed / unknown`，工具的 `prepared / executing / result_committed / unknown`；定义“中断”和“可继续”的产品语义；审查所有 Pi 工具入口及 Prompt/compaction/重试路径。明确 epoch/锁和主进程唯一写者。 | 本文 + `pi-agent-adapter.ts`、`pi-tool-bridge.ts`、`agent-orchestrator.ts`、`agent-employee-service.ts` | 每个状态有唯一恢复决策；**禁止把 `request_send_intent` 当成没发请求**；权限/MCP/委派独立路径全部列出。 | 待做 |
| P1 | 独立 `pi-recovery-journal.ts`：事务 commit marker、校验和、关键记录 fsync、尾损坏修复、单写者/epoch、schema 版本、上限/清理；实现 `loadTurn`, `appendEvent`, `settleTurn`、崩溃前后幂等。设计量级控制：partial ≤ 每 250ms/一定字节且不 fsync 每次 token，**只有经 flush 的 partial 称“已提交”**。 | 新模块 + 单测 | Given 关键事件后强杀/撕裂写 When 重开 Then 只读完整 commit、不跨 turn 串线；重复写只保留一次；fsync 失败 fail-closed。 | 待做 |
| P2 | 只观察、不续跑：`agent-orchestrator.ts` 创建稳定 turnId（先写 accepted 再调用 adapter），接受流式事件并写 Journal；`pi-agent-adapter.ts` 于 `message_end` 记录完整 assistant 与 tool result，partial 只记可恢复草稿；在成功持久化至现有会话 JSONL 后写 `turn_terminal`。加固定 UUID/seq 去重与持久化失败提示。 | orchestrator / adapter / session-manager + 测试 | Given 模型出字/工具完成后进程死 When 启动 Then UI 显示已提交 partial/中断；旧会话完整最终消息不会重写；不存在 UI 显示“已保存”而本地无记录。 | 待做 |
| P3 | Tool Bridge：权限通过后、每个 `runtimeTool.execute` 前提交 `tool_intent`；返回后提交 `tool_result`；对 collaboration、VisionRelay、GoalCheckpoint、AskUser、MCP/plugin 等非桥接/特殊路径做统一 wrapper 或明确强制 `unknown`。给工具显式 `safe_replay` 注册表；默认 unsafe，即使叫 Read/Bash 也不能只按名称自动重放。 | `pi-tool-bridge.ts` + 直注入工具调用点 + 测试 | Given 崩溃在 execute 前/中/结果后 When 恢复 Then 仅双方审计过且重启后权限仍有效的工具可重做；写入、浏览器、委派、外部服务绝不自动执行两次。 | 待做 |
| P4 | 启动协调器 `pi-recovery-service.ts`：与现有消息重播种、权限/会话活动、员工 stale 和 Pilot 对账协商；只有一个入口 claim。对未知模型费用/工具结果显示“待人工确认/待对账”，不要自动构造 `tool_result` 假称执行失败。partial 独立于模型上下文显示；禁止静默把其当历史 assistant。 | main 初始化 / agent-session-manager / Agent UI / 员工与 Pilot 只读适配 + 测试 | Given 请求可能已到 Provider 或工具可能已执行 When 重启 Then **零 HTTP/零工具自动调用**；同一 turn 只出现一个恢复提示，不制造成功回写或重复派发。 | 待做 |
| P5 | 受限自动继续：仅证明 `request_prepared` 且**未进入可发送路径**、无副作用的 turn 可重新进入原调度（同 turnId、不再追加 user）。工具和“可能发送”请求仍人工控制。若人工确认重发，建**新 attemptId/requestId**，展示额外计费提示并走现有预算/权限门禁；Pilot 一律先保持禁用。 | orchestrator + adapter + Journal + 测试 | Given 任意 send-intent/未知回执 When 重启 Then 不自动发送；Given 可证明未发送 When 重启 Then 仅一次续跑，原用户消息不重复；禁止突破 retry/compaction/Pilot 门禁。 | 待做 |
| P6 | 灰度与运行验收：功能默认关 → 开启仅观察 → 仅用户手动恢复 → 限域自动恢复；单独测试 HOME/工作区启动，不杀当前承载会话的生产版。打包检查 ASAR 与多实例锁；记录已恢复/待对账/重复抑制/尾修复指标（不含敏感文本）。 | 设置开关、打包脚本、诊断与 E2E 夹具 | 每个提交点杀进程矩阵通过；typecheck、Pi 定向/全仓回归、`dist:fast` 冒烟通过；真实 Provider 测试须用户授权预算/次数后执行。 | 待做 |

## 故障注入矩阵（必须逐项留证）

1. 追加 user 后、send-intent 前 → 不重复 user；确认请求绝未发时才自动恢复。
2. send-intent 后、HTTP 零数据 / 部分 token 后 → 保留未知费用，**绝不自动重发**；草稿显示中断。
3. assistant final 已写 Journal、会话 JSONL 尚未写 / 已写但 terminal 未写 → 以 UUID 去重对账，绝不重复完成回调。
4. 权限申请中、已批准未执行、工具执行中、工具返回未提交结果、结果提交后 → 默认停等；批准不跨重启自动沿用，外部结果不凭空补造。
5. 写文件/Bash/浏览器/MCP/Goal/委派/AskUser 各类工具至少一例 → 不重复副作用；不把 tool_start 观察事件当作副作用前屏障。
6. JSONL 撕裂行、commit marker 丢失、fsync 失败、目录不可写、两进程同时打开 → 修复/拒绝路径明确；不可因错误走无 Journal 的旧路径继续执行。
7. 中断同时发生在 watchdog、Pi 内部重试、压缩、员工心跳/Pilot 对账 → 费用未知停等、员工任务 paused/stale、不覆盖已经 settled/终态状态。

## 合并门禁与明确不做

- 第一阶段上线门槛：P1–P4 的故障矩阵全绿且人工可识别中断；未通过则只保留记录功能不恢复执行。
- 自动继续门槛：P5 的“确证未发送”路径可证、跨进程与整轮完整回归通过；没有可信发送前边界就不发布自动续跑。
- 不做：接入 `pi-durable`、替换 Pi 原有 SessionManager、自动重试已发送请求、默认信任工具名、自动恢复 Pilot/AI 员工成功交付、对无法证明的旧会话伪造可恢复 checkpoint。
- 与 Pi 1.0.2 试用分支分开实施；该分支尚未完成真实渠道验收。当前 `apps/electron/src/main/lib/project-pilot-dispatch.ts` 有外部未提交改动，本方案不得覆盖或带入提交。
