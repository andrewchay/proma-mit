# 营销工具统一接入 plugin-manager（试点）

## 背景与目标

营销 18 个 ma-tools 是「孤儿工具集」：定义了 `ChatToolMeta` + `executeXxxTool(toolCall)`，但没有任何调度器消费（既不在 chat-tool-executor、也不在 agent-runtime/tool-registry、也不经 plugin-manager）。本次通过 **plugin-manager** 打通接入通路，使 Agent 运行时能真正调用营销工具。

已确认决策（用户）：
- 接入线：**plugin-manager**（仿 computer-use-plugin 新建 marketing 内置插件）
- 范围：**先试点打通通路**（选代表性工具验证），其余批量迁移后续做
- 旧链：迁移后**清理**旧 ChatToolMeta 重复定义，消除双执行链

## 协议适配（核心）

营销现协议 → agent-runtime 目标协议：

| 项 | 营销现（ma-tools） | 目标 RuntimeToolDefinition |
|---|---|---|
| 元数据 | `ChatToolMeta`（id/name/params） | `name` / `description` / `parameters`(JSON Schema) |
| 定义 | `CONTENT_AUDIT_TOOL_DEFINITIONS`（已有 `ToolDefinition[]`） | 复用其 `name/description/parameters` |
| 执行 | `executeXxxTool(toolCall: ToolCall): Promise<ToolResult>` | `execute(input: unknown, ctx: ToolContext): Promise<ToolResult>` |
| 类型 | import `@gravitas/core` 的 ToolCall/ToolResult | import agent-runtime `RuntimeToolDefinition` |

适配方式：为每个试点工具写一个**薄适配器函数** `toRuntimeTool(def, execute)`：
```ts
function toRuntimeTool(def: ToolDefinition, execute: (input: Record<string, unknown>) => Promise<ToolResult>): RuntimeToolDefinition {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: async (input) => execute((input ?? {}) as Record<string, unknown>),
  }
}
```
（原有 execute 内部签名基本兼容：其 `toolCall.arguments` → `input`，`toolCall.id` → 用固定/占位 toolCallId 由运行时回填。需核对 execute 对 `toolCall.id` 的依赖。）

## 试点工具选择

1. **content-audit**（`ma_audit_content`）— 首选试点：自包含、只需 completePrompt、无外部依赖，最干净地验证「插件 → collectContributingTools → Agent 运行时」全通路。
2. **creative-video（视频生成）** — 有实际业务价值（解决「Agent 视频生成工具缺失」），验证「业务域特有工具」也能接入；依赖凭据，无凭据时返回诚实错误（模拟现状语义）。

> 若 creative-video 风险偏高，可先只做 content-audit 单点，视频作为同批第二个。

## 实施步骤

### S1 新建 marketing 内置插件（仿 computer-use-plugin）
- 新文件 `apps/electron/src/main/lib/plugins/marketing-plugin.ts`
- 导出 `marketingPluginRuntime(): BuiltinPluginRuntime`
- manifest：id `com.gravitas.marketing`，surfaces `['agent-tools']`，platforms（不限平台），permissions 空（默认最小；营销工具本身只调本地 LLM，无特权）
- `contributeTools()`：返回试点工具的 `RuntimeToolDefinition[]`
- isEnabled / isSupported / setEnabled：默认启用、平台全支持

### S2 在 plugin-manager 注册
- 在 `BUILTIN_RUNTIMES` Map 加入 `['com.gravitas.marketing', () => marketingPluginRuntime()]`
- 更新 `packages/shared/src/types/plugin.ts` 的 `BUILTIN_PLUGINS`，追加 id 元信息（若该清单用于 UI 列表）

### S3 试点工具适配
- 给 content-audit（+可选 creative-video）补 `toRuntimeTool` 适配，产出 `RuntimeToolDefinition[]`
- 验证原有 service 层（llm-service.completePrompt / creative-video-service）可复用

### S4 测试
- 新增/扩展 `plugin-manager.test.ts`：注册 marketing 插件后 `collectContributingTools()` 能返回试点工具
- 验证 name 去重、disabled 跳过
- `content-audit` 的 execute 走真实 mock LLM 或自包含路径

### S5 验证通路
- 确认 `appendPluginTools` 会把试点工具并入 Agent 工具集（`createCoreTools()` 传入后）
- 类型检查 + 单测通过

### S6（后续，不在本轮）批量迁移其余 16 个
- 记录为待办，给出批量适配模板

## 关键风险 / 注意
- **execute 内部对 `toolCall.id` 的依赖**：agent-runtime 的 ToolResult 需要 `toolCallId`，需确认运行时如何赋值。看已有 tool-impls 的 execute 返回模式（read-tool 等）对齐。
- **name 冲突**：营销工具名前缀 `ma_`，与 CORE_TOOL_NAMES 不冲突，appendPluginTools 已按 name 去重。
- **循环依赖**：marketing-plugin 引用 ma-tools、plugin-manager 引用 marketing-plugin → 用延迟 require（仿 dynamicIslandRuntime 的 `require()` 模式），在 `BUILTIN_RUNTIMES` 工厂函数内 require。
- **manifest 权限**：营销工具无特权（本地 LLM + SQLite），permissions 不声明高风险项，符合「默认禁止」反向模型。
