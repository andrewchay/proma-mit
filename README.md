# Proma

Proma 是一个本地优先的 AI 桌面应用，把多模型 Chat、通用 Agent、工作区、Skills、MCP、远程机器人和记忆能力放在同一个开源客户端里。

它不是只面向闲聊的聊天框，而是一个可以长期沉淀个人工作流的 Agent 工作台：简单问题用 Chat，复杂任务交给 Agent，数据和配置尽量留在本地。

![Proma 海报](https://img.erlich.fun/personal-blog/uPic/pb.png)

<video width="560" controls>
  <source src="https://img.erlich.fun/personal-blog/uPic/%E7%AE%80%E5%8D%95%E4%BB%8B%E7%BB%8D%20Proma.mp4" type="video/mp4">
</video>

[English README](./README.en.md) | [新手教程](./tutorial/tutorial.md) | [下载开源版](https://github.com/ErlichLiu/Proma/releases) | [下载商业版](https://proma.cool/download)

> **最新思考 ｜ 2026 Q2–Q3**：[勇敢地解决真实的问题 — Proactive · 个人注意力 · 团队协作](./proma-thinking/proma-2026-q2-q3-thinking.md) ｜ 往期思考：[2026 Q1](./proma-thinking/proma-2026-q1-thinking.md)

## 现在能做什么

- **Chat 模式**：多模型对话、附件解析、图片输入、Markdown / Mermaid / KaTeX / 代码高亮、并排对话、系统提示词、上下文管理。
- **Agent 模式**：支持 Claude、Proma provider-agnostic、AI SDK、Pi 等 runtime，提供隔离工作区或直接打开本地项目、权限模式、文件操作、长任务流式输出、计划确认和用户追问。
- **Web Bridge（P0）**：Proma / AI SDK runtime 可打开独立、可见且隔离的受管浏览器，读取页面与结构化交互元素、截图、滚动、受控下载，并按逐次确认执行导航、Chrome CDP 接入、点击和输入；运行中的 Bridge 会在 Agent 标题栏显示状态并可一键停止，网页不能自行打开未受管窗口。
- **Computer Use（macOS P0）**：Proma / AI SDK runtime 可在用户授权后列出显示器、读取指定屏幕截图、识别前台应用/窗口，并控制鼠标、键盘和滚动；屏幕读取和每一项桌面操作均经过 Agent 权限流程。
- **SubAgent / Tasks**：复杂任务可以通过 Agent 工具拆分为子 Agent / Task，并在消息流中展示调用过程和结果；Proma / AI SDK runtime 已复用同一套核心工具体系。
- **服务端 Web 路线（P0–P5 基础能力）**：提供独立 Bun server、Postgres 多租户 store、WebCrypto secret codec、Redis Stream replay、S3-compatible workspace 文件、跨 worker task lease、优雅关停、本地双实例 E2E、AI SDK usage/cost ledger、预算/限速、追加式审计、运行指标和僵尸任务诊断；生产 OIDC/JWT、KMS 轮换、管理员审计、完整 Web UI 与真实 provider E2E 仍待后续阶段。
- **Skills & MCP**：每个工作区可以独立配置 Skills、MCP Server 和工作区文件，适合沉淀可复用能力。
- **远程机器人**：支持飞书 / Lark 机器人桥接，并已提供钉钉、微信桥接入口，用手机或群聊触发本机 Agent 工作流。
- **记忆与工具**：Chat 和 Agent 可共享记忆能力，并支持联网搜索、内置 Chat 工具、Agent 推荐等辅助能力。
- **本地优先**：会话、工作区、附件、配置、Skills 等默认存储在 `~/.proma/`，使用 JSON / JSONL 文件组织，不依赖本地数据库。
- **桌面体验**：自动更新、代理设置、文件预览、全局快捷键、快速任务窗口、语音输入、亮色 / 暗色 / 跟随系统主题。

## 快速开始

### 下载安装

从 [GitHub Releases](https://github.com/ErlichLiu/Proma/releases) 下载开源版本。当前 release notes 以 `v0.9.12` 为准，提供 macOS Apple Silicon、macOS Intel 和 Windows 安装包。

如果你希望开箱即用、减少 API 配置成本，也可以使用 [Proma 商业版](https://proma.cool/download)。商业版和开源版并行运行，主要区别是商业版提供内置渠道和订阅方案。

### 首次配置

1. 打开 Proma，先完成环境检查。Agent 模式依赖本机基础环境，尤其是 Git、Node.js / Bun 以及可用的 Shell。
2. 进入 **设置 > 渠道**，添加至少一个 AI 供应商渠道，填写 Base URL、API Key 和模型列表。
3. Chat 模式可以使用 OpenAI、Anthropic、Google 或 OpenAI 兼容协议的渠道。
4. Agent 模式默认可使用 Claude / Proma / AI SDK / Pi runtime。Claude runtime 需要 Anthropic 或 Anthropic 兼容协议；AI SDK runtime 支持 OpenAI-compatible 以及 Anthropic、Google provider package。
5. 进入 **设置 > Agent**，选择默认 Agent 渠道、模型和工作区。
6. 如需记忆、联网搜索、飞书 / 钉钉 / 微信桥接，在设置页对应 Tab 中继续配置。

### 使用已有本地项目

在 Agent 左侧的“工作区”栏点击文件夹加号，选择已有项目目录。Proma 会把该目录作为 Agent 的实际工作目录（cwd）：文件浏览、`@` 文件引用和变更检测都会指向该项目，Agent 可以直接读写项目文件。

选择本地项目不会把会话记录、MCP 配置或 Skills 写入项目根目录；这些仍保存在 Proma 的私有配置目录。普通“+”按钮则继续创建原有的隔离工作区。删除本地项目工作区只会移除 Proma 中的关联，不会删除项目文件夹。

### 使用 Web Bridge

在 Proma 或 AI SDK runtime 中，Agent 可通过 `WebBridgeNavigate` 打开网页，并用 `WebBridgeSnapshot`、`WebBridgeScreenshot`、`WebBridgeScroll` 查看页面。`WebBridgeNavigate`、`WebBridgeClick`、`WebBridgeType`、`WebBridgeDownload` 和 `WebBridgeUpload` 均需要逐次经过 Agent 权限流程，不能“始终允许”。上传时会额外弹出系统文件选择器：Agent 不能传入或读取本地路径，最多选择 10 个文件、总计 50MB，且绝对路径不会返回给模型。登录凭据、敏感信息、提交表单、支付、删除或授权等操作仍应由用户在最后一步确认或接管。

如需复用已有 Chrome 的登录态，可由用户自行以 `--remote-debugging-port=9222` 启动 Chrome，然后让 Agent 使用 `WebBridgeChromeTargets` 和 `WebBridgeConnectChrome` 连接指定页面。该 Bridge 仅连接 `127.0.0.1` 的调试端口，不会启动或关闭 Chrome；连接与所有有状态操作均走权限确认。

在 **设置 > 操作审计** 可查看本机 Web Bridge 与 Computer Use 的 JSONL 操作摘要，按来源、会话 ID、操作类型筛选，并导出当前筛选结果为 JSONL。审计不会上传，且不包含页面正文、截图、敏感输入、上传文件内容或本地绝对路径。

### 使用 Computer Use（macOS）

Computer Use 的正式支持范围为 Proma runtime 与 AI SDK runtime；Claude runtime 和 Pi runtime 仅做工具发现、权限拒绝与文本降级的兼容性验证，不承诺完整视觉输入或用户接管语义。

Computer Use 目前仅在 macOS 提供原生系统控制，包含状态/能力查询、显示器枚举、前台应用和窗口识别、授权请求、截图、移动、点击、双击、拖拽、受限快捷键、输入与滚动。`ComputerUseScreenshot` 返回 `display_id` 和 `coordinateScale`；后续操作带回该缩放值即可自动将截图像素坐标换算为显示器逻辑坐标，适用于 Retina 和多显示器布局。敏感输入、支付、授权、发布、删除和最终提交会进入专用“用户接管”状态，Agent 暂停，用户完成后才继续。Windows/Linux 已保留相同工具接口和跨平台安装包资源，但 `ComputerUseCapabilities` 会明确报告未实现原生控制的降级状态；实际输入注入与权限流程须在对应系统真机验收。首次使用时，Agent 会通过 `ComputerUseRequestPermissions` 请求系统授权；在 macOS **系统设置 > 隐私与安全性** 中为 Proma 打开：

Windows 与 Linux 安装包会保留 Computer Use 能力查询，但当前会明确显示“控制不可用”；在对应平台完成原生输入实现和真机权限验收前，不会启用鼠标、键盘或窗口控制。

1. **辅助功能**：允许鼠标点击、键盘输入和滚动；
2. **屏幕与系统音频录制**：允许读取屏幕画面。

无需管理员密码、完全磁盘访问或输入监控权限。权限只允许 Proma 具备系统能力；Agent 每次读取屏幕或控制桌面仍会显示应用内确认，不能选择“本次会话总是允许”，子 Agent 也不能自动批准。密码、验证码、密钥、支付和最终提交等敏感步骤必须由用户接管。

### 服务端 Web 本地验收

服务端应用位于 `apps/server/`。本地 P2 验收会启动临时 Postgres 与 Redis，然后验证跨 worker lease、Redis event replay 及两个独立应用实例之间的 Web session/run/workspace/SSE 路径：

```bash
docker compose -f apps/server/docker-compose.p2-test.yml up -d

export PROMA_P2_TEST_DATABASE_URL='postgres://proma:proma@127.0.0.1:55432/proma'
export PROMA_P2_TEST_REDIS_URL='redis://127.0.0.1:56379'

bun run --filter='@proma/server' test:p2-live
bun run --filter='@proma/server' test:web-e2e

docker compose -f apps/server/docker-compose.p2-test.yml down
```

这套环境只用于本地验收；正式部署需提供 `PROMA_WEB_DATABASE_URL`、`PROMA_WEB_REDIS_URL`、S3-compatible storage 配置与 envelope key。`PROMA_WEB_TRUSTED_HEADER_AUTH=1` 仅限本地开发；生产环境设置 `PROMA_WEB_OIDC_ISSUER`、`PROMA_WEB_OIDC_AUDIENCE`、`PROMA_WEB_OIDC_JWKS_URL` 后，服务会校验 RS256 Bearer JWT，并从 `tenant_id` / `sub`（可由 `PROMA_WEB_OIDC_TENANT_CLAIM` / `PROMA_WEB_OIDC_USER_CLAIM` 覆盖）建立租户 scope。

如需启用当前 P3 的月度成本预检，可设置 `PROMA_WEB_MONTHLY_BUDGET_MICROUSD`（租户/用户总额）和 `PROMA_WEB_MODEL_MONTHLY_BUDGET_MICROUSD`（单模型额度，均为微美元整数）；达到预算后新任务会在调用模型前被拒绝。

如需启用 Redis 固定窗口限速，同时设置 `PROMA_WEB_RATE_LIMIT_TASKS` 与 `PROMA_WEB_RATE_LIMIT_WINDOW_MS`；限额按 tenant/user/model 生效，并在调用模型前拒绝超额请求。

运行指标可通过 `GET /agent/metrics` 查询；`GET /agent/recovery/stale-tasks` 仅列出已超过 `PROMA_WEB_RECOVERY_STALE_AFTER_MS`（默认两倍任务租约）且没有有效租约的运行中任务。该诊断接口不会跨 worker 强制改写任务状态，避免误杀收尾中的任务。

## 模式选择

### Chat 适合

- 日常问答、解释、翻译、润色、轻量代码讨论。
- 读取附件内容后做总结、改写、比较。
- 使用联网搜索或记忆工具增强一次性对话。
- 同时对比多个模型输出，或用不同系统提示词做探索。

### Agent 适合

- 修改、创建、整理本地文件。
- 调研、编写报告、处理多步骤任务。
- 使用 MCP、Skills、Shell、Git、项目文件等外部上下文。
- 需要权限确认、计划模式、后台任务或远程机器人持续跟进的工作。

简单说：**只需要回答时用 Chat，需要行动和交付结果时用 Agent。**

## 截图

### Chat 快速分析

用 Chat 处理轻量但真实的分析任务：整理读者关注点、生成对比表，并把首屏文案快速定稿。

![Proma Chat 快速分析](./docs/assets/screenshots/proma-chat-demo.png)

### Agent 工作台

Agent 在工作区里读取文件、推进任务、输出表格化结论，并把可复用文件保留在右侧工作区面板中。

![Proma Agent 工作台](./docs/assets/screenshots/proma-agent-demo.png)

### Skills

每个工作区都可以沉淀专属 Skills。截图中的 `feedback-synthesis` 用于把用户反馈、访谈记录和 issue 聚合成主题、证据与优先级建议。

![Proma 工作区 Skills](./docs/assets/screenshots/proma-skills-demo.png)

### Skills & MCP

同一个工作区可以管理 stdio / HTTP MCP Server，按需启用或关闭，让 Agent 在不同项目里获得不同的外部上下文。

![Proma MCP 配置](./docs/assets/screenshots/proma-mcp-demo.png)

### 流式语音输入(支持全局输入)
Proma 支持豆包的流式语音输入功能，并且支持在 Proma 内使用和 Proma 外部使用：
- Proma 内部使用：Ctrl + ` 触发识别，再次按下结束自动输入到 Proma 内对应的输入框
- Proma 外部使用：Ctrl + ` 触发识别，再次按下结束自动输入到当前的光标所在处，如无光标则默认写入到剪贴板
- 
![Proma 语音输入](./docs/assets/screenshots/proma-typeless-input.png)

## 支持的模型渠道

| 供应商 | Chat | Agent | 协议说明 |
| --- | --- | --- | --- |
| Anthropic | 支持 | 支持 | Anthropic Messages API |
| DeepSeek | 支持 | 支持 | Anthropic 兼容协议 |
| Kimi API | 支持 | 支持 | Anthropic 兼容协议 |
| Kimi Coding Plan | 支持 | 支持 | Anthropic 兼容协议，使用专用认证头 |
| OpenAI | 支持 | 支持 | Chat Completions / AI SDK runtime |
| Google | 支持 | 支持 | Gemini Generative Language API / AI SDK runtime |
| 智谱 AI | 支持 | 支持 | Anthropic 兼容协议 |
| MiniMax | 支持 | 支持 | Anthropic 兼容协议 |
| 豆包 | 支持 | 支持 | Anthropic 兼容协议 |
| 通义千问 | 支持 | 支持 | Anthropic 兼容协议 |
| 自定义端点 | 支持 | 支持 | OpenAI 兼容协议 / AI SDK runtime |

Claude runtime 仍保留 SDK 原生 session / snapshot 能力；Proma runtime 当前工具能力最完整；AI SDK runtime 是后续服务端 Web 化优先路径；Pi runtime 用作 SDK 对照与多 provider 验证。

## 本地数据

Proma 采用本地文件存储，方便备份、迁移和排查问题。

```text
~/.proma/
├── channels.json
├── conversations.json
├── conversations/
│   └── {conversation-id}.jsonl
├── agent-sessions.json
├── agent-sessions/
│   └── {session-id}.jsonl
├── agent-workspaces/
│   └── {workspace-slug}/
│       ├── {session-id}/       # 隔离工作区的会话目录和私有运行状态
│       ├── workspace-files/
│       ├── mcp.json
│       └── skills/
├── attachments/
├── user-profile.json
├── settings.json
└── sdk-config/
```

API Key 会通过 Electron `safeStorage` 加密后写入 `channels.json`。Proma 不使用本地数据库，核心数据结构以 JSON 配置和 JSONL 追加日志为主。

## 开发

Proma 是 Bun workspace monorepo。

```text
proma-v2/
├── packages/
│   ├── shared/     # 共享类型、IPC 常量、配置、工具函数
│   ├── core/       # Provider Adapter、SSE、代码高亮
│   └── ui/         # 共享 React UI 组件
└── apps/
    └── electron/   # Electron 桌面应用
```

当前主要包版本：

| 包 | 版本 | 职责 |
| --- | --- | --- |
| `@proma/electron` | `0.9.12` | Electron 桌面应用 |
| `@proma/shared` | `0.1.17` | 共享类型、IPC 常量、配置和工具 |
| `@proma/core` | `0.2.9` | Provider Adapter、SSE、Shiki 高亮 |
| `@proma/ui` | `0.1.3` | 共享 React UI 组件 |

常用命令：

```bash
# 安装依赖
bun install

# 开发模式：自动启动 Vite + Electron + 热重载
bun run dev

# 构建 Electron 应用
bun run electron:build

# 构建并运行
bun run electron:start

# 类型检查
bun run typecheck

# 测试
bun test
```

Electron 子应用内也提供更细的脚本：

```bash
cd apps/electron

bun run dev:vite
bun run dev:electron
bun run build:main
bun run build:preload
bun run build:renderer
bun run dist:fast
```

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 运行时 | Bun |
| 桌面框架 | Electron 39 |
| 前端 | React 18 + TypeScript |
| 状态管理 | Jotai |
| 样式 | Tailwind CSS + Radix UI |
| 富文本输入 | TipTap |
| Markdown / 图表 / 公式 | React Markdown + Beautiful Mermaid + KaTeX |
| 代码高亮 | Shiki |
| 构建 | Vite + esbuild |
| 分发 | electron-builder |
| Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.143` |

## 架构概览

Proma 的核心通信路径是：

```text
shared 类型和 IPC 常量
  -> main/ipc.ts 注册处理器
  -> preload/index.ts 暴露 window.electronAPI
  -> renderer Jotai atoms 和 React 组件调用
```

主进程服务集中在 `apps/electron/src/main/lib/`：

- `agent-orchestrator.ts`：Agent 编排、环境变量、SDK 调用、事件流、错误处理。
- `agent-session-manager.ts`：Agent 会话索引和 JSONL 消息持久化。
- `agent-workspace-manager.ts`：工作区、MCP、Skills 和工作区文件管理。
- `chat-service.ts`：Chat 流式调用、Provider Adapter、工具活动。
- `conversation-manager.ts`：Chat 会话索引和消息存储。
- `channel-manager.ts`：渠道 CRUD、API Key 加密、连接测试、模型获取。
- `feishu-bridge.ts` / `dingtalk-bridge.ts` / `wechat-bridge.ts`：远程机器人桥接。
- `memory-service.ts`、`chat-tool-*`、`document-parser.ts`、`workspace-watcher.ts`：记忆、工具、文档解析和文件监听。

渲染进程以 Jotai 管理状态，关键 atoms 位于 `apps/electron/src/renderer/atoms/`。Agent IPC 监听器在应用顶层全局挂载，避免切换页面时丢失流式事件、权限请求或后台任务状态。

## 打包注意事项

如需与正式版并存进行本地验收，可在 `apps/electron/` 执行 `CSC_IDENTITY_AUTO_DISCOVERY=false bun run dist:mac-dev-zip`。该命令使用 `com.proma.mit.dev` 和 `proma-mit-dev.app`，不会覆盖正式版 `com.proma.mit`；macOS 的辅助功能、屏幕录制等隐私授权也需要为该开发版单独开启。`dist:mac-dev` 则同时尝试生成 DMG 和 ZIP。

`@anthropic-ai/claude-agent-sdk` 在 `0.2.113+` 后改为平台 native binary 分发。Proma 的 esbuild 配置会把 SDK 标记为 external，`electron-builder.yml` 会把 SDK 主包和平台子包一起打进安装包。

修改打包配置时请特别确认：

- 主进程 esbuild 保持 `--external:@anthropic-ai/claude-agent-sdk`。
- `apps/electron/package.json` 的 `optionalDependencies` 包含目标平台的 SDK 子包。
- `apps/electron/electron-builder.yml` 的 `files` 包含 SDK 主包和平台子包。
- 其它普通 npm 依赖通常应由 esbuild 打包进 `main.cjs`，不要随意 external。

更完整的工程约定见 [AGENTS.md](./AGENTS.md)。

## 贡献

欢迎修 Bug、补文档、加测试、完善体验，也欢迎围绕真实场景提交新的 Skills、MCP 配置或 Agent 工作流。

提交 PR 前建议先确认：

- 使用 Bun 运行脚本，不混用 npm / pnpm lockfile。
- 状态管理使用 Jotai。
- 尽量保持本地优先，优先使用配置文件和 JSON / JSONL。
- TypeScript 不使用 `any`，对象结构优先使用 `interface`。
- 新增 IPC 时同步修改 shared 类型、main handler、preload bridge 和 renderer 调用。
- 影响包行为时递增对应 package 的 patch 版本。
- 能用测试覆盖的行为尽量补上测试，尤其是共享逻辑、IPC 契约和持久化格式。

Proma 目前设有 PR 赠金计划。提交 PR 时可以在描述中留下邮箱，方便后续发放。

![Proma PR Bounty](https://img.erlich.fun/personal-blog/uPic/PR%20%E8%B5%A0%E9%87%91%201.png)


## Star History

<a href="https://www.star-history.com/?repos=ErlichLiu%2FProma&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=ErlichLiu/Proma&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=ErlichLiu/Proma&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=ErlichLiu/Proma&type=date&legend=top-left" />
 </picture>
</a>


## 致谢

- [Shiki](https://shiki.style/)：代码高亮。
- [Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid)：Mermaid 图表渲染。
- [Cherry Studio](https://github.com/CherryHQ/cherry-studio)：多供应商桌面 AI 产品启发。
- [Lobe Icons](https://github.com/lobehub/lobe-icons)：AI / LLM 品牌图标。
- [Craft Agents OSS](https://github.com/lukilabs/craft-agents-oss)：Agent SDK 集成模式参考。
- [MemOS](https://memos.openmem.net)：记忆能力参考与集成。

## 许可证

本项目采用 **Apache-2.0 或 MIT 双许可**，你可任选其一：

- Apache License, Version 2.0：详见根目录 `LICENSE-APACHE` 或 https://www.apache.org/licenses/LICENSE-2.0
- MIT License：详见根目录 `LICENSE-MIT` 或 https://opensource.org/licenses/MIT

根目录 `LICENSE` 文件亦说明了双许可的选择方式。
