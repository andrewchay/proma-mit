# Agent Runtime Provider Matrix

本文档记录 Proma 当前 Agent runtime 的 provider 支持状态、真实 API smoke 结果和后续服务端 Web 化优先级。

更新时间：2026-07-22

## 结论

- Proma runtime 仍是当前能力最完整的 provider-agnostic Agent runtime。
- AI SDK runtime 已具备服务端 Web 化的最佳基础，优先投入产品化；P0–P5 已完成独立 Bun server、Postgres 多租户 store、WebCrypto secret codec、Redis Stream replay、S3-compatible workspace 文件、跨 worker task lease、本地双实例 E2E、用量与成本账本、预算/限速、追加式审计、运行指标和僵尸任务诊断。OIDC/JWT、云 KMS 轮换、管理员审计、完整 Web UI 与真实 provider E2E 仍在后续阶段。
- Pi runtime 已完成独立 SDK runtime 接入和多 provider 真实 smoke，但短期定位为验证/对照 runtime。
- Claude runtime 继续作为 Claude Agent SDK 原生路径，保留其 resume、权限与历史能力。

## Runtime 定位

| Runtime | 当前定位 | 主要优势 | 主要限制 |
| --- | --- | --- | --- |
| `claude` | Claude Agent SDK 原生 runtime | SDK 原生会话、权限、resume/fork 语义成熟 | 绑定 Claude SDK 协议与能力模型 |
| `proma` | Proma provider-agnostic runtime | MCP、Plan、AskUser、Sub Agent、权限、工具循环最完整 | 需要逐 provider 维护协议兼容性 |
| `ai-sdk` | 服务端 Web 优先 runtime | Provider 包生态好，runtime core 和服务边界已初步抽离 | 细粒度 UI 流式仍需继续打磨，fork/rewind 是 history replay，不是 SDK 原生快照 |
| `pi` | Pi SDK 验证 runtime | SDK 对照组，已可跑多 provider | 工具体系保守，MCP/AskUser/Sub Agent/权限桥接不如 Proma runtime |

## 真实 API Smoke

真实测试默认不请求外网，只在显式开启环境变量时运行：

- AI SDK：`PROMA_AI_SDK_REAL_API=1`
- Pi：`PROMA_PI_REAL_API=1`

当前已手动验证通过的 provider：

| Provider | AI SDK Runtime | Pi Runtime | 默认模型 | 备注 |
| --- | --- | --- | --- | --- |
| DeepSeek | 通过 | 通过 | `deepseek-chat` / Pi: `deepseek-v4-pro` | AI SDK 走 OpenAI-compatible；Pi 使用 Pi 内置兼容配置 |
| Google | 通过 | 通过 | `gemini-3.5-flash` | AI SDK 自动补 `/v1beta`；Pi 不使用 Bearer authHeader |
| Kimi Coding Plan | 通过 | 通过 | `kimi-for-coding` | AI SDK 保留 `/coding/v1`；Pi 使用 `/coding`、`User-Agent: KimiCLI/1.5` |
| Zhipu | 通过 | 通过 | `glm-4-flash` | OpenAI-compatible |
| Qwen | 通过 | 通过 | `qwen-turbo` | Pi 限制 `max_tokens=16384`，避免 DashScope 参数错误 |

尚未在本轮真实 smoke 中确认：

| Provider | Runtime | 当前状态 |
| --- | --- | --- |
| OpenAI | AI SDK / Pi / Proma | 支持路径已接入，用户暂不优先验证 |
| Doubao | AI SDK / Pi / Proma | 支持路径已接入，用户暂不优先验证 |
| Anthropic | AI SDK / Pi / Claude | 支持路径已接入，本轮未做真实 smoke |
| MiniMax | Pi / Claude | Pi matrix 覆盖，真实 API 未验证 |
| Kimi API | AI SDK / Pi / Proma / Claude | 与 Kimi Coding Plan 分开处理，本轮未做真实 smoke |
| Custom | AI SDK / Pi / Proma | 依赖用户自定义端点，不能声明通用真实通过 |

## Provider 注意事项

### Kimi Coding Plan

