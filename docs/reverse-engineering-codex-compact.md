# 逆向拆解：Codex 的 Context Window Compact 机制

> 调研日期：2026-11-17
> 方法：REA 原生二进制分析（符号表 + 只读数据段取证）× 同版本开源源码交叉验证
> 目标产物：`/opt/homebrew/Caskroom/codex/0.162.1/bin/codex`（Mach-O arm64，符号表完整）
> 源码对照：`github.com/openai/codex` `codex-rs/core/src/`（main 分支，与 0.162.1 符号一一对应）
> 目的：弄清 Codex 如何在长会话中做上下文压缩，为 Gravitas 自己的 context 管理设计提供参考。

## 0. 结论速览

Codex 的 context compact 是一套**"交接式压缩"（handoff compaction）**系统：

- **三套实现按 provider 能力自动选择**：本地模型自总结（默认）、服务端远程压缩 V2、纯 token 预算重置（不发模型请求）；
- **触发 = 三原因 × 三阶段**：预算/窗口超限、换模型（哈希变化或降窗口）、手动 `/compact`；在回合前、回合中、回合后都可能发生，回合中压缩不打断任务；
- **压缩产物不是"摘要+空白"**：交接摘要（伪装成另一个模型的产出）+ 最近 20k token 真实用户消息原文 + 重新注入的世界状态 + 窗口记账（支持回放/恢复）；
- **四层兜底**：压缩请求超限从头 trim 重试 → 流式退避重试 → 换模型重试 → 最后由模型自己写检查点并调用 `new_context` 转身；
- **全程可观测、可干预**：PreCompact/PostCompact hooks 可中止，analytics 记录触发原因/阶段/压缩前后 token 数/耗时。

---

## 1. 调研方法与证据

### 1.1 REA 取证（本地二进制）

```bash
# 符号表定位（二进制含完整 Rust 符号，nm 可用）
nm /opt/homebrew/Caskroom/codex/0.162.1/bin/codex | c++filt | grep -i compact

# 只读数据段提取配置默认值与提示词片段
strings -a bin/codex | grep -E "auto_compact_fallback|compact_prompt"
```

关键符号（节选）：

```
codex_core::compact::build_compacted_history                  本地压缩历史重建
codex_core::compact::assemble_compaction_history              组装替换历史
codex_core::compact::content_items_to_text
codex_core::compact::run_compact_task_inner_impl              本地压缩主流程
codex_core::compact_remote_v2::build_v2_compacted_history     远程压缩 V2
codex_core::compact_remote_v2::attempt::run_remote_compact_v2_attempt
codex_core::compact_remote_history::trim_function_call_history_to_fit_context_window
codex_core::compact_token_budget::{run_manual,run_inline_auto}_compact_task  纯重置
codex_core::compact_model_fallback::{record_model_fallback,should_retry_with_current_model}
codex_core::session::turn::{run_auto_compact,run_pre_sampling_compact}
codex_core::guardian::input_budget::should_compact            Guardian 预算守卫
codex_core::state::session::SessionState::{start_new_context_window,new_with_auto_compact_window_ids}
codex_core::session::rollout_reconstruction::reconstructed_window_from_compaction
codex_core::tools::handlers::new_context_window::NewContextWindowHandler   模型自助转身工具
codex_hooks::events::compact::{pre,post}_command_input_json   压缩 hooks
```

内嵌配置默认值（strings 提取）：

```json
"auto_compact_token_limit": null,
"auto_compact_fallback_buffer_tokens": 16384,
"auto_compact_fallback_prompt": "<context_window_reminder>\nThe current context window is exhausted. Do not continue the task or give a final answer in this window. ... Make exactly one write or append call to `notes` now to save a concise checkpoint ... After the notes result returns, call `functions.new_context`; do not use any tools other than `notes` and `functions.new_context`.\n</context_window_reminder>",
"max_parent_compaction_tokens": null,
"reuse_parent_compaction": null
```

### 1.2 源码交叉验证

REA 反编译 provider（Ghidra/Hopper/IDA）本机未配置，函数级语义以 `openai/codex` 仓库 main 分支源码为准（与本地 0.162.1 二进制符号逐一对应，如 `compact.rs` 中的 `build_compacted_history` 与符号表完全一致）。主要文件：

