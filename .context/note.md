## 2026-08-08 修复记录（上一条审查后实测完成）

> 针对上一条综合审查结论，已修复以下代码漏洞（electron tsc 全绿 + 相关测试 25+ pass）：

- ✅ **委派双重计数**（`agent-collaboration-tools.ts`）：新增 `resolveParentForDelegation(ctx)`（只校验层级、不占配额），替换 6 处 `delegate_agent`/`delegate_agents` 外层 `assertCanCreateDelegation`；配额统一由 `startDelegation` 内 `assertCanCreateDelegation(ctx,1)` 单点累加。修复"单根实际只能建约 8 个委派、批量 16 个整批失败且配额锁死"。
- ✅ **AI 员工执行查询 key**（`agent-employee-service.ts`）：新增 `getTaskExecutionByTaskId()`，`updateTodoStatus`/`queryTodoStatus` 改按 `entityId` 取最近非终态执行（并回退兼容 executionId）。
- ✅ **失败/完成回写幂等**：`handleExecutionError`/`handleExecutionComplete` 把 `failed/stale/cancelled` 一并加入防重入守卫，杜绝 onError 与 .catch 双路径重复回写。
- ✅ **非可执行态拦截**：`dispatchTaskToAgent`/`dispatchTaskToAgentIfIdle` 统一只派发 `pending`/`in_progress`（completed/draft/paused 一律拒绝），阻断"失败→置 paused→又被自动重跑"类死循环变体。
- ✅ **派发并发锁**：新增进程内 `dispatchInFlight` per-task 锁，防同任务并发双派发。
- ✅ **`syncAllMembers` 并发旁路**（`member-sync-service.ts`）：改为受 `syncInFlight` 门闩保护 + 两平台串行，防手动与定时/启动同步并发写库竞态。
- ✅ **team-profile 原子写 + 字段限长 + 注入措辞**（`team-profile-service.ts`）：tmp+rename 原子写；每字段 4KB 上限、上下文 12KB 上限；提示词显式声明为"非指令性背景数据"。
- ✅ **credential-registry 加密态动态判定**（`credential-registry-service.ts`）：bot 凭据 `encrypted` 改为读 `safeStorage.isEncryptionAvailable()`，不可用环境如实标注并列入风险，不再无条件 true。
- ✅ **plugin-manager manifest 结构校验**（`plugin-manager.ts`）：`sanitizePluginManifest` 强制 id/name 类型与长度、规整 surfaces/subscriptions/platforms 数组、permissions/entrypoints 归一化；`importPluginFromManifest(null)` 安全返回 false，不再抛 TypeError。
- ✅ **inter-invoke 文本限长**（`agent-invoke-service.ts`）：task/result 各 10KB 上限。
- ✅ **baseline typecheck 修复**（`mention-utils.ts` `isTriggerInsideSchemeUrl`）：`schemeMatch[1]` 可空加守卫。

**仍在跟踪（未在本轮修复）**：member-sync 飞书 HTTP 无重试/无 `code===0` 校验、子部门丢 open_department_id、姓名合并 `LIMIT 1` 无排序、冷却不落盘；`registerProjectAutoSync` cleanup 未接线；inter-invoke IPC 无调用者强身份绑定（桌面单机 + contextIsolation 下风险有限）。这些改动边界较大或有架构权衡，建议后续单独迭代处理。

---
## 2026-08-08 全量代码复审｜分工并行（5 子会话）＋个人深审 结果合并

> 复审对象：08-06 晚 ~ 08-08 两天 agentic-os 全部代码改动（111 文件 / +7104 行）。
> 方式：只读，git diff + 源码。本条目为 5 路并行子会话报告 + 本人对核心文件复验后的**合并去重结果**。
> 详细分文件见：`.context/note-security-review-2026-08-08.md`（安全类）、各子会话原始结论在各自报告。

### 🔴 高优先（建议尽快修）