Kimi Coding Plan 不能按普通 Kimi API 处理。

- AI SDK / Proma runtime 使用 OpenAI-compatible 路径时，baseURL 应保留 `https://api.kimi.com/coding/v1`。
- Pi runtime 使用 `anthropic-messages` API 时，baseURL 应归一为 `https://api.kimi.com/coding`，由 Pi SDK 自己拼接版本路径。
- Pi runtime 需要 `User-Agent: KimiCLI/1.5`。
- 默认模型为 `kimi-for-coding`。

### Google

- AI SDK runtime 使用 Google provider package。
- Google baseURL 需要 `/v1beta`。
- Pi runtime 下 Google 不应启用 `authHeader: true`，否则 API key 会被当成 OAuth Bearer token。

### Qwen

- Qwen 走 DashScope OpenAI-compatible endpoint。
- Pi runtime 下 `qwen-turbo` 的 `max_tokens` 上限是 `16384`。
- Qwen 非 reasoning 模型不要强行打开 reasoning 参数。

## 能力 Matrix

| 能力 | Claude | Proma | AI SDK | Pi |
| --- | --- | --- | --- | --- |
| 文本流式 | 强 | 强 | 可用，需继续细化 UI 增量 | 可用 |
| 工具调用 | SDK 原生 | 完整 | 已接入核心工具与 MCP 工具 | 只读工具优先 |
| MCP | SDK 路径 | 完整 | 已通过 `RuntimeMcpService` 复用 Proma MCP 工具体系 | 未接入 |
| Plan mode | SDK 路径 | 完整 | 已复用 Proma 工具 | 未接入 |
| AskUser | SDK 路径 | 完整 | 已复用 Proma 工具 | 未接入 |
| Sub Agent | SDK 路径 | 完整 | 已复用 Proma 工具 | 未接入 |
| 权限模式 | SDK 原生 + Proma 编排 | 完整 | 已接入 Proma 权限检查 | 保守，只读工具优先 |
| fork / rewind | SDK snapshot 语义 | JSONL + 工作区复制 | JSONL/history replay，非 SDK 原生快照 | 非完整快照语义 |
| 服务端 Web 适配 | 中 | 中 | 高 | 中低 |

## 服务端 Web 优先级

下一阶段建议继续优先推进 AI SDK runtime。当前 1-6 的完成状态如下：

1. 抽出 Electron 无关 runtime core。已完成第一版。
   - 避免直接依赖 IPC、Electron `safeStorage`、本机配置目录。
   - 将 provider config、credential resolver、tool registry、agent loop 做成可注入依赖。
   - 当前实现：`AISDKRuntimeCore` 负责 AI SDK `streamText`、工具包装、权限兜底和 SDKMessage 转换；`AISDKAgentAdapter` 只保留输入校验、MCP 获取与 session 生命周期。
2. 完善 AI SDK 细粒度流式。已完成基础事件路径，仍需 UI 体验继续打磨。
   - `text_delta`、`tool_start`、`tool_result`、`usage_update` 已有基础路径。
   - 继续收敛 UI 增量一致性，避免回放 SDKMessage 造成的延迟感。
3. 抽出 runtime store 边界。已完成第一版。
   - `RuntimeCredentialStore`、`RuntimeWorkspaceStore`、`RuntimeSessionStore`、`RuntimeEventSink` 已抽象。
   - Electron 默认实现仍复用本地 JSON/JSONL、配置目录和 EventBus；服务端 Web 可替换为数据库、KMS、对象存储和 SSE/WebSocket sink。
4. 抽出 MCP 配置/token/连接管理边界。已完成第一版。
   - `RuntimeMcpService` 封装 MCP client manager acquire/release。
   - Proma runtime、AI SDK runtime 与 Sub Agent child adapter 使用同一 MCP service 注入点。
5. 定义服务端事件协议。已完成第一版。
   - `AgentStreamEnvelope` 包含 `id`、`sessionId`、`createdAt`、`payload`。
   - `serializeAgentStreamEnvelopeForSSE()` 可作为 SSE 输出基础；Electron IPC 仍保留 raw `AgentStreamPayload`，避免破坏现有 UI。
