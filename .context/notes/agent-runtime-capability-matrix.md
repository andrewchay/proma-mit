# Agent Runtime 系统配置能力差异矩阵（Pi vs Proma vs AI SDK vs Claude）

> 更新于 2026-08-01（第二轮补齐：代理 + 记忆）。基于 `apps/electron/src/main/lib/` 源码梳理。
> 核心结论：**权限、Plan、AskUser、Goal、SubAgent、MCP、WebSearch/WebFetch、WebBridge/ComputerUse、代理、记忆 四大 runtime 已全部对齐**；
> 剩余差异：Skills、思考模式、上下文压缩、流式期间追加输入。

## 一、工具能力（是否注册/可用）

| 能力 | Pi | Proma (provider-agnostic) | AI SDK | Claude |
|------|----|---------------------------|--------|--------|
| Read/Write/Edit/Grep/Bash | ✅（Pi 经 Proma Bridge，禁用内置） | ✅ createCoreTools | ✅ | ✅ SDK 原生 |
| WebSearch / WebFetch | ✅（`pi-tool-bridge` 注册） | ✅ createCoreTools | ✅ | ✅ SDK |
| RecallMemory / AddMemory | ✅（`pi-tool-bridge` 注册，`memory: true`） | ✅ createCoreTools | ✅ | ✅ SDK/Chat 模式（snake_case 名） |
| WebBridge / ComputerUse | ✅（`PI_RUNTIME_TOOL_CAPABILITIES.webBridge/computerUse` 开关） | ✅ | ✅ | ✅ |
| MCP | ✅ 经 Proma bridge | ✅ | ✅ | ✅ |
| Skills | ✅（`workspaceSkillsDir → additionalSkillPaths`） | ❌ **无** | ❌ **无** | ✅ SDK 原生 |
| Plan / AskUser / Goal / SubAgent | ✅ 全部（SubAgent 委托 Proma 实现） | ✅ | ✅ | ✅ |
| Agent 任务（tasks） | `tasks: false`（Pi 内置未启用） | — | — | — |

## 二、系统配置能力差异（重点）

| 系统配置 | Pi | Proma | AI SDK | Claude | 说明 |
|----------|----|-------|--------|--------|------|
| **代理设置** | ✅ **已补齐**（`registerPiModelFromChannel` 读 `getEffectiveProxyUrl()`，经 `ModelRuntime.create({ env: { HTTPS_PROXY, HTTP_PROXY } })` 传入 Pi provider） | ✅ `getEffectiveProxyUrl`+`getFetchFn` | ✅ 同 Proma | ✅ `HTTPS_PROXY/HTTP_PROXY` env | 此外 WebSearch/WebFetch/记忆请求（memos-client）已统一走 `getFetchFn(proxyUrl)`，跟随代理设置 |
| **记忆系统** | ✅ **已补齐**（RecallMemory/AddMemory 经 Bridge + 提示词指引） | ✅ **已补齐**（createCoreTools + `AUTOMATION_TOOL_GUIDE` 记忆指引） | ✅ 同 Proma | ✅ `buildSystemPrompt(memoryEnabled)` 注入指引 | 凭据统一 `~/.proma/memory.json`（`getMemoryConfig`）；RecallMemory 加入 SAFE_TOOLS/safe/plan 白名单（只读免审批），AddMemory 走审批 |
| **思考/推理模式** | ❌ 固定 `thinkingLevel: 'off'` | ⚠️ 依赖 provider（DeepSeek 等有 reasoning） | ⚠️ 同 Proma | ✅ 可配 `ThinkingConfig` | Pi 目前无法开启思考模式 |
| **上下文压缩** | ❌ 显式关闭 `compaction: { enabled: false }` | ❌ 无压缩（全量历史） | ❌ 同 Proma | ✅ SDK 原生 | Pi 的 compaction 是关闭的，长会话上下文无自动压缩 |
| **流式期间用户追加输入** | ❌ 每次新 prompt | ❌ 单次 query 内 maxTurns 循环 | ✅ while 循环支持追加 | ✅ SDK 多 turn | AI SDK 支持输出期间继续追问 |
| **重试策略** | ✅ Pi 内部 `retry: { enabled: true, maxRetries: 2 }` | ✅ `withRetry` 网络错误重试 2 次 | ✅ 同 Proma | ✅ SDK | 两者重试语义独立，但都有 |
| **Token 用量统计** | ⚠️ Pi 消息自带 usage | ✅ 汇总 input/output/cache | ✅ 同 Proma | ✅ SDK | Proma/AI SDK 会累加每轮 usage |
| **图片/截图进上下文** | ✅ `images: { blockImages: false }` | ✅ | ✅ | ✅ | Pi 必须保持 false，否则 WebBridge/ComputerUse 截图会被丢弃 |
| **模型注册** | 特殊：`registerPiModelFromChannel` 临时注册到 Pi ModelRuntime（contextWindow 200k，`allowModelNetwork: false`） | 直接走 `@proma/core` ProviderAdapter | 同 Proma | SDK CLI | Pi 的模型网络被关闭，所有工具走 Proma Bridge |

