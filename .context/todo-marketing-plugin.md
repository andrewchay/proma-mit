# 营销工具统一接入 plugin-manager（清理 + prompt 注入）TODO

## 目标
把营销孤儿工具通过 plugin-manager 接入 Agent 运行时，并清理历史孤儿链、保留模型调用指令。

## 决策（用户已确认）
- 接入线：plugin-manager；旧链：彻底清理；systemPromptAppend：保留并注入

## 进度（2026-08-14 全部完成）
- [x] 试点 + 批量迁移 15 个 ma-tool（见前轮）✅
- [x] **B1 抽取指令**：ma-tool-prompts.ts（15 条 systemPromptAppend，JSON.stringify 安全转义）✅
- [x] **A1 清理 index.ts**孤儿 re-export（ChatToolMeta/IsAvailable/IsToolCall）✅
- [x] **A2 逐文件清理**15 个 ma-tool（ChatToolMeta 块 + isXxxAvailable + isXxxToolCall + TOOL_NAME + 多余 import）✅
- [x] **B2 plugin-manager**：BuiltinPluginRuntime.contributePrompts + collectContributingPrompts() ✅
- [x] **B3 marketing-plugin**：contributePrompts 返回 MA_TOOL_SYSTEM_PROMPTS ✅
- [x] **B4 注入**：SystemPromptContext.pluginToolPrompts + buildSystemPrompt「能力引导指令」section + agent-orchestrator 两处调用注入（collectPluginPrompts 延迟 require）✅
- [x] S7 测试：marketing-plugin.test.ts 8 pass（新增 contributePrompts 贡献 15 条 + collectContributingPrompts 收集）✅
- [x] electron typecheck exit 0 ✅
- [x] buildSystemPrompt 注入行为验证（能生成「能力引导指令」section 且含营销指令）✅

## 验证结论
- 清理后 contributeTools 仍贡献 5 个本地工具（storyboard + 4 SQLite/纯本地）不回归
- collectContributingPrompts 能收集营销指令（MA策略生成/MAKOL搜索 均验证到）
- plugin-manager 3 个既有 fail+fail 之前已确认非回归

## 待办（后续）
- [ ] **token 成本考量**：营销指令目前无条件注入所有 agent 会话（isEnabled 恒 true）。若需按「能力订阅/领域」开关过滤注入，接入 enabledCapabilitiesAtom 或营销订阅状态（避免非营销会话浪费 token）
- [ ] LLM 类 ma-tool 的完整 execute 测试需 electron 运行时
- [ ] 视频引擎/KOL数据源/connect-bot/llm-service 的 seam 化（独立议题）

## 关键文件
- marketing/ma-tools/ma-tool-prompts.ts（新建）：15 条营销指令源
- marketing/ma-tools/{15 工具}.ts（清理后）：仅保留 TOOL_DEFINITIONS + executeXxxTool + 业务函数
- marketing/ma-tools/index.ts（清理后）：仅 re-export 底层服务 + DEFS/execute
- plugin-manager.ts：BuiltinPluginRuntime.contributePrompts + collectContributingPrompts
- agent-prompt-builder.ts：SystemPromptContext.pluginToolPrompts + buildSystemPrompt「能力引导指令」
- agent-orchestrator.ts：collectPluginPrompts()（延迟 require）+ 两处 buildSystemPrompt 注入

## 关键技术点（踩坑复用）
1. **脚本清理块边界**：ma-tool 的 ChatToolMeta 是 on 对象（含反引号模板串），用「引号感知的 brace-match」定位闭合；isXxxAvailable 是单行函数体 `return true`，需专用正则（多行体的 availRe 匹配不到）。
2. **__filename vs import.meta.url**：项目已有 `createRequire(__filename)` 既用模式（agent-orchestrator:267、file-preview-service:17），跟随即可；runtime-secret-codec 用 import.meta.url。__filename 在该运行环境可用。
3. **指令抽取先于删除**：systemPromptAppend 在 ChatToolMeta 内，删除前先抽到 ma-tool-prompts.ts，防数据丢失。
4. **index.ts 清理正则**：`[A-Z]+_TOOL_META` 匹配不到带下划线的 `STRATEGY_IQ_TOOL_META`，需 `[A-Z][A-Za-z0-9_]*_TOOL_META`。
