# Agent Runtime 系统配置能力差异矩阵（Pi vs Proma vs AI SDK vs Claude）

> 更新于 2026-08-01（第五轮：纳入 P0-2/3/4 统一命令菜单/引用体系/统一 Files、思考默认收起；确认 collaboration 四 runtime 对齐；Proma/AI SDK 上下文压缩自研落地）。 基于 `apps/electron/src/main/lib/` 源码梳理，参考 `~/LLM/Proma` 上游（v0.16.5）实现。 核心结论：**权限、Plan、AskUser、Goal、SubAgent、MCP、Collaboration、WebSearch/WebFetch、WebBridge/ComputerUse、代理、记忆、上下文压缩 四大 runtime 已全部对齐**； 剩余差异：Skills 接入 Proma/AI SDK、流式期间追加输入、Pi 思考模式 thinkingLevel 配置入口。 输入交互层已统一：`/` 命令菜单（Skill/MCP/会话/文件/附件）、`@` 文件、`#` MCP、`&` 会话、`～` 待办/日程（P0-1 预留）、统一文件搜索 FileSearchBar 均为四 runtime 共享的 renderer 能力，不构成 runtime 差异。

## 一、工具能力（是否注册/可用）

| 能力 | Pi | Proma (provider-agnostic) | AI SDK | Claude |
| --- | --- | --- | --- | --- |
| Read/Write/Edit/Grep/Bash | ✅（Pi 经 Proma Bridge，禁用内置） | ✅ createCoreTools | ✅ | ✅ SDK 原生 |
| WebSearch / WebFetch | ✅（`pi-tool-bridge` 注册，双后端 Tavily/MetaSo） | ✅ createCoreTools | ✅ | ✅ SDK |
| RecallMemory / AddMemory | ✅（`pi-tool-bridge` 注册，`memory: true`） | ✅ createCoreTools | ✅ | ✅ SDK/Chat 模式（snake_case 名） |
| WebBridge / ComputerUse | ✅（`PI_RUNTIME_TOOL_CAPABILITIES.webBridge/computerUse` 开关） | ✅ | ✅ | ✅ |
| MCP | ✅ 经 Proma bridge | ✅ | ✅ | ✅ |
| Collaboration（协作子会话） | ✅ `buildPiCollaborationTools`（pi-agent-adapter） | ✅ `extraTools` 注入（agent-orchestrator runProviderAgnosticAgent） | ✅ `extraTools` 注入（ai-sdk-agent-adapter） | ✅ `injectAgentCollaborationMcpServer`（agent-orchestrator sendMessage） |
| Skills | ✅（`workspaceSkillsDir → additionalSkillPaths`） | ❌ **无** | ❌ **无** | ✅ SDK 原生 |
| Plan / AskUser / Goal / SubAgent | ✅ 全部（SubAgent 委托 Proma 实现） | ✅ | ✅ | ✅ |
| Agent 任务（tasks） | `tasks: false`（Pi 内置未启用） | — | — | — |

> Collaboration 注入条件（四 runtime 一致，`agent-orchestrator` 统一判断）： 绑定项目的主会话（`workspaceId` 存在）且非子会话（`!isDelegationSession`，即 `triggeredBy ≠ delegation` 且 `delegationDepth = 0`）。

## 二、系统配置能力差异（重点）

