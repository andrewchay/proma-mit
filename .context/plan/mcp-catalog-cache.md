# MCP 工具目录缓存方案（实施版）

> 借鉴 OpenAI Codex #37970 "Cache tool catalogs for streamable HTTP MCP servers"
> 交付：方案 + 实施代码

## 现状确认（代码核过）
- `ServerMcpConnectionManager`（`packages/shared/src/utils/agent-runtime-server-mcp-manager.ts`）：进程级单例，已按 tenant/user/workspace/server 做**连接级缓存**（refcount，refCount=0 才 close）。
- `acquireServerMcpTools`（`apps/server/src/server-mcp-tools.ts`）：**每次任务**对每个启用 MCP server 都 `manager.acquire()` → `connection.listTools()` 全量拉工具目录 → 全部转 AI SDK tool。
- 痛点：连接可复用，但**工具目录每次全量网络拉取**；多 server / 高频任务 / 多子任务时开销明显。

## 方案（用户选型）
1. **失效策略**：TTL + 指纹双保险（默认 TTL 60s）
2. **作用域**：并入 `ServerMcpConnectionManager`（packages/shared）
3. 交付代码

## 核心机制
在 `ServerMcpConnectionManager` 增加**工具目录（tool catalog）缓存**：

- 缓存 key：`connectionKey + fingerprintHash`
- 缓存 value：`{ tools: ServerMcpToolDefinition[]-like, createdAt, expiresAt }`
- 命中（未过期 && 指纹一致）→ 直接返回缓存的 tools，**跳过 listTools 网络调用**
- 未命中 → 正常连接 + listTools + 写缓存
- 指纹不匹配（配置变了）→ 重建并更新

### 指纹规则（对齐 Codex，仅安全可推导项）
- `url`
- `type`（http/streamableHttp / sse）
- `headers`（规范化 key 排序 + 值，仅静态头；**不含 Authorization 动态值**）
- 认证类型（`auth.type`）与静态参数
- `timeoutMs`
- **动态 OAuth token 单独排除**：`oauthAuthorizationCode` / `oauthClientCredentials` 字段 `allow_catalog_cache=false`（或指纹不含 token、且强制 miss 缓存，避免过期凭证泄漏）

> OAuth 认证的 server **不进共享目录缓存**——与 Codex 一致："Keep OAuth and other dynamically resolved credential configurations out of the shared cache"。

### 顶层功能选项
增加一个可选的 `catalogCacheTtlMs` 配置（默认 60_000），0 表示关闭目录缓存（仅保留连接缓存）。

## 涉及文件
1. ✅ `packages/shared/src/utils/agent-runtime-server-mcp-manager.ts`（核心：目录缓存 + 指纹 + TTL）
2. ✅ `apps/server/src/server-mcp-client.ts`（改用 shared 的 `McpCatalogToolDefinition`）
3. ✅ `apps/server/src/server-mcp-tools.ts`（`acquireServerMcpTools` 走 `resolveToolCatalog` 缓存）
4. ✅ `apps/server/src/app.ts`（`mcpEgress.catalogCacheTtlMs` 注入 manager）
5. ✅ `packages/shared/src/utils/index.ts`（导出新类型）
6. ✅ 测试：`agent-runtime-server-mcp-manager.test.ts`（8 个用例全过）
7. ✅ `CLAUDE.md` 沉淀架构说明

## 状态：✅ 已实施并测试通过（2026-08-11）
- shared、server 均 `tsc --noEmit` 通过
- biome lint 无告警
- MCP 相关 13 个测试全过（含 6 个缓存用例 + 2 个工具桥接/懒连接用例）

## 第二阶段：重度懒连接（已实施）
- `acquireServerMcpTools` 重写为重度懒连接：
  - 工具目录定义优先从进程级缓存读取（命中 → 任务零连接）
  - 连接仅在真正调用工具时才懒建立（`ensureConnected`：Map + Promise 缓存并发去重）
  - 同一任务内同一服务器后续工具调用复用该连接
  - `release()` 统一释放本任务懒建立的连接；目录缓存（纯数据）跨任务复用
- 新增测试证明：目录命中时获取阶段零连接、零 listTools；真正调用工具才建连，同任务复用，任务结束释放一次

## 收益
- 同 scope+server 连续任务不复握手工具目录
- 目录命中时**子代理/任务零连接启动**（真正的 Codex 式懒连接）
- 多 MCP server / 高频 / 多子任务启动更快

## 边界/取舍
- 重度懒连接已落地：工具定义来自纯数据目录缓存，连接仅在实际调用工具时懒建，同任务内复用，任务结束统一释放。
- 目录缓存 miss 时仍会建一次连接做 listTools 写缓存（不可避免，需连接才能列举工具），该连接复用于本任务后续调用。
- OAuth server 目录不进缓存（指纹为 null）→ 每任务仍会懒建连接并调用一次 listTools，属预期（动态凭证安全优先）。
