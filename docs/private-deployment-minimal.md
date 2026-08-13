# Gravitas Server 私有部署最小集 v0.1

> 创建：2026-08-13
> 定位：三轨策略中"短期 = server 私有部署"轨道的范围定义文档。
> 上游：`docs/server-web-remaining-todo.md`（P6–P8 全量清单）、`docs/plans/2026-08-13-agentic-architecture-seeds.md`（架构种子落地）。
> 目标读者：实施下一个 Sprint 的 Agent 与「一键部署」验收者。

---

## 1. 结论：最小集是什么

**一句话**：让一台小企业/单团队服务器能一键起全套、管理员/成员能通过浏览器登录并使用 Agent 工作台、Agent 执行被隔离且不可越权、关键操作可审计可追溯——**在守住安全底线的同时砍掉一切依赖外部企业系统或尚不成熟的组件**。

**三轨对齐**（本轨=第二轨道）：
| 轨道 | 范围 | 本轨任务 |
|---|---|---|
| 开源桌面（不变） | 本地优先 | 无（不做） |
| **本轨：私有部署最小集** | 小企业/单租户 | 收敛 P6-P8，能跑通、能守底线 |
| SaaS 商业化（长期） | 多租户 + 计费 + 全量合规 | 本轨缺口之外 + 多租户计费/全套审计/RBAC 到 Card |

**关键取舍**：本轨**不实现**任何依赖外部企业服务或需要高可用集群的能力，但**从现在起按租户埋好种子**（`tenant_id` scope 已贯穿），SaaS 化不返工。

---

## 2. 现状盘点（2026-08-13，基于代码核实，覆盖 7-22 那份清单）

### ✅ 已具备（最小集无需新增）
| 能力 | P# 对应 | 证据 |
|---|---|---|
| AI SDK session/run/SSE | 基础 | `runtime.ts` + `createAgentRuntimeWebServer` |
| Postgres/Redis/S3 多租户 store | 基础 | `PostgresTenantRuntimeStore`、`RedisAgentRuntimeEventStore` |
| OIDC JWT **API 层**认证 | P8-1 前 | `jwt-auth.ts:createOidcJwtAuth`（校验 RS256 Bearer JWT） |
| RBAC 最小权限模型 | P8-1 | `hasAnyRole` + `viewer/operator/admin/security-auditor`，`AgentRuntimeRole` |
| 交互状态机（Permission/AskUser/Plan） | P7-1 | `PostgresAgentRuntimeInteractionStore` |
| 隔离执行器接口 + Docker executor 服务 | P7-3 | `isolated-executor.ts`（Disabled/Http）+ 生产 compose `executor` 服务 |
| 服务端 MCP 池 + OAuth | P7-2 | `ServerMcpConnectionManager` + `acquireServerMcpTools` + `server-mcp-oauth` |
| Sub Agent 数据模型 | P7-4 前 | `proma_runtime_tasks.parent_task_id` + runtime `DelegateSubAgent` |
| 审计 hash chain（篡改检测） | P8-1 | `audit.ts:verifyChain`（S4，按 tenant 分链） |
| KMS 版本化（底层） | P8-3 | rotating codec + reencrypt + 云KMS接线（S2 确认已存在） |
| 贵慢重准看板 | P6-3 前 | `GET /agent/health`（S4） |
| Agent Registry + 租户隔离 | 新 | `GET/PUT /agent/registry`（S2） |
| 预算硬限制 | P8-2 前 | `billing.ts:assertTaskWithinBudget` + `monthlyCostMicroUsd` |
| 遥测/Metrics/Recovery | P6-3 | `metrics.ts` / `recovery.ts` |
| 生产 docker-compose（多服务） | — | `docker-compose.production.yml`（postgres/redis/minio/server/executor/web） |

### ⚠️ 部分具备（最小集需补齐到可验收）
| 能力 | P# | 现状缺口 |
|---|---|---|
| **浏览器登录流程** | P8-1 | 只有 Trusted Header（本地）与 OIDC JWT **API** resolver；**无 OIDC Authorization Code 登录页/回调**，运维只能手动填 Bearer token |
| Web 工作台完整性 | P6-1/2/3 | `dashboard.ts` 是 45 行内嵌单 HTML（会话/交互/任务 + 部分视图），**未接入** health(_/agent/health_)、registry(_/agent/registry_) 新视图；无搜索/分页/取消/artifact |

### ❌ 本次最小集明确不做（留待 SaaS 商业化 / 需外部依赖）
- P8-2 全套：OpenTelemetry trace、Prometheus、SIEM webhook、告警 webhook（需外部系统，P8 暂缓区已指明）
- P8-3 生产级云 KMS 轮换验收（需真实 IAM + 企业外部）
- P7-4 完整 Sub Agent 隔离编排（队列/并发/级联取消/预算隔离）——**最小集只到"数据模型"，不做多 worker 隔离执行**
- 多租户计费、租户自助开通
- P6-2 完整文件上传/artifact 浏览

