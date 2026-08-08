# Gravitas「中小公司 Agentic OS」— 交接与进度总览

> 更新：2026-08-08 13:25 GMT+8
> 项目：Gravitas（=/Users/chaihao/LLM/proma-mit，当前工作区 project/ 同源，HEAD `61f244d6`）
> 本文件：跨会话接续入口。请先读此文件 + `plan/gravitas-agentic-os-phased-plan.md`。

---

## 1. 一句话背景

把 Gravitas 从"本地优先 AI 桌面客户端"演进为"中小公司内部团队 + Agent 协作的 Agentic OS"。
方法：以 Buzz（Nostr 团队协作中继）的一心智模型（统一事件 / 人机对等身份 / 统一审计 / workspace 即边界）
为参考，落为本仓库的演进。已在第一批（PH1-A~D）完成，第二批（PH2）进行中。

---

## 2. 当前进度（2026-08-08）

### ✅ 第一批：已完成（必须先完成的地基）

| 阶段 | commit | 内容 |
|---|---|---|
| **PH1-A** | `947f13d` | 飞书/钉钉成员同步 + 双向 mapping：`members` 表（真人员工稳定档案）+ `member-sync-service`（全量拉取、unionId/姓名跨平台对齐、幂等 upsert）+ `user_mappings` 加 feishu_union_id + IPC + 团队 Tab「同步通讯录」UI + ContactPicker 接成员目录 + 定时增量同步(启动+每6h) + TodoProvider 反向查询 |
| **PH1-B** | `ca48c41` `87afad9` | 统一成员视图：`member-directory-service`（真人 members / AI员工 agent_employees / bot 飞书钉钉 聚合）、团队 Tab 统一成员面板、负责人选择器同处选真人/AI员工 |
| **PH1-C** | `141642f` | 统一事件事实源带成员归属：`AppEventEnvelope`/`RunRecord` 补 `memberId?`/`workspaceId?`；`resolveMemberForSession`(sessionId→agent-<id>)；run-store 透传 |
| **PH1-D** | `b65229a` | 审计收口带成员归属：`AgentAuditEvent` 补 memberId?；三个审计服务(web-bridge/computer-use/external-bridge)写入时反查执行者；网络边界确认(server mcpEgress 已防 SSRF) |

### 🔵 第二批：进行中

| 阶段 | 状态 | 内容 |
|---|---|---|
| **PH2-B** | `f9463d6` `de38be4` ✅ 已提交 | Run Center：`RunRecordQuery` 补 memberId?、`run-store.query` 按成员过滤、`RunCenterSettings` 加成员过滤输入框+执行者徽标、**导出**(exportToFile + IPC EXPORT + 保存框 + UI 导出按钮)。调研确认：AI 员工绑定的 Workflow agent 节点走 agent 流，已能通过 resolveMemberForSession 归因 |
| **PH2-A** | `81fce2c` `bd6c1db` `46471ce` `c40e2b2` `1260485` `1616412` ✅ 已提交 | 团队协作共享全部完成：团队 Skills 目录(汇总+一键同步)、文件共享事件流(工具写/编辑→归因成员→JSONL+团队Tab)、Todo 事件流化(订阅onTaskChange→语义流)、Agent 解压缩(InspectTodo 核心工具)、团队级 Profile(每工作区JSON+注入buildDynamicContext+编辑面板) |
| PH2-C | `71b82418` `b747216f` `5c07e49b` `2f0a96d6` `e32ecaf4` ✅ | Proactive & mailbox 完成：Mailbox(聚合需确认+待办)、Proactive 动作可回放(进 Run Center)、自动费用 Audit(工具+面板)、灵动岛无变化跳过 |
| **PH2-B** | `f9463d6` `de38be4` `18a2f94` ✅ | Run Center 完成：按成员过滤+导出（见上）。Run Center = 统一运行事实源界面 |
| **PH2-D** | `737070b7` `2aa98cbc` `ecaead2e` `e321e5bd` ✅ | 数据复利完成：成功输出转资产(ProposeAssetFromRun)、Token成本收敛(getCostMiniLedger)、Context Hub/Work Graph(ExploreContext)、凭据统一治理+审批门收敛 |
| **PH2-E** | `d3b5d9a9` ✅ | 触达面：Bridge 远程入口(/workflow + /proactive 远程触发)；server /agent/ui 已是较完整运维工作台 |
| **PH2-F** | `8baccb55` `61f244d6` ✅ | 长期项完成：Agent 互调协议(agent-invoke+InvokeAgent+Mailbox)、插件/SDK开放(registerPlugin+导入)、多租户精细化(host→tenant) |

> ✅ **第一批(PH1-A~D) + 第二批(PH2-A~F) 全部完成。**

---

## 3. 关键架构决策（记住，避免重复踩坑）

