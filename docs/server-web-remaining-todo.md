# 服务端 Web 剩余 TODO

更新时间：2026-07-22

本文档只记录尚未形成可验收闭环的工作。已完成的基础包括：Bun 服务、Postgres/Redis/S3、AI SDK session/run/SSE、OIDC JWT、工作区读写审批、基础 Web 工作台、metrics/audit/recovery，以及 DeepSeek 服务端真实 E2E。

## 暂缓：P8 外部企业端点真实验收

状态：**短期暂不执行**。代码已提供 AWS KMS、SIEM webhook 与告警 webhook 的配置入口、脱敏和本地测试；但真实联通依赖企业外部系统，不应使用占位凭证伪造验收。

恢复时需要提供并验证：

- AWS：`PROMA_WEB_AWS_KMS_KEY_ID`、`PROMA_WEB_AWS_REGION`，以及运行身份的 `kms:GenerateDataKey` / `kms:Decrypt` 权限；可选私有端点 `PROMA_WEB_AWS_KMS_ENDPOINT`。
- SIEM：`PROMA_WEB_SIEM_WEBHOOK_URL`，验证 trace/audit 事件、脱敏 payload、失败重试与接收端签名要求。
- 告警：`PROMA_WEB_ALERT_WEBHOOK_URL`，验证 agent task 失败、预算、stale task 和 OAuth/MCP 故障的路由策略。

恢复验收：在生产等价 Docker 环境中，以真实 IAM 身份完成一次 KMS 信封加解密和轮换读取；触发一条失败任务并确认告警与 SIEM 分别收到带 `traceId` 的脱敏事件。

## P6：完整浏览器 UI 与管理 API

### P6-1 会话与运行工作台

- [ ] 将当前 `/agent/ui` 的静态工作台拆分为可维护的浏览器应用模块。
- [ ] 会话列表支持搜索、分页、标题编辑、归档与删除。
- [ ] 新建会话支持 workspace、channel、model、runtime、permission mode 选择。
- [ ] SSE 使用 `EventSource` 持续订阅，支持自动重连、`Last-Event-ID` 与 terminal 状态收口。
- [ ] 消息区域渲染文本、thinking、tool start/result、usage、typed error 和 task progress。
- [ ] task 列表支持取消、失败详情、耗时、token/cost 与 workspace artifact 跳转。

验收：刷新页面后可恢复会话、重新订阅同一任务的事件；断线后不会重复或遗漏事件。

### P6-2 结构化交互与 MCP OAuth

- [ ] Permission 详情弹窗：展示工具输入、风险等级、批准一次/拒绝/会话白名单。
- [ ] AskUser 表单：按 questions/options/multiSelect 渲染并提交 answers，不能使用当前的简化 prompt。
- [ ] Plan 审批页：展示完整计划、反馈、批准自动执行、批准后编辑、拒绝。
- [ ] MCP OAuth 状态页：按 workspace/server 展示 pending、authorized、expired、reauthorize。
- [ ] file/artifact 浏览、上传、下载与工作区同步状态。

验收：所有 pending interaction 都能在浏览器端完整处理；OAuth 回调完成后状态实时更新。

### P6-3 管理与导出 UI

- [ ] Metrics 视图：时间范围、running/terminal task、token/cost、provider latency、MCP error。
- [ ] Audit 视图：按时间、actor、action、session、task、provider、结果筛选。
- [ ] 审计与账单 CSV/JSON 导出入口，异步导出任务与下载链接。
- [ ] Recovery 视图：stale task 详情、runbook、受控处置操作。

验收：普通用户只看到自身 scope；管理员只能通过 RBAC 查看授权范围。

## P7：MCP / Plan / AskUser / Sub Agent 隔离编排

### P7-1 交互状态机

- [ ] 将 AskUser、Plan、Permission 统一为带版本、超时、幂等 response 的交互状态机。
- [ ] response API 校验 interaction kind 和 payload schema，拒绝错误响应类型。
- [ ] task shutdown/cancel 时自动取消未决 interaction 并发出 terminal event。
- [ ] session 级白名单与 permission decision 持久化、过期和审计。

