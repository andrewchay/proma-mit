# Gravitas «Agent 协作 Agentic OS» — 端到端测试清单

> 创建：2026-08-08（第一批+第二批全部实现后） 覆盖：PH1-A\~D（成员/事件/审计）+ PH2-A\~F（协作/RunCenter/费用/ContextHub/插件/Bridge/互调） 用法：`bun run dev` 逐项打勾；回归时重点跑 §1/§2 的成员与 RunCenter 链路。

---

## 0. 准备

- [x] `git log --oneline -5` 确认 HEAD 至 `b22d1ff7`（或最新），工作区干净

- [x] `bun run dev` 正常启动（Vite + Electron 热重载）

- [x] 设置 → 渠道：至少一个可用 AI 渠道

- [x] 设置 → 飞书 Todo / 钉钉 Todo：各连一个 Bot（appId+secret）。⚠ 飞书通讯录**数据权限范围**须含至少根部门，否则同步为空

- [x] 建 2 个 Agent 工作区：`ws-alpha`、`ws-beta`（跨工作区/协作测试用）

---

## 1. 成员同步与身份（PH1-A/B）

- [x] 团队 Tab →「同步通讯录」：飞书/钉钉结果卡 `拉取/新增/合并`，无报错

- [x] 刷新后成员数从 0 变实际人数；「团队/通讯录成员」显示 `真人 X · AI 员工 Y · Bot Z`

- [x] 负责人选择器（新建任务）：下拉出现「团队成员」（同步的人）+ 可搜飞书/钉钉

- [x] 新建一个 **AI 员工** → 负责人选择器里以 🤖 出现（统一视图）

- [x] 指派真人（成员目录）→ 同步到飞书/钉钉 TODO（若配了 Bot）

## 2. 事件/审计/运行中心（PH1-C/D + PH2-B）

- [x] Run Center（自动化 → 运行记录）：Agent 运行后出现记录，source/状态/执行者徽标正常；按成员过滤生效

- [x] 导出：存 JSONL 内容含运行记录

- [x] 操作审计（设置 → 操作审计）：一次 WebBridge/文件写后能看到记录（带执行者）

- [x] （可选）`~/.gravitas/projects/paa.db`：`members` 表有人、`agent_executions` 有 AI 员工执行

## 3. 团队协作（PH2-A）

- [x] 团队 Skills 目录（设置→Agent→Skills 底）：跨工作区导入 Skill 后出现「待同步」；改源→同步→「已最新」

- [x] 文件共享事件流（团队 Tab）：AI 员工写文件 → FileEventPanel 出现成员/动作/路径

- [x] Todo 事件流（团队 Tab）：建/完成任务 → TodoEventPanel 出现「谁做了什么」

- [ ] Agent 解压缩：新会话让 Agent「解释任务 X 在做什么」→ 调 `InspectTodo` 通俗解释+相关待办

- [x] 团队 Profile（TeamProfilePanel）：填/保存后 Agent 消息含【团队上下文】

## 4. Proactive & 费用（PH2-C + PH2-D 记账）

- [ ] Mailbox（团队 Tab 收件箱）：Agent 触发权限/提问 → 出现条目；处理后消失；指派待办也进 Mailbox

- [ ] 费用审计（自动化 → CostAuditPanel）：运行审计显示总费用/Token/环比/Top；无异常绿标

- [ ] Token 统计与 CostAuditPanel 金额一致（同一 getCostMiniLedger 口径）

## 5. Context Hub（PH2-D）

- [ ] 新会话让 Agent「查 xxx/某个会话还关联什么」→ 调 `ExploreContext` 返回运行/文件/Todo 关联

## 6. 插件开放（PH2-F）

- [ ] 设置 → 扩展 → 导入插件：粘最小 manifest `{id,name,version,surfaces:[],permissions:{events:false},entrypoints:{}}` → 成功；可启停；重复导入被拒

## 7. Bridge 远程入口（PH2-E）

- [ ] 飞书/钉钉群：`/workflow`（列出）→ `/workflow run <名>` 触发

- [ ] `/proactive`（列出）→ `/proactive run <名>` 手动触发

- [ ] `/help` 见新命令；`/now` 看状态

## 8. Agent 互调（PH2-F）

- [ ] 新会话让 Agent「用 InvokeAgent 给 AI 员工 xx 发任务：审 PR」→ 发送成功

- [ ] Mailbox 出现「互调」条目（来自→给 + 任务）

---

