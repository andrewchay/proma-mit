# context-store 接入 Proma 运行时方案

## 目标
让 Agent 运行时使用本地 context-store 进行上下文召回，替代/补充现有的 MemOS Cloud 记忆工具。

## 现状分析

### 当前记忆架构
```
Agent 运行时
├── MCP 工具: mcp__mem__recall_memory (MemOS Cloud)
├── MCP 工具: mcp__mem__add_memory (MemOS Cloud)
├── 条件: memoryEnabled = getMemoryConfig().enabled && !!apiKey
└── 提示词: buildSystemPrompt() 注入记忆系统指引
```

### context-store 当前状态
- 包: `packages/context-store`（@gravitas/context-store）
- 存储: sql.js 内存库 + 文件导出
- 召回: CJK bigram 分词 + 两档召回（严格/放宽）
- 尚未被任何模块引用

## 接入方案

### 方案 A：新增本地记忆 MCP 工具（推荐）

在 agent-orchestrator 中新增一组 MCP 工具，与现有 mem 工具并存：

```typescript
// 新工具: context_recall — 从本地 context-store 召回
// 新工具: context_add — 向本地 context-store 写入
```

**优点**:
- 与现有记忆工具架构一致（MCP 工具）
- 不破坏 MemOS Cloud 集成
- 用户可选择启用本地记忆或云端记忆或两者

**实现步骤**:
1. 在 `agent-orchestrator.ts` 的 `injectBuiltinMemosMcpServer` 旁新增 `injectContextStoreMcpServer`
2. 创建 `context-store-tool.ts`（仿 `memory-tool.ts`）
3. 在 `buildSystemPrompt` 中新增本地记忆指引
4. 配置: settings.json 新增 `localContextStore.enabled`

### 方案 B：替换现有记忆工具

将 `mcp__mem__recall_memory` 改为从 context-store 召回，不再依赖 MemOS Cloud。

**缺点**:
- 破坏现有 MemOS Cloud 集成
- 用户已配置的记忆凭据失效
- 跨设备记忆同步丢失

### 方案 C：增强 DynamicContext

在 `buildDynamicContext` 中自动召回相关上下文，注入到每条用户消息前。

**优点**:
- 对 Agent 透明（不需要调用工具）
- 零延迟（在消息发送前完成）

**缺点**:
- 召回质量不可控（无法让 Agent 决定何时召回）
- token 消耗不可控（每次消息都注入）
- 与 mycontext 的「Agent 主动召回」设计理念冲突

## 推荐：方案 A（新增本地记忆 MCP 工具）

### 实施步骤

1. **创建 context-store 工具实现**
   - `apps/electron/src/main/lib/agent-runtime/tool-impls/context-store-tool.ts`
   - 工具定义: `context_recall`, `context_add`
   - 执行逻辑: 打开 context-store → 召回/写入 → 关闭

2. **注入 MCP Server**
   - 在 `agent-orchestrator.ts` 新增 `injectContextStoreMcpServer`
   - 条件: `localContextStore.enabled`（settings.json）

3. **更新系统提示词**
   - `buildSystemPrompt`: 新增本地上下文存储指引
   - 说明与 MemOS Cloud 记忆的区别

4. **配置集成**
   - `settings.ts`: 新增 `localContextStore?: { enabled: boolean; path?: string }`
   - `settings-service`: 读写配置
   - UI: 设置面板新增「本地上下文存储」开关

5. **数据流**
   ```
   Agent 调用 context_recall(query)
     → 打开 ~/.proma/context-store.db
     → recall(query) → 返回结构化结果
     → 渲染为模型可读文本
   
   Agent 调用 context_add(entity)
     → 打开 store
     → upsertEntity(entity)
     → persist() → 关闭
   ```

## 关键决策待确认

1. **context-store 数据目录**: `~/.proma/context-store.db` 还是工作区隔离？
2. **与 MemOS Cloud 的关系**: 并存 / 互斥 / 优先级？
3. **自动写入**: Agent 的每次对话是否自动写入 context-store？
4. **召回时机**: Agent 主动调用 vs 系统自动注入？

请确认方案 A 后，我开始实施。
