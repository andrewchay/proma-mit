# context-store 接入 Proma 运行时 — 实施计划

## 已确认决策

| 项 | 决策 |
|----|------|
| 接入方案 | C: 增强 DynamicContext（自动注入，Agent 无感知） |
| 数据目录 | 按工作区隔离 |
| 与 MemOS Cloud | 并行，本地优先 |
| 自动写入 | 用户消息 + Agent 回复 + 工具调用结果 |
| 召回时机 | 混合：系统自动注入近期上下文 + Agent 主动召回历史 |

## 实施步骤

### S1: context-store 工作区隔离支持
- [ ] 改造 `openContextStore`：支持按工作区 slug 自动解析路径
- [ ] `ContextStoreOptions` 新增 `workspaceSlug?: string`
- [ ] 路径规则：`~/.proma/workspaces/{slug}/context-store.db`
- [ ] 无 slug 时 fallback 到 `~/.proma/context-store.db`

### S2: 创建 ContextStoreService（主进程服务层）
- [ ] 新文件：`apps/electron/src/main/lib/context-store-service.ts`
- [ ] 职责：
  - 按工作区管理 context-store 实例（缓存 + 生命周期）
  - 提供 `recallForSession(sessionId, query)` 接口
  - 提供 `indexSessionMessages(sessionId, messages)` 接口（自动写入）
  - 封装 store 的打开/关闭/持久化
- [ ] 单例模式，主进程启动时初始化

### S3: 自动写入（消息索引）
- [ ] 在 `agent-orchestrator.ts` 的消息持久化点 hook
- [ ] 用户消息 → `upsertEntity({ entityType: 'session_message', ... })`
- [ ] Agent 回复 → `upsertEntity({ entityType: 'session_message', ... })`
- [ ] 工具调用 → `upsertEntity({ entityType: 'tool_call', ... })`
- [ ] 写入时关联 session（sourceId = sessionId）

### S4: DynamicContext 增强（自动注入）
- [ ] 改造 `buildDynamicContext`：新增 `recentContext` 参数
- [ ] 在 `agent-orchestrator.ts` 调用 `buildDynamicContext` 前：
  - 用当前 session 的最近 N 条消息作为 query
  - 调用 `contextStoreService.recallForSession(sessionId, query)`
  - 将召回结果格式化为文本块注入 DynamicContext
- [ ] 格式：带序号、时间、来源的摘要列表

### S5: Agent 主动召回（MCP 工具）
- [ ] 新建 MCP 工具：`local_context_recall`
- [ ] 注入到 agent-orchestrator 的 MCP servers
- [ ] 工具描述：「搜索本地工作区上下文存储中的历史记录」
- [ ] 与 MemOS Cloud 的 `recall_memory` 并存

### S6: 配置集成
- [ ] `settings.ts`: 新增 `localContextStore?: { enabled: boolean }`
- [ ] 默认启用（本地优先）
- [ ] 设置面板新增开关

### S7: 测试与验证
- [ ] context-store-service 单元测试
- [ ] 自动写入验证
- [ ] DynamicContext 注入验证
- [ ] MCP 工具可用性验证
- [ ] typecheck exit 0

## 关键文件
- `packages/context-store/src/store.ts` — 工作区路径支持
- `apps/electron/src/main/lib/context-store-service.ts` — 新服务
- `apps/electron/src/main/lib/agent-orchestrator.ts` — 自动写入 + DynamicContext
- `apps/electron/src/main/lib/agent-prompt-builder.ts` — DynamicContext 增强
- `apps/electron/src/main/lib/agent-runtime/tool-impls/` — MCP 工具