## 常见问题速查

| 现象 | 可能原因 | 检查 |
| --- | --- | --- |
| 飞书同步 0 人/权限错 | 通讯录数据权限范围未覆盖部门 | 飞书开放平台勾选+重发布 |
| Run Center 无记录 | 没跑过 Agent / run-store 未启动 | 设置→自动化→运行记录 |
| Cost Audit 显故障 | token-usage 无数据 | 先跑几次 Agent |
| Agent 不调新工具 | tool 被裁剪 / prompt 未含 | tool-registry `CORE_TOOL_NAMES` |
| 插件导入失败 | manifest 缺 id/name 或冲突 | 看错误提示 |

---

## 回归重点（改动后优先跑）

1. §1 成员同步 + 负责人选择器（PH1 地基，牵一发动全身）
2. §2 Run Center 成员过滤 + 导出（事件事实源）
3. §4 费用审计与 Token 统计金额一致（记账收敛）
4. 自动化单测：`cd apps/electron && bun test src/main/lib/member-store.test.ts src/main/lib/run-store.test.ts src/main/lib/context-hub-service.test.ts src/main/lib/agent-invoke-service.test.ts src/main/lib/agent-runtime/tool-impls/tool-impls.test.ts`

---

## 诊断模式（大迭代排查用）

关键链路已埋 `[Diag]` 前缀日志，`bun run dev` 的终端/Console 里 `grep '[Diag]'` 即可筛出：

| 前缀 | 模块 | 会看到什么 |
| --- | --- | --- |
| `[Diag][member-sync]` | 成员同步 | 同步开始/结束、拉取/新增/合并/失败数、失败原因 |
| `[Diag][mailbox]` | 收件箱 | 聚合条目数 |
| `[Diag][run-store]` | 运行记录 | 写入失败原因 |
| `[Diag][cost-audit]` | 费用审计 | 窗口 + 当前/上一记录条数 |
| `[Diag][context-hub]` | Work Graph | 查询实体 + 相关条数 |
| `[Diag][agent-invoke]` | Agent 互调 | send/respond 记录 |
| `[Diag][plugin]` | 插件 | 注册拒绝原因 |

遇到问题时：把 `[Diag]` 相关的终端输出（或截图）发我，我据此反推根因。

---

## 实测问题与修复记录（持续维护）

> 每轮 e2e 实测发现的 bug 与修复情况，便于回归。状态：✅=已修复 ☐=待办

### 第一轮（§0-2，2026-08-08）—— 已修复

- ✅ AI 员工表单「模型」无下拉 → 改 datalist（从渠道拉取+可手输）
- ✅ task 无法同步/删除 + outbox 孤儿重试"任务不存在" → deleteTask 级联清 outbox/executions + 孤儿自动丢弃 + UI「关闭」按钮
- ✅ 编辑任务两个「开始日期」→ 移除重复字段（误放执行 subTask）；截止改后同步到飞书（updateTodoDue）

### 第二轮（2026-08-08）—— 已修复

- ✅ 飞书同步 `getTenantAccessToken undefined` → updateTodoDue 解构丢 this，改为 provider.updateTodoDue(...)（e5cfd4d2）
- ✅ 飞书二次报错 `Unexpected non-whitespace character after JSON` → feishuApi 读原文稳控 JSON.parse（cb2c0983）
- ✅ Agent 解释成员读不到上下文 → ExploreContext 支持按成员展示名解析（e5cfd4d2）
- ✅ 团队档案协作偏好无引导 → 加示例文案
- ✅ “I 指派的”视图 → tasks.created_by_user_id + MyWorkPanel toggle（cb2c0983）

### 第三轮（2026-08-08 15:58）—— 部分修复

- ✅ **费用审计 总 token 9m 但费用 0**：根因 Provider SDK 不返回 cost → 新增 price-estimator（本地价格目录估算）落在 token-usage（5157d366）
- ✅ **导入插件无反应**：根因 Electron window.prompt 不工作 → 改内联 JSON textarea + 导入按钮（5157d366）
- ☐ **Mailbox 无消息**：疑似无数据（未触发 pending 审批/无已指派未完成任务）。已加各来源细分日志，`[Diag][mailbox]` 可定位。待用户核对
- ☐ **AI 员工权限审批不弹窗 + 点击处理无反应**：headless 无人值守安全模式（不弹运行时审批，by design）；Mailbox 处理按钮需路由到审批 UI —— 待做 HITL 交互增强