## 三、共用能力（四大 runtime 一致）

- **权限模式**：共用 `AgentPermissionService`（auto/safe/plan/bypass + 会话白名单 + WebBridge/ComputerUse 逐次确认）；只读工具白名单含 `RecallMemory`
- **会话持久化**：共用 `agent-session-manager`（append/get/truncate SDKMessage）
- **Plan 模式**：`EnterPlanMode`/`ExitPlanMode` + 本地兜底白名单
- **AskUser / GoalCheckpoint / SubAgent**：回调注入方式一致
- **附件**：`enrichMessageWithDocuments` 富化（文档→文本、图片→base64）
- **WebSearch/WebFetch 凭据**：共享 `~/.proma/chat-tools.json` 的 `web-search`；`WebSearch` 支持双后端：Tavily（`apiKey`）与 MetaSo（`metasoApiKey`，Bearer，`provider: 'metaso'` 或只配 metasoApiKey 时自动选用）
- **记忆凭据**：共享 `~/.proma/memory.json`（`getMemoryConfig`，Chat + Agent 共用）
- **网络请求代理**：WebSearch/WebFetch/记忆请求 统一走 `getFetchFn(getEffectiveProxyUrl())`

## 四、关键文件索引

| Runtime | Adapter | 工具桥/注册 | 系统提示词 |
|---------|---------|------------|-----------|
| Pi | `adapters/pi-agent-adapter.ts` | `adapters/pi-tool-bridge.ts`（`PI_RUNTIME_TOOL_CAPABILITIES`）+ `adapters/pi-model-registry.ts`（代理） | `systemPromptOverride`（`<pi_proma_tools>`，含网页/记忆规则） |
| Proma | `adapters/provider-agnostic-agent-adapter.ts` | `agent-runtime/tool-registry.ts`（`createCoreTools`） | `buildAgentSystemPrompt`（`AUTOMATION_TOOL_GUIDE`，含网页/记忆规则） |
| AI SDK | `adapters/ai-sdk-agent-adapter.ts` + `agent-runtime/ai-sdk-runtime-core.ts` | 同上 createCoreTools | 同上 |
| Claude | `adapters/claude-agent-adapter.ts` | SDK 原生 + `agent-prompt-builder.ts` | claude_code preset + `buildSystemPrompt`（含记忆） |

## 五、待办/建议

- [ ] Skills 接入 Proma/AI SDK（目前仅 Pi/Claude 支持；需要 skill 发现 + 注入机制 + 受限读取工具 + 安全边界，独立设计）
- [ ] Pi 思考模式支持（`thinkingLevel: 'off'` 目前固定，Pi 模型注册已有 `thinkingLevelMap` 基础）
- [ ] 上下文压缩（Proma/AI SDK 全量历史、Pi compaction 关闭；需自动摘要机制）
- [ ] 流式期间用户追加输入接入 Pi/Proma（当前仅 AI SDK/Claude 支持）