6. 做 provider 错误归一化与 fork/rewind 语义显式化。已完成第一版。
   - Google model/baseURL/auth 错误。
   - Kimi Coding Plan baseURL/model 错误。
   - Qwen `max_tokens` 与兼容参数错误。
   - 通用 OpenAI-compatible 401/404/429/5xx。
   - `normalizeAgentRuntimeError()` 输出统一 `TypedError`，AI SDK runtime 会通过 `typed_error` 事件上报。
   - `AGENT_RUNTIME_HISTORY_SEMANTICS` 明确 Claude 是 SDK snapshot，Proma / AI SDK / Pi 是 JSONL history copy + history truncate。

## 服务端 Web 当前边界

AI SDK runtime 现在已经比较适合作为服务端 Web 的第一条 runtime，但它还不是“完全 Web runtime”：

- 已抽出：模型调用 core、credential/workspace/session/event service、MCP acquire/release、secret codec、事件 envelope、错误归一化、fork/rewind 语义。
- 已新增服务端基础设施：
  - `AgentRuntimeTaskRunner`：按 `tenantId + userId + sessionId` 做任务并发保护、取消、完成/失败/取消状态。
  - `AgentRuntimeEventReplayHub`：保存 session 事件日志，支持 `Last-Event-ID` 风格 replay、订阅、SSE 序列化、WebSocket JSON 消息序列化和 durable event store 插槽。
  - `InMemoryTenantRuntimeStore`：多租户 credential/workspace/session/MCP token/client_secret 的内存实现，用于服务端 schema 和测试基线。
  - `ServerMcpOAuthCallbackHandler`：按 tenant/user/workspace/server/state 校验 MCP OAuth callback，调用 `finishAuth(code)` 并把 token 写入 tenant store。
  - `createAgentRuntimeWebServer()`：framework-agnostic P0 Web handler，覆盖 session 创建、run、SSE replay、messages、cancel 和 MCP OAuth callback。
  - `AgentRuntimeWebSecretCodec`：服务端 secret codec 插槽，credential 可通过 `apiKeyEncoding: 'encoded'` 进入 runner 前解密。
  - `PostgresTenantRuntimeStore`：通过通用 `query(sql, params)` 接口适配 Postgres 客户端，不在 shared 包中绑定具体数据库依赖。
  - `createWebCryptoEnvelopeSecretCodec()`：基于 AES-GCM 的 envelope codec，使用 tenant/user/purpose/resource 作为 AAD 绑定密文作用域。
  - `RedisAgentRuntimeEventStore` / `RedisAgentRuntimeTaskCache`：通过最小 Redis client 合同支持 stream replay、事件 trim 和 task cache，不在 shared 包中绑定具体 Redis SDK。
  - `InMemoryAgentRuntimeObjectStore` 与对象 key helper：统一 workspace files、session artifacts 的 tenant/user/session 前缀和相对路径校验。
  - `materializeAgentRuntimeWorkspace()` / `syncAgentRuntimeWorkspaceToObjectStore()`：在本地临时工作目录和对象存储之间同步 workspace 文件，拒绝 symlink、路径穿越和不安全对象 key。
  - `InMemoryAgentRuntimeInteractionStore`：保存 Permission/AskUser pending/resolved/cancelled/expired 状态；Web handler 已提供 list/respond/cancel route。
- 仍依赖 Electron 默认实现：渠道配置来源、工作区目录、附件本地文件路径、MCP OAuth deep link、EventBus IPC sink。
- 服务端落地时需要继续替换：framework-agnostic handler → Hono/Express/Bun route，Redis-compatible primitives → 真实 Redis client/连接池，object store primitives → S3/R2/OSS adapter，WebCrypto codec 的 key source → 云 KMS / envelope key rotation。
- 当前没有默认启动公网 HTTP 服务；这些模块是可嵌入的服务端 runtime primitives，避免 Electron app 意外暴露网络端口。

## 服务端 Web 生产化路线图