1. **委派累计计数双重计入 → 根会话委派配额减半 / 批量锁死**（`agent-collaboration-tools.ts`）
   - 单次 `delegate_agent`：L884 `assertCanCreateDelegation(ctx)` 默认 +1，随后 L885 `startDelegation` 内 L698 又 `assertCanCreateDelegation(ctx,1)` 再 +1 → **每建 1 个委派净 +2**。
   - 批量 `delegate_agents`（L900+外层 `+items.length`，每个 item 内再 +1）→ **+2N**。
   - 后果：`MAX_TOTAL_DELEGATIONS_PER_ROOT=16` 实际只能建约 8 个；批量申请 16 个时首条即越界、整批 failed，且 `rootDelegationCount` 已占满不再回收 → 该根会话**后续再也无法建任何委派（功能锁死）**。这是本次「防 230+ 会话爆炸」修复引入的**回归 bug**。
   - 修复：把累计占用只保留在**最外层调用点**（delegate_agent / delegate_agents 各登一次），`startDelegation` 内不要再 `assertCanCreateDelegation`；批量失败项要做占位回滚。

2. **AI 员工执行的状态查询/取消用错 key（`getAgentExecution(taskId)`）**（`agent-employee-service.ts:629/661`）
   - `updateTodoStatus`/`queryTodoStatus` 用 `store.getAgentExecution(taskId)`，但 `getAgentExecution` 按主键 `id` 查（=`randomUUID` 的 executionId），**`taskId` 不是 execution id**（execution 的 `entityId` 才是 task id）。
   - 现状调用链：对 AI 员工任务 `syncUpdatedTaskStatus` 走 `!isAgentAssignee` 分支，不调 agent provider 的 updateTodoStatus；且 AI 任务不走 `syncTaskToExternal`，`externalSync.agent` 从不写入。故**当前现实触发概率低**，但一旦未来有调用方按 taskId 语义调用取消/查状态，会静默失效（查不到 execution）。属"待修复的隐患键位不一致"。
   - 修复：改按 `entityId` 查（新增 `listAgentExecutionsByEntity('task', taskId)` 后取最近一条非终态），或保持 GetAgentExecutionById 语义由调用方传 executionId。

3. **GLOBAL/PROJECT 并发上限存在 TOCTOU 竞态窗口（脆弱原子）**（`agent-employee-service.ts`）
   - 并发计数靠「同步读 DB running 数量 + 同步置 running」才不超限；headless 路径 `createAgentSession` 为同步、`updateAgentExecution(running)` 在其后同步，故**当前不会超限（已正面验证）**。
   - 风险：一旦 `createAgentSession`/`startAgentWorkflow` 的 `await executeWorkflowRun` 让出事件循环，两个 queued 可能同时读到额度通过 → 双启动。建议补进程内信号量/内存计数作为护栏，防未来异步化引入竞态。

### 🟠 中优先（并发/一致性）

4. **`syncAllMembers` 绕过并发门闩**（`member-sync-service.ts`）：IPC 手动同步直接 `Promise.all([syncPlatform('feishu'),syncPlatform('dingtalk')])`，不设 `syncInFlight`；可手动＋定时＋启动三路并发写库，且两平台可经姓名合并命中**同一条** member 行 → RMW 竞态丢更新。应在 `syncAllMembers` 内复用串行 guarded 同步。
5. **飞书成员拉取无 `code===0` 校验 + 无重试 + 子部门丢 openId**（`member-sync-service.ts`）：root 请求失败静默落入裸 /users 兜底返回"空成功"；任意 HTTP 层异常整体失败无退避重试；部门 BFS 子部门入队只保留 `{id,name}` 丢了 `open_department_id` → 深层部门成员可能漏拉。建议根/分页加校验与退避重试、子部门补 openId。
6. **`handleExecutionError` 非幂等，onError 与 .catch 双写**（`agent-employee-service.ts:296/513`）：防重入只查 completed/cancelled，不防 failed/stale；runner reject 时 onError+`.catch` 都触发 → 重复置 failed、重复 bumpStats、重复更新任务、重复活动记录。应对 failed/stale 也幂等。
7. **已完成/草稿之外的状态未拦截重派**（`agent-employee-service.ts` `dispatchTaskToAgentIfIdle`）：只拦 `completed`/`draft`，`cancelled`/`paused` 任务若再触发 `onTaskChange('updated')` 会被**重新派发执行**（取消的任务可能被自动重跑）。建议把非可执行态（cancelled）一并拦截。
8. **`dispatchTaskToAgentIfIdle` 的 check-then-act 非原子**（同 3 竞态）：无 `UNIQUE(entity_type,entity_id)` 兜底，同一任务两次并发 updated 可能双派发。可在 `agent_executions` 加唯一约束或 CAS。

### 🟡 值得跟踪（不紧急）

