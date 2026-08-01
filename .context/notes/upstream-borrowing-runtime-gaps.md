# 上游 Proma 借鉴方案：补齐 Pi/Proma 剩余能力差异

> 更新于 2026-08-01。参考 `~/LLM/Proma`（上游 v0.16.5）实现。
> 前提：proma-mit 与上游使用同一 Pi SDK（`@earendil-works/pi-coding-agent 0.82.1`），
> `session.compact()`、`thinkingLevel`、`skillsOverride`、`streamingBehavior` 全部支持，方案可直接落地。

## 一、Pi 上下文压缩（上游 #1246，最成熟）

### 上游实现
- `packages/shared/src/utils/pi-compaction.ts`：
  - `PI_AUTO_COMPACTION_THRESHOLD_RATIO = 0.8`（达到模型窗口约 80% 时触发）
  - `calculatePiAutoCompactionReserveTokens(contextWindow)` = `ceil(contextWindow * (1 - 0.8))`
  - `calculatePiAutoCompactionThresholdTokens(contextWindow)` = `contextWindow - reserveTokens`
- `pi-agent-adapter.ts`：
  - `compaction: { enabled: true, reserveTokens }`（SettingsManager.inMemory）
  - `buildCurrentSessionCompactionTool()`：注册 `CompactContext` 工具（手动压缩），
    触发 `session.compact()`，经 canUseTool 权限流程；空转检测 `/nothing to compact|already compacted/i`
  - compaction 事件投影：`compaction_start → system(compacting)`、`compaction_end → system(compact_boundary)`（带 estimatedTokensAfter）
  - `PI_COMPACTION_CONTINUATION_PROMPT`：压缩完成后自动继续原任务（防止模型在压缩后结束回答）

### proma-mit 落地
1. 新增 `packages/shared/src/utils/pi-compaction.ts`（复制阈值计算）
2. `pi-agent-adapter.ts`：
   - `compaction: { enabled: true, reserveTokens }`（contextWindow 来自 `pi-model-registry` 注册的 200_000 / 实际模型）
   - 注册 `CompactContext` 工具（复用现有 `createBridgeTool` 结构或直接注册）
   - subscribe 分支处理 `compaction_start / compaction_end`，投影为 SDK system 消息
   - 消息类型已支持 `compacting` / `compact_boundary`（无需新增类型）
3. 测试：阈值计算单测 + adapter 事件投影测试

## 二、Pi 思考模式（上游 #1201 会话级推理控制）

### 上游实现
- `packages/shared/src/types/agent.ts`：`AgentThinkingLevel = 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'`
- `packages/shared/src/types/reasoning-profile.ts`：`ReasoningProfile`（按模型 ID + transport 匹配）、
  `ReasoningEncoding`（openai-reasoning-effort / zai-thinking-effort / adaptive-effort）、`inferReasoningTransport`
- `adapters/pi-openai-reasoning-request-settings.ts`：`createOpenAIReasoningRequestExtension` 通过
  Pi ExtensionAPI `before_provider_request` 钩子注入 `reasoning.effort`
- `pi-agent-adapter.ts`：`thinkingLevel: input.thinkingLevel ?? 'off'`；仅 `model.reasoning` 时挂 extension

### proma-mit 落地
1. `packages/shared/src/types/agent.ts` 加 `AgentThinkingLevel`
2. 新增 `reasoning-profile.ts`（精简版：openai-responses / openai-completions 的 effort 注入）
3. 新增 `pi-openai-reasoning-request-settings.ts`（before_provider_request 注入）
4. `pi-agent-adapter.ts`：`PiAgentQueryOptions.thinkingLevel`，`input.thinkingLevel ?? 'off'`
5. 模型 `reasoning: true`（pi-model-registry 已注册）时才挂 extension
6. UI 层思考级别选择器（后续，AgentView / 设置）

## 三、Pi 流式期间追加输入（上游 sendMessage 队列）

### 上游实现
- `session.prompt(msg, { streamingBehavior: 'steer' | 'followUp' })`：流式中队列消息
  （steer 打断当前流、followUp 等当前轮结束）
- orchestrator 的 `SendQueuedMessageOptions`：将运行中追加的 user 消息转入 Pi 队列

### proma-mit 落地评估
- Pi SDK 支持 `streamingBehavior`，但需要 orchestrator 层在 Pi 会话运行期间接收新 user 消息
  并调用 `session.prompt(..., { streamingBehavior })`——涉及 sendMessage 的并发分支，改动较大。
- 建议：与 AI SDK runtime 的 while 循环追加对齐后实施；本次保留待办。

## 四、Skills 接入 Proma/AI SDK（无上游方案，需自研）

### 现状
- 上游没有 provider-agnostic / ai-sdk adapter（proma-mit 自研），skills 在上游只走 Pi/Claude runtime。
- proma-mit 已有 `getWorkspaceSkills(workspaceSlug)` 扫描能力（agent-workspace-manager.ts）。

### 自研方案（基础版）
1. `createCoreTools()` 注册 `ReadSkill` 工具（只读工作区 skills 目录文件，路径受限）
2. 在 runtime 组装时把工作区 skill 列表（slug + description）注入 system prompt：
   `buildAgentSystemPrompt(systemPrompt, cwd)` 增加可选 `skills` 参数
3. `provider-agnostic-agent-adapter.ts` / `ai-sdk-agent-adapter.ts` 从 workspace 读取 skills 传入
4. 安全边界：ReadSkill 只允许读取 skills 目录内路径
- 风险：模型触发效果依赖提示词；skill 描述不准确时可能不触发。属独立功能设计。

## 五、实施状态

| 项 | 上游方案 | 状态 | 说明 |
|----|---------|------|------|
| Pi 上下文压缩 | ✅ 成熟 | ✅ **已实施** | `pi-compaction.ts` 阈值 + adapter compaction 开启 + CompactContext 工具 + 事件投影 + 续跑 |
| Pi 思考模式 | ✅ 成熟 | ✅ **已实施（API 层）** | `AgentThinkingLevel` + `thinkingLevel` 传入 Pi SDK；UI/配置入口待接入 |
| Pi 流式追加 | ✅ 成熟 | ⏸ 保留待办 | Pi SDK 支持 `streamingBehavior`，需 orchestrator 层队列改造 |
| Skills 接入 Proma/AI SDK | ❌ 需自研 | ⏸ 保留待办 | 独立设计（ReadSkill 工具 + skills 列表注入 + 安全边界） |
