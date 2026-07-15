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

**目标**：DeepSeek 能完成"读取文件 → 编辑文件 → 返回结果"的完整工具循环。

**已完成**：
- [x] 创建 Runtime 模块 + 5 个核心工具（Read / Write / Edit / Bash / Grep）
- [x] 实现 `ProviderAgnosticAgentAdapter`
- [x] `AgentOrchestrator` 白名单路由 `deepseek`
- [x] 工具单元测试（9 个用例）
- [x] 适配器集成测试：mock SSE 完成 Read → Edit 循环
- [x] 全量 `bun test` 与 `typecheck` 通过

**待完成**：
- [ ] 真实 DeepSeek API 端到端验证
- [ ] 观察并记录 `prompt_cache_hit_tokens` 变化

### Phase 2：Chat 级能力对齐

- 多模态附件（图片、文档）
- 标题自动生成
- 错误重试与降级
- 会话恢复（resume）

### Phase 3：特性对齐

- MCP Server 工具注入
- 权限模式（safe / ask / allow-all）
- AskUser / ExitPlan 交互
- 子 Agent / Plan 模式

### Phase 4：可选移除 Claude SDK

在 Provider-Agnostic Runtime 完全覆盖并稳定后，评估是否移除 `@anthropic-ai/claude-agent-sdk` 依赖。

## 4. 缓存策略

OpenAI / DeepSeek / GLM / Kimi 等大多采用自动前缀缓存。Runtime 的消息顺序为：

1. 系统提示词（稳定）
2. 工具定义（稳定）
3. 历史消息（动态增长）
4. 当前用户消息（动态）

通过将稳定前缀放在前面，最大化自动前缀缓存命中率，无需供应商特定缓存 flag。

## 5. 测试覆盖

| 测试文件 | 用例数 | 说明 |
|---------|-------|------|
| `agent-runtime/tool-impls/tool-impls.test.ts` | 9 | Read / Write / Edit / Bash / Grep 单元测试 |
| `adapters/provider-agnostic-agent-adapter.test.ts` | 2 | 完整工具循环 + 无工具直接结束 |

运行：

```bash
bun test
bun run --filter='*' typecheck
```

## 6. 版本记录

| 包 | 本次变更前 | 本次变更后 |
|---|-----------|-----------|
| `@proma/shared` | `0.1.19` | `0.1.20` |
| `@proma/electron` | `0.9.48` | `0.9.49` |