目标是从“AI SDK runtime 可嵌入服务端”推进到“多人、多租户、可部署、可观测、可计费的 Web Agent 服务”。优先级按依赖关系排序，不建议跳过 P0/P1 直接做多 worker 或费用系统。

### P0：单实例可用闭环（第一版已完成）

P0 的目标是先跑通一个真实 Web vertical slice，证明浏览器请求可以稳定驱动 AI SDK Agent loop。已完成：独立 Bun HTTP server、原生 `Bun.SQL` Postgres client、AI SDK runner、SSE replay、WebCrypto envelope secret codec 与测试闭环；生产部署仍需接入正式 OIDC/JWT 和云 KMS/key rotation。

| 模块 | 当前状态 | 验收标准 |
| --- | --- | --- |
| HTTP API | 已完成 Bun server 及 `POST /agent/sessions`、`POST /agent/sessions/:id/run`、`GET /agent/sessions/:id/events`、`GET /agent/sessions/:id/messages`、`POST /agent/tasks/:id/cancel` | 浏览器可创建 session、发起任务、SSE 收流、取消任务、断线后 replay |
| Auth scope | 已完成 header resolver 默认实现，可注入真实 auth | 所有 store、event、task、MCP token 都按 scope 隔离，跨租户访问返回 403/404 |
| Store contract | 已扩展 credential/workspace/session/message/task/token/client_secret；`InMemoryTenantRuntimeStore` 与 `PostgresTenantRuntimeStore` 已覆盖 P0 测试 | 服务重启后 session 历史、task terminal 状态、MCP token 可恢复（需要部署时接真实 Postgres client/连接池） |
| Secret codec | 已完成 `AgentRuntimeWebSecretCodec` 插槽、base64 测试 codec 和 `createWebCryptoEnvelopeSecretCodec()` | provider key、MCP token、MCP client_secret 入库前加密，日志不出现明文（需要部署时接云 KMS/key rotation） |
| AI SDK runner bridge | 已完成 `AgentRuntimeWebAgentTurnRunner` 注入接口；HTTP run route 已接 `AgentRuntimeTaskRunner` | 一轮 Agent 能真实调用 provider、写 session history、发出 envelope event |
| MCP OAuth route | 已完成 `GET /mcp/oauth/callback` 接 `ServerMcpOAuthCallbackHandler` | authorization_code provider 可从浏览器跳转授权并把 token 存入 tenant store |

P0 第一版完成后可以声明：服务端 Web 单实例 runtime 边界已跑通，但还不适合横向扩容和生产公网流量。

### P1：可靠性与可恢复

P1 的目标是让单实例服务具备生产运行基础，尤其处理断线、重启、附件、workspace 文件和事件恢复。已完成 Redis client/Stream durable replay、S3-compatible adapter、上传/下载 API、受控 workspace materialize/sync、结构化日志与 Permission/AskUser Web response route；基础审计日志留待 P4 的 append-only 审计体系统一实现。

| 模块 | 必须交付 | 验收标准 |
| --- | --- | --- |
| Redis event/task cache | 已接入 node-redis client 与 Redis Stream durable event store | SSE 断线可通过 `Last-Event-ID` 补事件；服务重启后可读取 terminal event |
| 对象存储 | 已接入 S3-compatible adapter、workspace 上传/下载 API、大小限制和 tenant 前缀隔离 | 大文件不进 DB；path traversal 与跨 scope 读取被拒绝 |
| Workspace 文件策略 | 已完成对象 key 规范与 `materializeAgentRuntimeWorkspace()` / `syncAgentRuntimeWorkspaceToObjectStore()` Node adapter | session run 前可 materialize workspace；run 后可同步 artifact；path traversal 和 symlink 逃逸测试通过 |
| Permission/AskUser Web 化 | 已完成 `AgentRuntimeInteractionStore` primitives，覆盖 pending/resolved/cancelled/expired；Web handler 已接 `GET /agent/interactions`、`POST /agent/interactions/:id/respond`、`POST /agent/interactions/:id/cancel` | Agent 等待用户响应时不阻塞其他 session；刷新页面后仍能看到待处理请求 |
| Structured logging | 已输出 `tenantId/userId/sessionId/requestId`、状态与耗时的 JSON 日志 | 单次失败能从 HTTP request 追到 task 边界 |
| 基础审计日志 | 待 P4 统一实现 | 审计日志 append-only，普通用户不可修改，管理员可按 session/task 查询 |