9. **team-profile-service `writeAll` 非原子写**：`writeFileSync` 直接覆盖 + RMW 无锁，并发 update 可能写坏 JSON；且 `readAll` 解析失败 return {} 会吞掉整份档案。建议 tmp+rename + 互斥。
10. **team-profile 字段无校验/无长度限制，直接注入 Agent system prompt**：`updateTeamProfile` IPC 原样接收渲染进程 patch 拼进 system prompt，可能被塞超长文本或提示注入指令。建议 IPC 层白名单 + 限长。
11. **credential-registry `encrypted:true` 无条件标注**：bot 凭据用 safeStorage，`isEncryptionAvailable()==false` 时明文落盘但面板仍显示"已加密"→ 假安全感。建议运行时判定。
12. **plugin-manager `registerPlugin` 缺 manifest 结构校验**：仅查 id/name 真值；`surfaces` 传非数组会在渲染层 `.map` 抛错；`importPluginFromManifest(null)` 无守卫抛 TypeError。建议白名单 schema 校验 + object 守卫。
13. **inter-invoke IPC（SEND/LIST/RESPOND_AGENT_INVOKE）无调用者身份绑定**：信任渲染进程的 fromMemberId/toMemberId，可伪造/跨成员窥探/任意覆写。建议从 event derive 真实成员比对 + 写审计。（PH2-F）
14. **member-sync 姓名合并 `LIMIT 1` 无排序**：同名多人时随机串线；跨平台纯姓名合并可能吞掉重名不同人。建议消歧/拒绝合并。
15. **member-sync 冷却不落盘**：`lastSyncAt` 进程内存态，重启必全量重拉、失败无退避。
16. **性能**：StmtCompat 每次 `.run()` 都全量 export+writeFileSync 落盘（GLOBAL 并发下 IO 放大）；`getCostMiniLedger` MEMO 全量加载；`listTeamSkillUpstreams` 同步全盘扫阻塞主进程；Mailbox/FileEvent/Todo 面板 `setInterval` 无 in-flight 防护可能触发重复请求。

### ✅ 验证过关项
- 完成回显→重派死循环主环路已切断（`dispatchTaskToAgentIfIdle` 拦 completed/draft + Diag 日志），非本迭代重开。
- 全部窗口 `contextIsolation:true / sandbox:true / nodeIntegration:false`。
- 8 个前端目标文件无任何 `dangerouslySetInnerHTML` / `eval`，JSX 自动转义，无 XSS。
- sql.js `StmtCompat.get/all/run` 全 `?` 参数绑定，无 SQL 注入。
- 高危命令正则全部为简单前后缀匹配，无 ReDoS。
- `delegationDepth` 是层级锁（>0 拒绝建子会话），AI 员工 headless 强制 =1 从根本上禁自我委派，设计正确。
- GLOBAL 并发满时不会永久卡任务（heartbeat 60s 重调度 queued，最多延迟 60s）。

---
## 2026-08-08 代码安全/质量复审视（PH1-D / PH2-A~F 大迭代）

审查对象：2026-08-06 晚至 08-08 两天对 7 个 lib 文件的改动。只读审查，依据 git diff + 源码。
仓库：`/Users/chaihao/.proma/agent-workspaces/proma-mit/project`
涉及 commits：cf1f5748 / e388d10a / 61f244d6 / 8baccb55 / e321e5bd / 2aa98cbc / b65229a3 / d96b7b1a / 5157d366

结论概览：无 P0 级别任意文件删除/越权直击；发现 P1 级（审批/互调 IPC 无调用者身份绑定）、P2 级（凭据加密状态误报、manifest 校验缺失、高危命令探测可绕过、removePlugin 逻辑删除不全）若干。正则均无回溯风险（简单前后缀匹配），凭据未明文回显。

- **agent-invoke-service.ts（PH2-F 新增）**
  - P1：`ipc.ts:1700-1710` SEND/LIST/RESPOND 三个 IPC 直接信任渲染进程传入的 `fromMemberId/toMemberId/id`，无调用者身份校验 → 可伪造他人身份发送互调、可列举任一成员收件、可对任意 invoke 改状态/塞 result。
  - 漏洞点：`sendAgentInvoke`/`listIncomingInvokes`/`respondToInvoke`（agent-invoke-service.ts:70/82/94）
  - 修复：从 `_event`（webContents/主会话）derive 真实成员，与入参比对；list 仅返回本人;respond 校验 id 属于 toMemberId=本人；响应写审计。
  - P2：`respondToInvoke` 可任意覆写 status/result，无所有权校验，且无审计记录。
  - P2：`sendAgentInvoke` id 熵低（DateTime+4位随机，约 1e6），可枚举；`result` 为攻击者可控文本。
  - 低：`console.log` 暴露 task 前 40 字符到日志（轻微信息泄露，非凭据）。

