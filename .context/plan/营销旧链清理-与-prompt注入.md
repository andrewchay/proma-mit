# 营销工具旧链清理 + systemPrompt 指令保留注入

## 背景与目标
批量迁移（S6）已完成：15 个 ma-tool 通过 marketing-plugin 的 RuntimeToolDefinition 接入 Agent 运行时。现清理历史孤儿链，并保留营销工具的模型调用引导指令。

已确认决策（用户）：
- 清理深度：**彻底清理**（删各 ma-tool 文件里无消费方的 ChatToolMeta / isXxxToolCall / isXxxAvailable + index.ts 孤儿 re-export）
- systemPromptAppend 指令：**保留并注入**（新建轻量机制，随插件注入 agent 系统提示）

## 已实证的孤儿面（全部无外部消费，仅文件自身 + index.ts re-export）
- 15 个 `Xxx_TOOL_META`（ChatToolMeta，含 systemPromptAppend）
- 15 个 `isXxxAvailable`
- 15 个 `isXxxToolCall` + 对应 `const TOOL_NAME`/`TOOL_NAMES`
- `import type { ChatToolMeta } from '@gravitas/shared'`
- 部分工具的 only-用于 isAvailable 的 import（如 kol-search 的 getToolCredentials）

保留：`Xxx_TOOL_DEFINITIONS` + `executeXxxTool`（marketing-plugin 延迟 require 的适配源）+ 业务函数（runContentAudit 等）+ kol-data-service / llm-service 底层服务。

## 关键约束（执行顺序敏感）
**必须先抽取 systemPromptAppend 指令到独立文件，再删除含它的 ChatToolMeta 块**，否则指令数据丢失。

## 实施步骤

### B1 抽取指令（先做）
- 新建 `apps/electron/src/main/lib/marketing/ma-tools/ma-tool-prompts.ts`
- 导出 `MA_TOOL_SYSTEM_PROMPTS: Array<{ id: string; prompt: string }>`（15 条，内容从各 Xxx_TOOL_META.systemPromptAppend 提取）
- import 类型用 string 直接量，无外部依赖

### A1 清理 index.ts 孤儿 re-export
- 移除各 ma-tool 的 `Xxx_TOOL_META` / `isXxxToolCall` / `isXxxAvailable` 的 re-export
- 保留 `Xxx_TOOL_DEFINITIONS` / `executeXxxTool` / 底层服务导出

### A2 逐文件清理（15 个 ma-tool .ts）
每个文件删除：
- `import type { ChatToolMeta }`
- `Xxx_TOOL_META` 块（含 systemPromptAppend，已被 B1 抽取）
- `isXxxAvailable` 函数
- `const TOOL_NAME`/`TOOL_NAMES` + `isXxxToolCall` 函数
- 仅 isAvailable 使用的额外 import（逐个核对）

### B2 扩展 plugin-manager 注入机制
- `BuiltinPluginRuntime` 加可选 `contributePrompts?: () => string[]`
- 新增 `collectContributingPrompts(): string[]`（对称于 collectContributingTools；enabled+supported 才收集）

### B3 marketing-plugin 暴露 contributePrompts
- 从 ma-tool-prompts 读取全部指令，`contributePrompts: () => MA_TOOL_SYSTEM_PROMPTS.map(p => p.prompt)`

### B4 注入 buildSystemPrompt
- `SystemPromptContext` 加可选 `marketingAdvice?: string`（或通用字段）
- `buildSystemPrompt` 尾部 `sections.push(\`## 营销领域能力\n[...]\`)`（若无则跳过）
- agent-orchestrator 的两处 `buildSystemPrompt({...})` 调用处传入 `collectContributingPrompts().join('\n')`

### S7 测试与验证
- marketing-plugin.test 更新：验证 contributePrompts 贡献 15 条
- typecheck exit 0
- 跑 marketing-plugin.test / plugin-manager.test（基线 3 fail 为既有）
- 探测 contributeTools 仍贡献 5 个本地 + electron 全量

## 风险与注意
- **systemPromptAppend 抽取顺序**：先 E1 再 A2，防数据丢失
- **executeXxxTool 依赖**：不依赖 isAvailable/isToolCall（已实证），安全
- **kol-search 额外 import**（getToolCredentials from chat-tool-config）：需核对 isKOLSearchAvailable 是否用它，删函数时连带清理
- **campaign-agent TOOL_NAMES 数组**：isCampaignAgentToolCall 用数组，删除函数时删常量
- buildSystemPrompt 是核心系统提示，注入需放在独立 section，避免污染通用提示
- 指令注入是功能增强，若 agent-orchestrator 调用点过多，可先在主调用点注入

## 关键文件
- apps/electron/src/main/lib/marketing/ma-tools/ma-tool-prompts.ts（新建）
- apps/electron/src/main/lib/marketing/ma-tools/index.ts
- apps/electron/src/main/lib/marketing/ma-tools/{15 个工具}.ts
- apps/electron/src/main/lib/plugin-manager.ts
- apps/electron/src/main/lib/agent-prompt-builder.ts
- apps/electron/src/main/lib/agent-orchestrator.ts