| 系统配置 | Pi | Proma | AI SDK | Claude | 说明 |
| --- | --- | --- | --- | --- | --- |
| **代理设置** | ✅ **已补齐**（`registerPiModelFromChannel` 读 `getEffectiveProxyUrl()`，经 `ModelRuntime.create({ env: { HTTPS_PROXY, HTTP_PROXY } })` 传入 Pi provider） | ✅ `getEffectiveProxyUrl`+`getFetchFn` | ✅ 同 Proma | ✅ `HTTPS_PROXY/HTTP_PROXY` env | 此外 WebSearch/WebFetch/记忆请求（memos-client）已统一走 `getFetchFn(proxyUrl)`，跟随代理设置 |
| **记忆系统** | ✅ **已补齐**（RecallMemory/AddMemory 经 Bridge + 提示词指引） | ✅ **已补齐**（createCoreTools + `AUTOMATION_TOOL_GUIDE` 记忆指引） | ✅ 同 Proma | ✅ `buildSystemPrompt(memoryEnabled)` 注入指引 | 凭据统一 `~/.proma/memory.json`（`getMemoryConfig`）；RecallMemory 加入 SAFE_TOOLS/safe/plan 白名单（只读免审批），AddMemory 走审批 |
| **思考/推理模式** | ✅ **API 已补齐**（`AgentThinkingLevel` 类型 + `PiAgentQueryOptions.thinkingLevel`，缺省 off，仅 reasoning 模型生效；UI thinkingLevel 配置入口待办） | ⚠️ 依赖 provider（DeepSeek 等有 reasoning） | ⚠️ 同 Proma | ✅ 可配 `ThinkingConfig` | proma-mit 的 Pi 走 openai-completions/anthropic-messages，thinkingLevel 直接传 Pi SDK，无需上游 openai-responses extension；**展示层思考块已默认收起**（ThinkingBlock 默认折叠 + 移除「展开思考」全局偏好开关，2026-08-01） |
| **上下文压缩** | ✅ **已补齐**（借鉴上游 #1246：`compaction: { enabled: true, reserveTokens }` 80% 阈值自动压缩 + `CompactContext` 工具手动压缩 + compaction_start/end 事件投影 + 压缩后自动续跑，上限 20 次） | ✅ **已补齐（自研）**：`context-compaction.ts` 自动压缩（历史条数 > 阈值时 LLM 摘要早期历史 + 保留最近 20 条 + 持久化 compact_boundary）+ `CompactContext` 工具（adapter 拦截立即压缩，下一轮生效） | ✅ 同 Proma | ✅ SDK 原生 | Pi 走 SDK 原生 `session.compact()`；Proma/AI SDK 自研 LLM 摘要（复用 @proma/core ProviderAdapter），阈值/保留数可配（默认 40/20）；`compact_boundary` 消息类型已支持 |
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
- **Collaboration（协作子会话）**：四 runtime 注入条件一致（主会话 + 非子会话）；父会话可创建真实可见、可追溯、可继续交互的子 Agent 会话；子会话不注入协作工具（防止递归委派）
- **引用体系（统一命令菜单）**：`/` 命令菜单（Skill/MCP/会话/文件/添加附件/附加文件夹 + 子页搜索，`agent-command-suggestion.tsx`）、`@` 文件、`#` MCP、`&` 会话、`～` 待办/日程（referenceType 协议预留，P0-1 接入）；legacy 前缀与命令菜单并存，历史草稿按节点自身 `mentionSuggestionChar` 渲染（`mention-utils.ts`）
- **会话跨工作区引用搜索**：`searchAgentSessionReferences` 支持 `workspaceId` 可选（不传时跨全部工作区），结果附带 `workspaceName`/`workspaceSlug` 供命令菜单描述展示（2026-08-01 扩展）
- **统一文件搜索**：FileSearchBar 在一个连续列表搜索会话文件 + 项目文件，结果带来源徽标（会话文件/项目文件），点击经 `fileBrowserAutoRevealAtom` 自动定位到 FileBrowser；会话附加文件可「移入项目文件」（`moveAttachedFile` + detach）
- **附件**：`enrichMessageWithDocuments` 富化（文档→文本、图片→base64）
- **WebSearch/WebFetch 凭据**：共享 `~/.proma/chat-tools.json` 的 `web-search`；`WebSearch` 支持双后端：Tavily（`apiKey`）与 MetaSo（`metasoApiKey`，Bearer，`provider: 'metaso'` 或只配 metasoApiKey 时自动选用）
- **记忆凭据**：共享 `~/.proma/memory.json`（`getMemoryConfig`，Chat + Agent 共用）
- **网络请求代理**：WebSearch/WebFetch/记忆请求 统一走 `getFetchFn(getEffectiveProxyUrl())`

## 四、关键文件索引

| Runtime | Adapter | 工具桥/注册 | 系统提示词 |
| --- | --- | --- | --- |
| Pi | `adapters/pi-agent-adapter.ts`（含上下文压缩/CompactContext/thinkingLevel/collaboration） | `adapters/pi-tool-bridge.ts`（`PI_RUNTIME_TOOL_CAPABILITIES`）+ `adapters/pi-model-registry.ts`（代理）+ `packages/shared/src/utils/pi-compaction.ts`（压缩阈值） | `systemPromptOverride`（`<pi_proma_tools>`，含网页/记忆规则） |
| Proma | `adapters/provider-agnostic-agent-adapter.ts` | `agent-runtime/tool-registry.ts`（`createCoreTools`）+ `extraTools`（collaboration） | `buildAgentSystemPrompt`（`AUTOMATION_TOOL_GUIDE`，含网页/记忆规则） |
| AI SDK | `adapters/ai-sdk-agent-adapter.ts` + `agent-runtime/ai-sdk-runtime-core.ts` | 同上 createCoreTools + `extraTools`（collaboration） | 同上 |
| Claude | `adapters/claude-agent-adapter.ts` | SDK 原生 + `agent-prompt-builder.ts` + `injectAgentCollaborationMcpServer` | claude_code preset + `buildSystemPrompt`（含记忆/协作指引） |
| 协作子会话 | `lib/agent-collaboration-tools.ts`（工具构建/MCP 注入）、`lib/agent-collaboration-utils.ts`、`lib/agent-headless-runner-registry.ts`、`lib/agent-model-selection.ts`；会话元数据：`parentSessionId/rootSessionId/sourceDelegationId/delegationRole/Status/Depth/Goal` |  |  |

## 五、待办/建议

- [ ] Skills 接入 Proma/AI SDK（目前仅 Pi/Claude 支持；需要 skill 发现 + 注入机制 + 受限读取工具 + 安全边界，独立设计，上游无现成方案）

- [ ] 流式期间用户追加输入接入 Pi/Proma（当前仅 AI SDK/Claude 支持；Pi SDK 支持 `streamingBehavior`，需 orchestrator 层队列改造）

- [ ] Pi 思考模式 thinkingLevel 配置入口（adapter API 已就绪；需在 Agent 设置/会话配置中暴露 thinkingLevel 选择器；展示层思考块已默认收起，需展开时点「展开思考」）