验收：多 worker 下同一 interaction 只能 resolve 一次；重启后 task 能恢复等待或进入明确失败状态。

### P7-2 服务端 MCP

- [ ] 接入 server-side MCP manager，按 tenant/workspace/server 建立受控连接池。
- [ ] 将 MCP tool/resource 适配为 AI SDK ToolSet，并做名称、schema、输出大小校验。
- [ ] OAuth token/client secret 使用 envelope/KMS codec，完成 refresh、失效和重新授权。
- [ ] MCP 连接、调用、权限决定、错误与 latency 写入 audit/trace/metrics。
- [ ] 禁止跨进程共享 stdio MCP；HTTP MCP 配置 allowlist、超时、并发与 egress policy。

验收：两个 worker、两个 tenant 不能共享 token/连接/事件；MCP tool 调用可在 UI 与 audit 中追踪。

### P7-3 Plan 与隔离执行器

- [ ] Plan mode 维护服务端状态，不只依赖模型工具文本。
- [ ] 计划阶段只注册只读工具；批准后才发放写入/Shell/MCP 高风险能力。
- [ ] 实现隔离执行器接口：workspace mount、CPU/内存/时限、网络 egress、进程树终止、只读根文件系统。
- [ ] 首个实现采用容器或 sandbox worker；不得在 API 进程直接执行任意 Shell。
- [ ] artifact、stdout/stderr、退出码和资源使用量持久化。

验收：恶意 shell 不能读取宿主机或越出 workspace；超时/取消会终止整个进程树。

### P7-4 Sub Agent

- [ ] 为 Sub Agent 建立 parent task / child task 数据模型、队列和并发额度。
- [ ] 子任务使用独立 workspace snapshot、权限范围、token/cost budget 和 cancellation token。
- [ ] 聚合 child event/usage/result 到 parent，并支持 UI 展开与取消。
- [ ] 递归深度、最大 child 数、重试、死信和清理策略。

验收：子任务不能取得 parent 未授权的 secret、文件或工具；父任务取消会级联取消子任务。

## P8：管理员与企业运维

### P8-1 RBAC 与审计合规

- [ ] OIDC claims 到 tenant role / permission 的映射。
- [ ] `viewer`、`operator`、`admin`、`security-auditor` 最小权限模型。
- [ ] append-only audit hash chain 或 WORM 后端；写入 secret access、tool decision、管理员操作。
- [ ] retention policy、legal hold、清理任务和导出审计。

### P8-2 可观测、告警、SIEM

- [ ] OpenTelemetry traces：HTTP -> task -> provider -> tool/MCP/child task。
- [ ] Prometheus/OpenMetrics：latency、error、queue、lease、interaction、MCP、cost 指标。
- [ ] 可配置阈值告警：预算、失败率、stale task、OAuth refresh、异常权限请求。
- [ ] SIEM webhook/event export：签名、重试、退避、死信、payload 脱敏。

### P8-3 KMS 与密钥轮换

- [ ] `KeyEncryptionKeyProvider` 接口与 AWS KMS/GCP KMS/Azure Key Vault 实现。
- [ ] 数据密钥 version、re-encrypt migration、grace period、撤销与审计。
- [ ] 禁止在日志、trace、export、dead letter 中出现 provider key、OAuth refresh token、client secret。

验收：key rotation 后旧密文可在过渡期解密，新写入使用新版本；密钥访问可审计但不泄露明文。

## 推荐顺序

1. P6-1 / P6-2：先闭合浏览器端 session、SSE、交互。
2. P7-1 / P7-3：先完成状态机与隔离执行，再开放高风险工具。
3. P7-2 / P7-4：在隔离边界内接 MCP 与 Sub Agent。
4. P6-3：利用稳定的 task/audit/metrics 数据完成运营界面与导出。
5. P8：RBAC、trace、SIEM、KMS 和 retention 作为生产上线门槛。