| 文件 | 作用 |
|---|---|
| `codex-rs/core/src/compact.rs`（993 行） | 本地压缩主流程与历史重建 |
| `codex-rs/core/src/tasks/compact.rs` | `/compact` 任务入口、实现选择 |
| `codex-rs/core/src/compact_token_budget.rs` | 纯重置（无模型请求） |
| `codex-rs/core/src/compact_remote_v2.rs`（1685 行） | 远程压缩 V2 |
| `codex-rs/core/src/compact_model_fallback.rs` | 压缩模型回退 |
| `codex-rs/core/src/session/turn.rs`（3905 行） | 自动压缩触发逻辑 |
| `codex-rs/core/src/session/context_window.rs` | 阈值计算 |
| `codex-rs/prompts/templates/compact/{prompt,summary_prefix}.md` | 压缩提示词模板 |

### 1.3 证据文件索引（本工作区）

| 证据 | 路径 |
|---|---|
| 拉取的源码副本 | `.tmp/codex-src/`（compact.rs、session_turn.rs、context_window.rs、compact-prompt.md、summary-prefix.md 等 15 个文件） |
| REA 工具链 | `~/.npm/_npx/9b9809298fe40d2c/node_modules/rea-agents`（v6.4.0） |
| 字符串转储 | 会话任务输出 `bash-8qdpqhoi/output.log`、`bash-sze83dle/output.log` |

---

## 2. 三套实现的选择逻辑

`tasks/compact.rs` 是统一入口，所有路径共享同一个压缩生命周期（PreCompact hooks → ContextCompaction turn item → PostCompact hooks → analytics）：

```
/compact 或自动触发
        │
        ▼
Feature::TokenBudget 开启? ──是──► 纯重置：start_new_context_window()（零模型请求）
        │否
        ▼
provider.capabilities.remote_compaction == V2?
        ├─ 是 ──► 远程压缩 V2（服务端总结，客户端安装结果）
        │            compact_remote_v2::run_remote_compact_task
        └─ 否 ──► 本地压缩：发 SUMMARIZATION_PROMPT 让模型总结
                     compact::run_compact_task
```

要点：**"压缩"被建模成一种生命周期而不是一个函数**——即使纯重置不发模型请求，也走 hooks、turn item、analytics 同一套，外部观察者可统一处理。

## 3. 触发机制：三原因 × 三阶段

### 3.1 触发原因（CompactionReason）

| 原因 | 说明 |
|---|---|
| `ContextLimit` | 达到 auto-compact 预算或完整上下文窗口 |
| `CompHashChanged` | 上一轮到本轮模型的"压缩兼容性哈希"变化（提示词/工具集结构变化） |
| `ModelDownshift` | 换到上下文窗口更小的模型 |
| `UserRequested` | 手动 `/compact` |

### 3.2 触发阶段（CompactionPhase）

| 阶段 | 位置 | 行为 |
|---|---|---|
| `PreTurn` | `run_pre_sampling_compact`，采样前 | `token_status.token_limit_reached` 为真就先压缩再开工；换模型时也在这里用旧模型总结旧窗口 |
| `MidTurn` | 采样后、有后续工作时 | 达到上限 / 模型请求了 `new_context` / 后台压缩（`async_compaction`）有结果 → 就地压缩后 `continue`，任务不断 |
| `PostTurn` / `StandaloneTurn` | 回合结束 / 手动命令 | 完成后安装摘要 |

### 3.3 阈值计算（`session/context_window.rs`）

- 主阈值：`auto_compact_token_limit`（会话配置）或模型默认值，scope 二选一：
  - `Total`：全量活动 token 计数；
  - `BodyAfterPrefix`：只算本轮窗口前缀之后的增量（跨窗口公平计费）。
- 硬上限：`resolved_context_window × effective_context_window_percent / 100`，与主阈值取小。
- 若配置了 fallback 提示词，额外预留 `auto_compact_fallback_buffer_tokens`（默认 16,384）缓冲，保证兜底路径还能塞进窗口。

## 4. 核心：替换历史的构造（`build_compacted_history_with_limit`）

这是整套机制最值得借鉴的部分。压缩后的新历史**不是"摘要 + 空"**，而是精心装配的接力结构：

1. **生成交接摘要**：把 SUMMARIZATION_PROMPT 作为用户输入发给模型：

   > "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task. Include: current progress and key decisions; important context/constraints/user preferences; what remains to be done; critical data/examples/references. Be concise, structured..."

2. **摘要伪装成"另一个模型的交接"**：摘要前强制拼接 `SUMMARY_PREFIX`：

   > "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used... Here is the summary produced by the other model, use the information in the following text to assist with your own analysis:"

   让下一个窗口把摘要当作**同事的工作交接**而非自己的记忆，避免"我做过这个吗"的身份混淆。