1. **members 表是"真人员工稳定身份真源"**（PH1-A）。`user_mappings` 是兼容层（local→platform ID）。
2. **memberId 编码规则**：真人=`paa-<name>`、AI员工=`agent-<id>`、bot=`bot:<平台>:<id>`。
3. **统一事件总线已存在**：`AppEventBus`(app-event.ts) + `run-store`(JSONL, 订阅 AppEventBus)。PH1-C 是给它加归属，不是重造。
4. **`resolveMemberForSession(sessionId)`**：按 sessionId 反查 `agent_executions` → `agent-<id>`。AI员工会话能归属；真人/普通会话暂无稳定归属（待办：后续按 workspace/当前用户）。
5. **IPC 位置**：项目管理类方法在 `paa.project` 组（不是 `paa` 顶层）！renderer 用 `window.electronAPI.paa.project.*`。
6. **三位审计服务**（web-bridge/computer-use/external-bridge）都写各自 JSONL，`agent-audit-service` 聚合查询。
7. **网络边界**：server `mcpEgress.allowedOrigins`（未配置禁用 MCP）+ Web Bridge 权限门控 → 无需额外 is_private_ip。

---

## 4. 关键文件索引

| 文件 | 职责 |
|---|---|
| `apps/electron/src/main/lib/member-sync-service.ts` | 飞书/钉钉全量拉取 + 跨平台对齐 + 增量同步冷却 + 反查 |
| `apps/electron/src/main/lib/member-directory-service.ts` | 统一成员视图聚合(真人/AI/bot) |
| `apps/electron/src/main/lib/project-sqlite-store.ts` | members 表 + CRUD + user_mappings(含 feishu_union_id) |
| `apps/electron/src/main/lib/app-event-bus.ts` | 统一任务事件总线 + `resolveMemberForSession` |
| `apps/electron/src/main/lib/run-store.ts` | 运行记录 JSONL 存储 + query(含 memberId) |
| `apps/electron/src/main/lib/team-skill-directory-service.ts` | 团队 Skills 目录聚合+一键同步(PH2-A) |
| `apps/electron/src/main/lib/workspace-file-event-service.ts` | 文件共享事件流(JSONL+成员归因)(PH2-A) |
| `apps/electron/src/main/lib/todo-event-service.ts` | Todo 事件流(JSONL 语义流)(PH2-A) |
| `apps/electron/src/main/lib/team-profile-service.ts` | 团队档案(注入 buildDynamicContext)(PH2-A) |
| `apps/electron/src/main/lib/agent-runtime/tool-impls/todo-context-tool.ts` | InspectTodo 解压缩工具(PH2-A) |
| `apps/electron/src/main/lib/team-mailbox-service.ts` | 团队收件箱：聚合需确认+待办(PH2-C) |
| `apps/electron/src/main/lib/cost-audit-service.ts` | 费用审计(PH2-C) |
| `apps/electron/src/main/lib/agent-runtime/tool-impls/cost-audit-tool.ts` | RunCostAudit 工具(PH2-C) |
| `apps/electron/src/main/lib/dynamic-island/dynamic-island-service.ts` | 灵动岛会话状态机(phase+attention+节流) |
| `apps/electron/src/main/lib/asset-proposal-service.ts` | 成功输出→Workflow/Skill 提案(PH2-D) |
| `apps/electron/src/main/lib/context-hub-service.ts` | Context Hub/Work Graph(PH2-D) |
| `apps/electron/src/main/lib/credential-registry-service.ts` | 凭据统一治理(PH2-D) |
| `apps/electron/src/main/lib/agent-invoke-service.ts` | Agent 互调协议(PH2-F) |
| `apps/electron/src/main/lib/plugin-manager.ts` | 插件管理器(registerPlugin/import)(PH2-F) |
| `packages/shared/src/utils/agent-runtime-web-server.ts` | server 多租户(resolveTenantFromHostname)(PH2-F) |
| `apps/electron/src/main/lib/agent-runtime/tool-registry.ts` | 核心工具注册(含 InspectTodo) |
| `apps/electron/src/main/lib/agent-audit-service.ts` + 三个 append*Audit | 审计聚合/写入 |
| `packages/shared/src/types/work-module.ts` | PROJECT_IPC_CHANNELS + Member/MemberResult/MemberSync 类型 |
| `packages/shared/src/types/app-event.ts` / `run-record.ts` / `agent.ts` | AppEventEnvelope/RunRecord/AgentAuditEvent(memberId) |
| `apps/electron/src/renderer/components/projects/AgentTeamPanel.tsx` | 统一成员面板 + 同步通讯录 |
| `apps/electron/src/renderer/components/projects/ProjectView.tsx` | ContactPicker(includeAgents) |
| `apps/electron/src/renderer/components/settings/RunCenterSettings.tsx` | 运行中心(成员过滤) |