P1 完成后可以声明：服务端 Web 具备生产单实例能力，并且为多 worker 做好了共享状态基础。

### P2：多 worker 和横向扩容

P2 的目标是允许多个 server worker 同时服务同一租户，不依赖进程内内存。当前已完成本地验收：临时 Postgres/Redis Compose 环境中，两个 worker 不能同时取得同一 session lease，Redis event 可由另一实例 replay；双应用实例 E2E 覆盖 session/run/workspace/SSE replay。

| 模块 | 必须交付 | 验收标准 |
| --- | --- | --- |
| Distributed task lease | 已用 Postgres lease table 替代跨实例并发保护 | 同一 scoped session 在多 worker 下仍只能有一个 running task |
| Worker ownership | lease 记录 `workerId`、`lease_expires_at`，执行期间心跳续期 | worker 崩溃后 lease 到期可由新 worker 接管 |
| Redis stream | durable event 写入 Redis Stream | 任意 worker 可 replay 同一 session 的持久事件 |
| Sticky-free SSE | SSE route 从 Redis Stream replay，不要求负载均衡 sticky session | 断线重连到不同 worker 仍能补齐事件 |
| Graceful shutdown | 已处理 `SIGTERM` / `SIGINT`，取消本实例任务并 flush durable event | 关停不会丢已写入的 terminal event |
| MCP connection strategy | 每 worker 连接缓存 + token 共享 + lease-aware cleanup | 多 worker 不重复污染 OAuth token，不把 stdio MCP 连接跨进程共享 |

P2 完成后可以声明：Web Agent 服务具备横向扩容所需的任务互斥与持久事件重放边界；生产部署仍应配置正式身份认证、监控与 worker 崩溃告警。

#### P2 本地 E2E

```bash
docker compose -f apps/server/docker-compose.p2-test.yml up -d

export PROMA_P2_TEST_DATABASE_URL='postgres://proma:proma@127.0.0.1:55432/proma'
export PROMA_P2_TEST_REDIS_URL='redis://127.0.0.1:56379'

bun run --filter='@proma/server' test:p2-live
bun run --filter='@proma/server' test:web-e2e

docker compose -f apps/server/docker-compose.p2-test.yml down
```

### P3：费用系统和配额

P3 的基础能力已完成：服务端从 AI SDK assistant usage 归一化 input/output/cache token，写入 Postgres usage ledger；价格目录按 provider/model/effectiveAt 选取，以微美元保存可复算成本。未配置价格时仍记录 usage，但不虚构成本。

| 模块 | 必须交付 | 验收标准 |
| --- | --- | --- |
| Usage normalization | AI SDK 服务端已写入 input/output/cache token usage ledger | AI SDK、Proma、Pi runtime 的 usage 都能落到同一 usage schema |
| Price catalog | 已支持 provider/model/effectiveAt 的环境变量价格目录和微美元成本计算 | 历史 task 按当时价格计算，不被后续价格变更污染 |
| Quota/rate limit | 已接入 tenant/user 当月成本预算与单模型月度额度预检，以及按 tenant/user/model 的 Redis Lua 原子固定窗口限速 | 超额前拒绝新 task，运行中 task 可按策略继续或取消 |
| Cost attribution | 成本归属到 tenant/user/session/task/model/tool | 管理端可查某租户、某用户、某 session 的成本 |
| Budget alerts | 阈值提醒和熔断策略 | 达到 80%/100% 预算时产生事件，100% 后禁止新任务 |
| Billing export | CSV/JSON 导出或后续接 Stripe/内部账单系统 | 月度账单可复算，误差来源可追踪 |

P3 完成后可以声明：服务端 Web 可以面向团队/组织做成本治理。

### P4：复杂审计与合规

P4 的目标是从“基础审计日志”升级成可审查、可留存、可导出的合规能力。

