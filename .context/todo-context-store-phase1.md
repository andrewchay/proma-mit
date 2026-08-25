# Phase 1 & 2 & 接入实施 TODO

## Phase 1: 存储层强化 ✅
- P1.1 迁移校验升级 ✅
- P1.2 显式事务包装 ✅
- P1.3 存储引擎评估 ✅（保持 sql.js）
- P1.4 Repository 模式 ✅

## Phase 2: 召回层升级 ✅
- P2.1 Bigram 分词 + 两档召回 ✅
- P2.2 RRF 多路融合框架 ✅

## 接入 Proma 运行时 ✅
- S1: context-store 工作区隔离支持 ✅
- S2: ContextStoreService ✅
- S3: 自动写入（消息索引）✅
- S4: DynamicContext 增强（自动注入）✅
- S5: 配置集成 ✅
  - `settings.ts`: `localContextStore?: { enabled: boolean }`
  - 设置面板 UI：`LocalContextStoreSettings.tsx` 新增「本地上下文存储」开关
  - 嵌入 ToolSettings（位于云端记忆 MemorySettings 下方）
  - 默认启用，可开关，随 Agent 生效
- S6: `local_context_recall` MCP 工具（Agent 主动召回工作区历史）✅
  - `agent-orchestrator.ts` 新增 `injectLocalContextTools`（仿 injectMemoryTools）
  - MCP server: `local_context`，工具 `local_context_recall`
  - 返回带序号+时间+内容摘要的召回结果，带放宽匹配提示
  - 系统提示词新增「本地上下文存储」指引 section
  - 受 `localContextStore.enabled` 控制（默认启用，绑定工作区）

## 验证 ✅
- context-store 包测试：53 pass
- ContextStoreService 测试：4 pass
- apps/electron typecheck: exit 0
- 设置面板 UI 已接入（LocalContextStoreSettings）