- **credential-registry-service.ts（PH2-D 新增）**
  - P2：`listCredentials` 对 feishu_bot/dingtalk_bot 无条件标 `encrypted: true`；实际 feishu-config/dingtalk-config 用 safeStorage，`isEncryptionAvailable()==false` 时明文落盘（代码注释自证）。→ 体检面板误报「已加密」，false-security。MCP 用 runtime-secret-codec 真加密，该分支标注正确。
  - 修复：把 `encrypted` 改为真实读取存储加密可用性（safeStorage.isEncryptionAvailable()），或至少对 bot 分支按其启用状态计算。
  - 低/已缓解：只暴露 hasSecret/encrypted/label，不回显秘钥明文，无明文泄露。

- **agent-permission-service.ts（PH2-③）+ orchestrator.ts:2279**
  - P2：`isHighRiskTool` → `assessDangerLevel` → `isDangerousCommand`（packages/shared/.../permission-rules.ts:109）仅 `trim().toLowerCase().startsWith(rival)`：`/bin/rm -rf /`、`/bin/sudo cat /etc/sudoers` 等带路径前缀后缀的命令绕过检测；`hasDangerousStructure` 只抓 `| > ; & $( backtick`，`rm -rf /tmp` 这类纯命令+参数不带结构符号也能出现在 bypass 模式（但 `rm` 前缀本身命中——真正绕过的是加完整路径或空格内联的变体）。前缀黑名单方案已知局限，非本次引入，但本次把它升级为「无人值守 bypass 的唯一克制闸」，值得标注。
  - 建议：在 isDangerousCommand 中同时匹配 `(?<![\\w./-])rm(\\s|$)` 词边界 + 常见绝对路径前缀，或基于 shell AST。

- **plugin-manager.ts（PH2-F / cf1f5748）**
  - 路径穿越/任意文件删除：**无风险**。`removePlugin`（plugin-manager.ts:126）仅从内存 Map 删除 + enabledFlag，无任何文件系统操作。删除是逻辑删除而非磁盘删除。
  - P2：`removePlugin` 若未来插件落盘持久化，磁盘残留（部分删除），当前无持久化因此暂不影响；建议实现「删除=逻辑下架」语义对齐未来持久化。
  - P2：`registerPlugin`（plugin-manager.ts:107）仅校验 id/name 存在，未对 `surfaces/subscriptions/permissions/entrypoints` 做 schema 清洗；渲染层若 surfaces 为非数组会 `.map` 抛错（renderer ExtensionSettings.tsx:168）——虽 React 转义防 XSS，但缺结构校验。
  - 低：manifest 通过 IPC IMPORT（ipc.ts:3872）结构化克隆进主进程，`__proto__` 等键在 V8 下不构成原型污染；React 转义覆盖显示字段，无直接 XSS。

- **price-estimator.ts（PH2-① 新增）**
  - 无安全漏洞。`resolvePrice` 前缀 includes 匹配、`estimateCost` 纯数值运算；token/cost 均为本地估算不涉信源。注意：仅用于当 provider cost=0 时兜底估算，不会覆盖真实 cost（token-usage-service.ts normalizeUsage 的判断 `costTotal === 0 && totalTokens > 0` 正确）。

- **token-usage-service.ts（PH2-D）**
  - 无注入/越权。`getCostMiniLedger` 数值聚合，`bySession` 全量积累但仅 slice top50 返回（内存规模可控）；`query({limit:MAX_SAFE_INTEGER})` 对单次全表读取，量大时耗内存，建议流式/带 limit 兜底（P2 性能）。
  - 低：`estimateCost` 兜底会把「本该0费用」的调用计为非零，需确认与官方账单口径差异影响（业务口径问题非安全）。

- **web-bridge-audit-service.ts（PH1-D）**
  - 无安全漏洞。`appendWebBridgeAudit` 用固定目录+appendFile 追加 JSONL；`JSON.stringify(detail)` 转义换行，无 JSONL 注入。`resolveMemberForSessionSafe` try/catch，require 循环依赖安全。
