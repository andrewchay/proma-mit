# Server / web 服务化：价值判断、差距与落地（更新版）

> 日期：2026-08-10（更新；替代初版"双端同构"路线）
> 定位（用户定）：**server 是独立产品线**，与 gravitas 桌面关系弱。
> 结论：**不值得做"gravitas 桌面服务化/双端同构"；值得做 A(补 server 自身闭环) + 轻量 B(协议统合)。**

---

## 〇、价值判断（为什么否决"双端同构"）

- **规模不成比例**：electron main ~6.7 万行 vs server src ~4.2 千行（约 16 倍）。全量服务化桌面能力是透支。
- **用户不同**：server 已证明对独立 web 产品线有用；"桌面能力搬上网"与 Gravitas"本地优先"定位存在张力。
- **已定定位**：server 是独立产品线 → 双端同构（把 electron 搬过去）是错误投入。**M1-M3 搁置。**

## 一、实质校准（相对初版的修正）

初版基于 README 推断"server 缺完整 Web UI 和真实 provider E2E"。**核实发现代码实际上已落地大半：**

- **`/agent/ui` Web 工作台已存在**（`dashboard.ts` 单文件无构建依赖 HTML+JS，`app.ts` 服务）：
  - 会话创建/列表/选择；运行 `/agent/sessions/:id/run` + SSE `/events` 流式
  - 交互收件箱：plan 审批(批准/拒绝/附反馈/要求调整) + ask_user 应答
  - 审计 / 指标 / 恢复诊断 / 运行档案(span 树可视化) / Signals / 评估数据集
- **真实 provider E2E 已有**（`real-e2e.test.ts`）：anthropic/google/openai/deepseek/kimi/zhipu/doubao/qwen 矩阵；需 `PROMA_WEB_REAL_E2E=1` + 真实 API key 才跑（`describe.skipIf(!canRun)`）。
- README 那句"完整 Web UI / 真实 provider E2E 仍待后续"是**过时描述**。

**所以 A 档的真实工作不是"从零补齐"，而是"完善 + 补验证 + 补 README"。**

## 二、A 档（server 独立产品线闭环）——实际差距清单

| 项 | 现状 | 待做 | 优先级 |
|---|---|---|---|
| Web 工作台 `/agent/ui` | 已有单文件版 | 体验完善（鉴权引导 UI、错误提示、移动端）；仍是"无构建依赖单文件"，非完整 SPA | 中 |
| 真实 provider E2E | 已有矩阵但 skipIf | 建议纳入 CI 的可跑通道（注入 API key）或至少文档化运行方式 | 高 |
| **生产鉴权（OIDC/JWT）** | README 称生产 ready，但 `jwt-auth.ts`/`auth-startup-policy.ts` 有 `TRUSTED_HEADER_AUTH` 本地旁路 | **核实生产路径下 JWT RS256 + tenant/user claim 映射真实可跑**（README 自述仍需"生产 OIDC/JWT、KMS 轮换、管理员审计"） | 高 |
| KMS 轮换 / 管理员审计 | `aws-kms.ts` 存在 envelope 封装 | 核实密钥轮换流程、管理员审计端点 | 中 |
| 文档一致性 | README Web 路线仍写"待后续" | 更新为当前真实状态 | 低 |
| 部署脚手架 | `docker-compose.production.yml` + Dockerfile 已备 | 端到端 docker 部署冒烟（S3/MinIO、envelope、executor 联动） | 高 |

## 三、B 档（轻量协议统合，低成本高杠杆）

协议/类型/SSE 信封两端本已共用（electron `ai-sdk-agent-adapter.ts` 直接 import `@gravitas/shared` 的 `ProviderType`/`AgentProviderProtocol`/`serializeAgentStreamEnvelopeForSSE`）。无需重建。
- 建议只做：**把高复用的粒件抽到 shared**（如 interaction/span/audit 契约改动时双端同步），不搬功能。
- 原则：**共享的是"契约"，不共享"实现"**（electron 桌面实现不并入 server）。

## 四、遗留：已被否决的"双端同构"结论（存档）

- 两套运行时确实存在（shared `agent-runtime-*` service 与 electron 自研 orchestrator），但**现状是健康的独立并行**，不是欠账。
- 除非未来战略转向纯 web SaaS 放弃桌面，才需要重启 M1-M3（electron 迁移到共享 tenant-store/task-runner）。

## 五、关键文件索引

- server 应用：`apps/server/src/app.ts`、`index.ts`；Web UI `dashboard.ts`；真实 E2E `real-e2e.test.ts`；web E2E `web-e2e.test.ts`
- 生产编排：`docker-compose.production.yml`（postgres/redis/minio/server/executor）、`apps/server/Dockerfile`
- 鉴权：`jwt-auth.ts`、`auth-startup-policy.ts`；密钥 `aws-kms.ts`
- 共享运行时：`packages/shared/src/utils/agent-runtime-server.ts`、`agent-runtime-tenant-store.ts`、`agent-runtime-web-server.ts`
- electron（不并入）：`apps/electron/src/main/lib/agent-orchestrator.ts`、`project-sqlite-store.ts`