3. **保留最近真实用户消息原文**：从最新往回，原样保留至多 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` token 的用户消息；超出的保留消息信封但**文本按剩余预算截断、图片/音频丢弃**（`mark_retained_sources_incomplete` 标记来源不完整）。

4. **不可丢项保留**：`retained_client_items`（always-retained）原样保留；进行中的用户来信（pending mail / steering）按序插在摘要两侧，保证送达且不重复。

5. **世界状态重新注入**：初始上下文（系统提示、环境信息、工具声明等）以当前会话为准重新渲染，插在"最后一个真实用户消息或摘要之前"的模型预期边界（`insert_initial_context_before_last_real_user_or_summary`）——保证前缀缓存友好且结构可预期。

6. **窗口记账**：`advance_auto_compact_window` 递增窗口号；rollout 中写 `auto-compact-<id>` 检查点（含窗口号、输入 goal id 集合、摘要文本、压缩响应 id、模型哈希）；恢复/回放时由检查点重建窗口（`reconstructed_window_from_compaction`），压缩点成为可重放的边界。

## 5. 失败兜底（四层，逐层降级）

| 层 | 条件 | 动作 |
|---|---|---|
| 1 | 压缩请求本身返回 `ContextWindowExceeded` | 删掉最老一条历史从头重试——**刻意从头 trim** 以保住前缀 prompt cache；删到只剩一条仍失败才放弃 |
| 2 | 流式中断 | 按 provider 退避重连（`stream_max_retries`） |
| 3 | 总结模型不可用/报错 | `compact_model_fallback`：换当前模型重试并记录回退事件 |
| 4 | 以上全失败 | 注入 `auto_compact_fallback_prompt`（`<context_window_reminder>`）：命令模型"**立刻用 `notes` 工具写检查点**（目标、决策、进度、经验教训、下一步、仍在处理的用户请求的 window/item ID、关键工具调用），然后调用 `functions.new_context`"——由模型自己完成交接并转身。`NewContextWindowHandler` 工具消费该请求，`take_new_context_window_request` 触发 rollover |

## 6. 可观测性与干预点

- **Hooks**：`PreCompact` / `PostCompact` 事件带 `command.input/output`，hook 可中止压缩（`TurnAborted`）；
- **Analytics**：每次压缩记录 trigger/reason/implementation/phase/strategy（`Memento`）/status、压缩前后活动 token、cached/cache-write token、耗时、错误类别（含用量限制窗口）；
- **模型侧契约**：系统提示明确告知压缩行为——"When you run out of context, the conversation is automatically compacted into a summary... **Compaction does not end the task**. Continue naturally from the summarized state... treat work spanning compactions as one logical chain of events."——跨压缩的工作连续性由提示词契约保证。

## 7. 对 Gravitas 的参考价值

| Codex 机制 | Gravitas 可借鉴点 |
|---|---|
| 摘要伪装成"另一模型的交接"（SUMMARY_PREFIX） | Gravitas 会话压缩/上下文分割时，摘要不要以"系统总结"身份注入，伪装成交接可显著降低模型混淆 |
| 最近 20k token 用户消息原文保留 + 旧消息截断而非删除 | `conversation-manager.ts` 的上下文分割策略可引入"保留窗口 + 截断降级"两级，而不是硬切断 |
| 压缩作为生命周期（hooks + turn item + analytics 统一） | Owner 任务的每个治理动作（compact/replan/rework）都应有统一生命周期事件，便于审计与 UI 呈现 |
| 窗口记账 + 检查点可回放（rollout `auto-compact-<id>`） | `agent-sessions/*.jsonl` 可引入压缩检查点记录，支持从压缩点恢复与成本核算 |
| 四层兜底，最后一层是"模型自己写检查点转身" | 自动重试链的终点不应是"停机等人"，而是给一个模型可执行的自救路径 |
| BodyAfterPrefix scope（只算前缀后增量） | 长会话按窗口增量计费/限预算，避免前缀重复计费导致过早压缩 |

## 8. 局限性说明

- 函数级语义来自 main 分支源码，与本地 0.162.1 存在版本差（符号集完全对应，个别分支逻辑可能有出入）；
- REA 反编译 provider（Ghidra/Hopper/IDA）本机未配置，未做指令级验证；如需函数级反编译可安装 Ghidra 后重跑 `rea function <path> <symbol>`；
- 远程压缩 V2 的服务端语义只能从客户端安装逻辑推断。