| 模块 | 必须交付 | 验收标准 |
| --- | --- | --- |
| Append-only audit store | 已实现 Postgres 仅追加的请求元数据日志；hash chain/WORM 尚未实现 | 记录 actor/action/resource/result/requestId，且不写入请求体、凭证或模型输出 |
| Tool security audit | 对 Bash、Write、Edit、MCP tool、Sub Agent 做风险分级 | 高风险工具调用必须有 permission decision 和操作者记录 |
| Secret access audit | 记录 provider key、MCP token 解密使用，不记录明文 | 能回答“谁在什么时候因哪个 task 使用了哪个 secret” |
| Data retention | session、event、artifact、audit 的 retention policy | 到期清理不破坏账单和审计最低留存要求 |
| Scoped review API | 已实现调用方 tenant/user 范围内的审计检索；管理员角色、导出与异常过滤尚未实现 | 普通调用方不能越过 tenant/user 范围读取记录 |
| Compliance hooks | webhook/SIEM export、异常告警、IP/user-agent 记录 | 可对接企业安全系统，异常工具行为能触发通知 |

P4 完成后可以声明：服务端 Web 具备企业级审计基础。

### P5：体验与运维完善

P5 的目标是把可用服务打磨成长期可运营的产品。

| 模块 | 必须交付 | 验收标准 |
| --- | --- | --- |
| Runtime metrics API | 已实现 `GET /agent/metrics`，汇总 running/终态 task 与 24h token/cost | 调用方可读取自身 tenant/user 范围运行指标；trace、provider latency、MCP 错误仍待补 |
| Recovery diagnostics | 已实现 `GET /agent/recovery/stale-tasks`，识别失效或缺失 task lease 的 running task | 只读诊断，不跨 worker 强制改写 task 状态，避免误杀收尾中的任务 |
| Web UI 完整接入 | session list、runtime/model selector、tool activity、permission/AskUser、MCP OAuth 状态、fork/rewind | 浏览器端体验达到 Electron Agent 主要能力的 Web 版闭环 |
| Provider E2E matrix | DeepSeek、Google、Kimi Coding、Zhipu、Qwen、OpenAI、Doubao、Anthropic 的真实 smoke | 每个 provider 至少覆盖最小文本、工具调用、错误归一化 |

P5 完成后可以声明：服务端 Web 进入可持续迭代阶段。

## 服务端 Web 推荐实施顺序

1. P0-1：HTTP API + auth scope + Postgres store schema。
2. P0-2：KMS secret codec + credential/MCP token 加密落库。
3. P0-3：AI SDK runner vertical slice + SSE event route。
4. P0-4：MCP OAuth callback route。
5. P1-1：Redis event replay/task cache + permission/AskUser Web 化。
6. P1-2：对象存储 + workspace materialize/sync。
7. P2：distributed task lease、多 worker event fanout、graceful shutdown。
8. P3：usage/cost/quota/budget。
9. P4：复杂审计、retention、SIEM/webhook export。
10. P5：Web UI 补齐、观测面板、恢复工具、provider E2E matrix。

## fork / rewind 语义

| Runtime | fork | rewind | 文件快照恢复 |
| --- | --- | --- | --- |
| Claude | SDK 原生 session fork + 工作区复制 | SDK file-history snapshot + JSONL 截断 | 支持 |
| Proma | JSONL history copy + 工作区复制 | history truncate | 不支持 |
| AI SDK | JSONL history copy + 工作区复制 | history truncate | 不支持 |
| Pi | JSONL history copy + 工作区复制 | history truncate | 不支持 |

## 验证命令

默认无外网验证：

```bash
bun test
bun run typecheck
bun run lint
bun run electron:build
```

真实 API smoke：

```bash
PROMA_AI_SDK_REAL_API=1 bun test apps/electron/src/main/lib/adapters/ai-sdk-agent-adapter.real.test.ts
PROMA_PI_REAL_API=1 bun test apps/electron/src/main/lib/adapters/pi-agent-adapter.real.test.ts
```

本轮完整验证结果：

```text
bun test: 213 pass, 1 skip, 0 fail
bun run typecheck: passed
bun run lint: passed
bun run electron:build: passed
```
