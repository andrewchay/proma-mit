# Gravitas «Agent 协作 Agentic OS» — 端到端测试清单

> 创建：2026-08-08（第一批+第二批全部实现后）
> 覆盖：PH1-A~D（成员/事件/审计）+ PH2-A~F（协作/RunCenter/费用/ContextHub/插件/Bridge/互调）
> 用法：`bun run dev` 逐项打勾；回归时重点跑 §1/§2 的成员与 RunCenter 链路。

---

## 0. 准备

- [ ] `git log --oneline -5` 确认 HEAD 至 `b22d1ff7`（或最新），工作区干净
- [ ] `bun run dev` 正常启动（Vite + Electron 热重载）
- [ ] 设置 → 渠道：至少一个可用 AI 渠道
- [ ] 设置 → 飞书 Todo / 钉钉 Todo：各连一个 Bot（appId+secret）。⚠ 飞书通讯录**数据权限范围**须含至少根部门，否则同步为空
- [ ] 建 2 个 Agent 工作区：`ws-alpha`、`ws-beta`（跨工作区/协作测试用）

---

## 1. 成员同步与身份（PH1-A/B）

- [ ] 团队 Tab →「同步通讯录」：飞书/钉钉结果卡 `拉取/新增/合并`，无报错
- [ ] 刷新后成员数从 0 变实际人数；「团队/通讯录成员」显示 `真人 X · AI 员工 Y · Bot Z`
- [ ] 负责人选择器（新建任务）：下拉出现「团队成员」（同步的人）+ 可搜飞书/钉钉
- [ ] 新建一个 **AI 员工** → 负责人选择器里以 🤖 出现（统一视图）
- [ ] 指派真人（成员目录）→ 同步到飞书/钉钉 TODO（若配了 Bot）

## 2. 事件/审计/运行中心（PH1-C/D + PH2-B）

- [ ] Run Center（自动化 → 运行记录）：Agent 运行后出现记录，source/状态/执行者徽标正常；按成员过滤生效
- [ ] 导出：存 JSONL 内容含运行记录
- [ ] 操作审计（设置 → 操作审计）：一次 WebBridge/文件写后能看到记录（带执行者）
- [ ] （可选）`~/.gravitas/projects/paa.db`：`members` 表有人、`agent_executions` 有 AI 员工执行

## 3. 团队协作（PH2-A）

- [ ] 团队 Skills 目录（设置→Agent→Skills 底）：跨工作区导入 Skill 后出现「待同步」；改源→同步→「已最新」
- [ ] 文件共享事件流（团队 Tab）：AI 员工写文件 → FileEventPanel 出现成员/动作/路径
- [ ] Todo 事件流（团队 Tab）：建/完成任务 → TodoEventPanel 出现「谁做了什么」
- [ ] Agent 解压缩：新会话让 Agent「解释任务 X 在做什么」→ 调 `InspectTodo` 通俗解释+相关待办
- [ ] 团队 Profile（TeamProfilePanel）：填/保存后 Agent 消息含【团队上下文】

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
|---|---|---|
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
