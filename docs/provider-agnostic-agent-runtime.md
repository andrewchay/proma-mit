# Provider-Agnostic Agent Runtime 迁移规划

> 创建时间：2026-07-15  
> 状态：阶段 1 Week 1 完成，集成测试通过，待真实 DeepSeek API 验证

## 1. 背景与目标

当前 Proma 的 Agent 模式深度依赖 `@anthropic-ai/claude-agent-sdk`，导致：
- 多模型支持困难（SDK 原生为 Claude 设计）
- 工具名、权限模式、会话格式被 Claude 语义绑定
- Prompt 前缀缓存难以按供应商优化

本迁移目标是在保留 Claude SDK  backend 的同时，构建一个基于现有 `ProviderAdapter` 的 Provider-Agnostic Agent Runtime，逐步实现多模型 Agent 能力。

## 2. 架构决策

### 2.1 不自研 Pi 类 harness

Pi 等极简 terminal harness 缺少 MCP、权限系统、Plan 模式、子 Agent 等 Proma 已具备的能力，重新实现成本过高。

### 2.2 基于现有 ProviderAdapter 构建

复用 `@proma/core` 的 `ProviderAdapter`、`buildStreamRequest`、`streamSSE`、`ToolCall` 抽象，在 Electron 主进程新增：

```
apps/electron/src/main/lib/agent-runtime/
├── types.ts              # Runtime 输入、工具、消息类型
├── tool-registry.ts      # 工具注册与分发
├── prompt-builder.ts     # 系统提示词 + 历史消息转换
├── tool-impls/
│   ├── read-tool.ts
│   ├── write-tool.ts
│   ├── edit-tool.ts
│   ├── bash-tool.ts
│   └── grep-tool.ts
└── tool-impls/tool-impls.test.ts

apps/electron/src/main/lib/adapters/
├── claude-agent-adapter.ts
└── provider-agnostic-agent-adapter.ts   # 新适配器
└── provider-agnostic-agent-adapter.test.ts
```

### 2.3 双 backend 共存

`AgentOrchestrator` 通过白名单控制：
- `deepseek` → `ProviderAgnosticAgentAdapter`
- 其他供应商 → `ClaudeAgentAdapter`

避免影响现有用户，支持逐步验证。

## 3. 迁移阶段

### Phase 1：验证核心循环（当前）

**目标**：DeepSeek 能完成"读取文件 → 编辑文件 → 返回结果"的完整工具循环，且安全基线达标。

**已完成**：
- [x] 创建 Runtime 模块 + 5 个核心工具（Read / Write / Edit / Bash / Grep）
- [x] 实现 `ProviderAgnosticAgentAdapter`
- [x] `AgentOrchestrator` 白名单路由 `deepseek`
- [x] 工具单元测试（12 个用例，含 symlink、shell 注入）
- [x] 适配器集成测试（3 个用例，覆盖 Read → Edit 循环、权限拒绝、请求体顺序）
- [x] 全量 `bun test` 与 `typecheck` 通过
- [x] **安全加固**：
  - [x] 实验开关 `PROMA_ENABLE_AGENT_RUNTIME` 默认关闭
  - [x] 工具执行前接入 `AgentPermissionService`（bypassPermissions / auto / 本地兜底）
  - [x] `resolveToolPath` 使用 `realpathSync` 防止 symlink 绕过
  - [x] `Grep` 改用 `spawn` + 参数数组，消除 shell 注入
- [x] **功能修复**：
  - [x] 修复 Anthropic 适配器下的工具续接消息顺序（userMessage 保持原始 prompt，tool_use/tool_result 仅在 continuationMessages）

### Phase 2：Chat 级能力对齐（进行中）

**目标**：让 Provider-Agnostic Runtime 达到与 Chat 相当的基础体验。

**已完成**：
- [x] 多轮历史加载：`AgentOrchestrator` 读取 `getAgentSessionSDKMessages`，`ProviderAgnosticAgentAdapter` 传入 `history`
- [x] `sdkMessagesToChatMessages`：将持久化 SDKMessage 转换为 ChatMessage，保留最近 20 条，tool_use/tool_result 序列化为 XML 标签；用户消息的 `_attachments` 透传到 `ChatMessage.attachments`
- [x] 错误重试：`streamSSE` 调用包裹 `withRetry`，基于 `isTransientNetworkError` 对瞬时网络错误进行 2 次指数退避重试
- [x] 降级：Provider-Agnostic Runtime 发生非中止永久错误时，抛出 `ProviderAgnosticRuntimeError`，`AgentOrchestrator` 截断追加的用户消息后切到 Claude SDK 路径
- [x] 多模态附件：文档附件提取为 `<file>` 文本注入 prompt，图片附件通过 `readImageAttachments` 以 base64 注入；历史消息中的附件同样会被富化

**待完成**：
- [ ] 真实 DeepSeek API 端到端验证
- [ ] 观察并记录 `prompt_cache_hit_tokens` 变化
- [ ] 会话恢复 resume
- [ ] MCP / Plan 模式