---

## 5. 测试

相关测试全绿（36 用例），分布在 `apps/electron/src/main/lib/`：
- `member-store.test.ts`(9) `member-sync-service.test.ts`(7) `member-directory-service.test.ts`(3)
- `app-event-attribution.test.ts`(3) `run-store.test.ts`(6) `audit-member.test.ts`(1)
- `external-bridge-audit-service.test.ts`(2) `contact-search-service.test.ts`(2) `feishu-todo-provider.test.ts`(3)
- 隔离方式：`PROMA_TEST_CONFIG_DIR` 指到临时目录，不污染真实 `~/.gravitas/projects/paa.db`

运行：`cd apps/electron && bun test src/main/lib/<file>.test.ts`
全量相关：`bun test src/main/lib/member-store.test.ts src/main/lib/member-sync-service.test.ts src/main/lib/member-directory-service.test.ts src/main/lib/run-store.test.ts src/main/lib/app-event-attribution.test.ts src/main/lib/audit-member.test.ts src/main/lib/external-bridge-audit-service.test.ts src/main/lib/contact-search-service.test.ts src/main/lib/feishu-todo-provider.test.ts src/main/lib/todo-event-service.test.ts src/main/lib/workspace-file-event-service.test.ts src/main/lib/team-profile-service.test.ts src/main/lib/team-mailbox-service.test.ts src/main/lib/cost-audit-service.test.ts src/main/lib/agent-runtime/tool-impls/todo-context-tool.test.ts src/main/lib/proactive-scheduler.test.ts src/main/lib/dynamic-island/dynamic-island.test.ts`

typecheck：`cd apps/electron && npx tsc --noEmit`；`cd packages/shared && npx tsc --noEmit`

---

## 6. 当前的待办/风险（下次接续先看）

- **PH2-A~F 各项**（见 §2 第二批）。
- **真人员工归因**（PH1-C/D）：Run Center 里真人会话 memberId 为空(null→显示"—")，后续按 workspace/当前用户归属。
- **飞书通讯录可见范围**：真实拉取依赖飞书后台应用数据权限范围（至少根部门），UI 有提示。
- **producer 生态（已确认）**：AI 员工绑定的 Workflow agent 节点走 agent 流，已能通过 resolveMemberForSession 归因（`de38be4` 调研确认）。剩余的是：纯 workflow/automation（无 agent 节点、非 AI员工）的独立 run 事件本身不带 memberId，如需完整覆盖后续在各自 emit 处补。
- **Run Center 导出已完成**（`de38be4`）；断点续做时可达：全量事件可回放（按 member/workspace/time 重建时间线）仍待做。
- **PH2-A~F 全部完成**。注意事项：`InspectTodo`/`RunCostAudit`/`ProposeAssetFromRun`/`ExploreContext`/`InvokeAgent` 等工具已注入所有 Agent 会话，若上下文膨胀可在 tool-registry 按需裁剪；Goal todo 尚未并入 todo-events 流；灵动岛已是完整会话状态机。
- **下游可做**（超出本次）：第三方插件真实 sandbox/签名/分发、server Web UI 进一步产品化、多租户 host 落库校验、跨实例 Agent 互调（当前为单实例内跨成员）。
- 用户工作区有**未提交的无关改动**（LeftSidebar 呼吸灯 completed、globals.css、CLAUDE.md、.context/todo.md、fix-collaboration-analysis.md、report-gacha-games-2025.md）—— 与本次主线无关，勿误提交。

---

## 7. 相关借鉴文档索引

| 文档 | 主题 |
|---|---|
| `plan/gravitas-agentic-os-phased-plan.md` | 分批施工总计划（本交接的权威来源） |
| `notes/buzz-gravitas-borrowing.md` | Buzz 心智映射（聚焦 5 高杠杆） |
| `notes/buzz-gravitas-full-leverage.md` | 34 动作全库 |
| `notes/agentic-os-e2e-checklist.md` | 端到端测试清单（回归用） |
| `plan/ph1a-member-sync-implementation.md` | PH1-A 实施详录（步骤1-7） |
| `notes/habi-proma-borrowing.md` | 生态 / 统一能力契约 / 五层分层 |
| `notes/proma-agent-island.md` | 官方灵动岛=会话状态机 |

---

## 8. 上手建议

1. 先读 `plan/gravitas-agentic-os-phased-plan.md` 定位当前阶段。
2. 动手改动前先 `npx tsc --noEmit`（electron+shared）+ 跑相关测试，确保绿。
3. 涉及成员/事件/审计归属的改动，用 §3 决策 + §4 索引对齐，勿另起一套。
4. `bun run dev` 实测：团队 Tab 同步通讯录 → 负责人选择器 → Run Center 看成员归属。