---

## 3. 最小集的验收闭环（定义：什么叫"能跑起来、守住底线"）

一条端到端路径，全部必须走通才算最小集闭环：

```
1. 一键部署：docker compose up 拉起 postgres/redis/minio/server/executor/web，全部 healthy
2. 浏览器登录：管理员→OIDC 授权码登录（或私有部署 fallback：创建管理员+本地登录）
3. 建工作区 → 配渠道 → 创建 Agent 会话
4. 运行一个 Agent 任务，流式响应回 UI
5. 触发一次高风险工具（写文件/Shell）→ 经隔离执行器（executor），不落到 API 进程
6. 触发一次需人工审批的交互（Permission/AskUser/Plan）→ 浏览器端完整处理
7. 关键操作写审计（含 hash chain）→ 篡改可被 verifyChain 检出
8. 看 `GET /agent/health` 贵慢重准；`GET /agent/registry` 看到已注册 Agent
9. operator 权限的普通成员看不到 admin scope（RBAC 生效）
```

**安全底线（不可妥协）**：API 进程不得直接执行任意 Shell（必须走隔离执行器）；未登录无法访问任何 `/agent/*`；agent 越不出 workspace；审计追加且可校验。

---

## 4. 要补的最小缺口（本次范围）

按依赖排序，全部 TDD + 真实部署验证：

### M1 浏览器登录闭环（最高优先）
- 目标：私有部署下运维/成员能浏览器登录，而非手动填 token。
- 方案：为私有部署提供两条路径——① OIDC Authorization Code 登录页 + `/auth/login` + `/auth/callback` + 会话 cookie（对应 `createOidcJwtAuth`）；② 无第三方 IdP 的 **fallback 本地用户名/密码**（scrypt/bcrypt 哈希 + JWT session），满足"单团队无企业 IdP"。
- 产出：`auth-login.ts` + `auth-local.ts` + 登录 UI + 会话中间件（HTTP-only cookie）。
- 验收：未登录访问 `/agent/*` 302/401；登录后可访问；RBAC 角色从登录身份解析。

### M2 Web 工作台补全 health/registry + 会话管理
- 目标：让新能力在 UI 可见，满足 P6-1 基础。
- 方案：`dashboard.ts` 拆分/扩展，新增「健康度」(_/agent/health_)与「Agent 注册」(_/agent/registry_) tab；会话列表支持**取消**、**标题编辑**、刷新后恢复订阅（复用现有 SSE `Last-Event-ID`）。
- 产出：dashboard.ts 增强（保持无构建依赖、单 HTML，避免引入前端工具链）。
- 验收：health/registry 在浏览器可视；会话可取消；刷新不丢事件。

### M3 一键部署可用 + 冒烟脚本
- 目标：`docker compose -f docker-compose.production.yml up -d` 一条命令起全套并自动健康检查。
- 方案：补 `.env.example` 完整模板（含本地 fallback 认证所需的 `PROMA_WEB_ADMIN_*`）、健康检查覆盖、一个 `scripts/smoke-private-deploy.sh`（起服务→登录→建会话→跑任务→查 health→可退出）。
- 产出：部署快照脚本 + README「私有部署」章节。
- 验收：全新机器.clone → 配置 .env → up → smoke 脚本全绿。

### M4（可选，若时间允许）Sub Agent server 端串联
- 目标：task 聚合 child 事件到 parent，UI 可展开（复用 `parent_task_id`，不做多 worker 隔离）。
- 接受标准：本项可留待 SaaS，最小集不强依赖。

---

## 5. 不做（明确排除）与理由

| 排除项 | 理由 |
|---|---|
| OpenTelemetry/Prometheus/SIEM/告警 webhook | 需外部系统，P8 暂缓；本轨用 `GET /agent/health` 足够 |
| 多租户计费/自助开通 | SaaS 轨道；本轨单租户，`tenant_id` 已埋种子 |
| 生产级云 KMS 轮换验收 | 需真实 IAM；本轨用 envelope + 本地密钥 + `version` 字段 |
| 完整 Sub Agent 多 worker 隔离 | 需独立调度基础设施；本轨只保证数据模型与单实例聚合 |
| P6-2 完整 file 上传/artifact 浏览 | 非安全底线，单租户可后续补 |
| 商业化 Web UI 前端工程化 | 维持单 HTML（无构建）降低部署复杂度；SaaS 轨道再引入前端工具链 |

---

## 6. 与既有工作/文档的关系

- **依赖**：本最小集建立在 4 个架构种子（身份/契约/KMS/安全治理）之上，均已落地（见 `docs/plans/2026-08-13-agentic-architecture-seeds.md`）。
- **演进**：M1~M3 完成后即达本轨闭环；再往上走 = SaaS 商业化轨道（补 P8 全套 + 多租户计费）。
- **本文档定位**：是"范围定义"，不是"实施计划"；落地时对 M1..M4 各拆一份 TDD 分步计划（沿用 `docs/plans/` 惯例）。