**新增/调整的文件**：
- `apps/electron/src/main/lib/agent-runtime/attachment-enrichment.ts`：图片 base64 读取、文档文本提取、历史消息批量富化、XML 转义
- `apps/electron/src/main/lib/agent-runtime/prompt-builder.ts`：`sdkMessagesToChatMessages` 现在会把 SDKUserMessage 的 `_attachments` 透传到 `ChatMessage.attachments`
- `apps/electron/src/main/lib/adapters/provider-agnostic-agent-adapter.ts`：当前 prompt 与历史消息均经过附件富化后传入 `buildStreamRequest`
- `apps/electron/src/main/lib/agent-orchestrator.ts`：持久化用户 SDKMessage 时写入 `_attachments`，并将 `attachments` 传给 Provider-Agnostic Runtime
- `apps/electron/src/renderer/components/agent/AgentView.tsx`：发送 Agent 消息时构造 `FileAttachment[]` 并传入 `AgentSendInput`，不再仅依赖 `<attached_files>` 文本
- `apps/electron/src/main/lib/document-parser.ts`：`extractTextFromAttachment` 支持 `~/.proma/` 下的绝对路径（Agent session workspace 文件），与 `readAttachmentAsBase64` 保持一致
- `apps/electron/src/main/lib/agent-service.ts`：`saveFilesToAgentSession` / `saveFilesToWorkspaceFiles` 返回 `size`
- `packages/shared/src/types/agent.ts`：`AgentSavedFile` 增加 `size`
- `packages/shared/src/types/chat.ts`：`FileAttachment.localPath` 注释明确支持绝对路径

### Phase 3：特性对齐

- MCP Server 工具注入
- 权限模式（safe / ask / allow-all）
- AskUser / ExitPlan 交互
- 子 Agent / Plan 模式

### Phase 4：可选移除 Claude SDK

在 Provider-Agnostic Runtime 完全覆盖并稳定后，评估是否移除 `@anthropic-ai/claude-agent-sdk` 依赖。

## 4. 安全基线

### 4.1 实验开关（默认关闭）

Provider-Agnostic Runtime 默认不启用，必须设置环境变量：

```bash
PROMA_ENABLE_AGENT_RUNTIME=1
```

未开启时，即使渠道是 DeepSeek，也继续走原有 Claude SDK 路径，避免影响现有用户。

### 4.2 权限检查

`ProviderAgnosticAgentAdapter` 在 `executeToolCalls` 前调用权限回调：
- `bypassPermissions`：全部放行
- `auto`：复用 `AgentPermissionService.createCanUseTool`，通过 event bus 向渲染进程发送 `permission_request`
- 未配置回调：只读工具（Read/Grep）放行，写工具（Write/Edit/Bash）拒绝

### 4.3 路径安全

`resolveToolPath()` 使用 `realpathSync` 解析目标路径和 cwd，并逐级向上检查不存在的祖先目录，防止 symlink 绕过路径遍历限制。

### 4.4 命令注入防护

`Grep` 工具改用 `spawn(command, args)` + 参数数组执行，不再拼接 shell 字符串。

## 5. 缓存策略

OpenAI / DeepSeek / GLM / Kimi 等大多采用自动前缀缓存。Runtime 的消息顺序为：

1. 系统提示词（稳定）
2. 工具定义（稳定）
3. 历史消息（动态增长）
4. 当前用户消息（动态）

通过将稳定前缀放在前面，最大化自动前缀缓存命中率，无需供应商特定缓存 flag。

## 5. 测试覆盖

| 测试文件 | 用例数 | 说明 |
|---------|-------|------|
| `agent-runtime/tool-impls/tool-impls.test.ts` | 12 | Read / Write / Edit / Bash / Grep 单元测试；含 symlink 绕过、Grep shell 注入 |
| `agent-runtime/prompt-builder.test.ts` | 4 | system prompt 构建、SDKMessage → ChatMessage 转换、历史截断 |
| `agent-runtime/retry.test.ts` | 5 | withRetry 成功、重试、不可重试、最大次数、中止信号 |
| `adapters/provider-agnostic-agent-adapter.test.ts` | 6 | 完整工具循环 + 权限拒绝 + 无工具直接结束 + 附件传入 + 历史消息传入 + streamSSE 重试；校验请求体顺序 |
| `agent-runtime/attachment-enrichment.test.ts` | 11 | 文档附件富化、图片附件过滤、XML 转义、空附件/失败降级 |
| `document-parser.test.ts` | 4 | 文本文件提取、相对路径附件、~/.proma/ 下绝对路径附件、路径越界拒绝 |

运行：

```bash
bun test
bun run --filter='*' typecheck
```

## 6. 版本记录

| 包 | 本次变更前 | 本次变更后 |
|---|-----------|-----------|
| `@proma/shared` | `0.1.23` | `0.1.24` |
| `@proma/electron` | `0.9.53` | `0.9.54` |
