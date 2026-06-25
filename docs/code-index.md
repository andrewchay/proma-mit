# Proma 代码索引与说明

> 生成时间：2026-06-25  
> 版本：v0.1  
> 范围：整个 Monorepo 的源码结构、核心模块职责、数据流与已知问题。

本文档是未来重构与功能扩展的基础地图。阅读前建议先看根目录 `AGENTS.md` 了解项目约定。

---

## 1. 项目总览

Proma 是一个集成通用 AI Agent 的下一代人工智能桌面应用，基于 Electron + React + TypeScript + Bun 构建。

- **仓库根目录**：`/Users/chaihao/LLM/proma-mit`
- **Monorepo 工具**：Bun workspace
- **总代码规模**：
  - `apps/electron/src/main/lib/`：约 28,410 行（主进程服务层）
  - `apps/electron/src/renderer/`：约 48,000+ 行（渲染进程 UI / 状态）
  - `packages/*`：约 3,000+ 行（共享类型、Provider 适配器、UI 组件）
  - **测试文件**：3 个，231 行

### 1.1 Monorepo 结构

```
proma-mit/
├── apps/
│   └── electron/              # Electron 桌面应用（@proma/electron@0.9.46）
│       ├── src/
│       │   ├── main/          # 主进程 + 服务层
│       │   ├── preload/       # IPC 上下文桥接
│       │   └── renderer/      # React UI（Vite + Tailwind + Radix UI）
│       ├── default-skills/    # 内置默认 Skill
│       ├── resources/         # 图标、音效、主题预览
│       └── scripts/           # 构建脚本
├── packages/
│   ├── shared/                # 共享类型、IPC 通道常量、工具函数（@proma/shared@0.1.19）
│   ├── core/                  # AI Provider 适配器、代码高亮服务（@proma/core@0.2.9）
│   └── ui/                    # 共享 UI 组件（@proma/ui@0.1.4）
├── docs/                      # 设计文档与代码索引
├── release-notes/             # 版本发布说明
└── proma-thinking/            # 产品思考记录
```

### 1.2 包命名与依赖

| 包名 | 路径 | 运行时依赖 |
|---|---|---|
| `@proma/shared` | `packages/shared` | 无 |
| `@proma/core` | `packages/core` | `@proma/shared`, `shiki` |
| `@proma/ui` | `packages/ui` | `@proma/core`, `@proma/shared`, `beautiful-mermaid`, `shiki`, Radix UI |
| `@proma/electron` | `apps/electron` | 上述 workspace + Electron + Agent SDK + 飞书 SDK 等 |

**包引用方式**：`workspace:*`

---

## 2. 主进程代码索引（`apps/electron/src/main/`）

### 2.1 入口与 IPC 层

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.ts` | ~250 | 主进程入口：窗口创建、生命周期、IPC 初始化 |
| `ipc.ts` | ~1,700 | 所有 IPC 通道注册中心（`ipcMain.handle`） |
| `menu.ts` | ~200 | 应用菜单模板 |
| `tray.ts` | ~120 | 系统托盘图标与菜单 |
| `preload/index.ts` | ~150 | 通过 `contextBridge.exposeInMainWorld` 暴露类型安全的 `window.electronAPI` |

**关键架构模式**：类型定义（`@proma/shared`）→ 主进程处理（`ipc.ts`）→ Preload 桥接 → 渲染进程调用。新增 IPC 必须同步修改这四个位置。

### 2.2 核心服务层（`main/lib/`）

#### Agent 核心

| 文件 | 行数 | 职责 |
|---|---|---|
| `agent-orchestrator.ts` | 2,246 | Agent 核心编排：并发守卫、渠道查找、环境变量构建、SDK 路径解析、消息持久化、事件流处理、错误处理、自动标题生成 |
| `agent-session-manager.ts` | 1,499 | SDK 消息持久化、会话元数据 CRUD、JSONL 存储、fork / rewind |
| `agent-workspace-manager.ts` | ~1,200 | 工作区 CRUD、MCP Server 配置、Skills 配置、默认 Skill 同步 |
| `agent-prompt-builder.ts` | ~700 | 系统提示词构建、动态上下文、内置 Agent 配置 |
| `agent-permission-service.ts` | ~200 | 工具权限检查、权限模式管理（safe / ask / allow-all） |
| `agent-ask-user-service.ts` | ~150 | AskUser 请求处理 |
| `agent-exit-plan-service.ts` | ~120 | Agent 退出计划服务 |
| `agent-tool-input-validator.ts` | ~200 | Agent 工具输入参数校验 |
| `agent-tool-token-estimator.ts` | ~180 | Agent 工具 token 估算 |
| `agent-event-bus.ts` | ~80 | Agent 事件总线 |
| `agent-service.ts` | ~250 | Agent 高层服务封装 |

#### Chat 核心

| 文件 | 行数 | 职责 |
|---|---|---|
| `chat-service.ts` | ~900 | Chat 流式调用编排、Provider 适配器集成、AbortController |
| `conversation-manager.ts` | ~600 | 对话 CRUD、JSONL 消息存储、置顶、上下文分割 |
| `channel-manager.ts` | ~700 | 渠道 CRUD、API Key AES-256-GCM 加密（safeStorage）、连接测试、模型获取 |

#### 集成服务

| 文件 | 行数 | 职责 |
|---|---|---|
| `feishu-bridge.ts` | 2,082 | 飞书集成核心：消息同步、任务通知、OAuth 认证、卡片渲染 |
| `feishu-bridge-manager.ts` | ~300 | 飞书 Bridge 生命周期管理 |
| `feishu-config.ts` | ~150 | 飞书配置持久化 |
| `feishu-message.ts` | ~250 | 飞书消息模型与解析 |
| `feishu-presence.ts` | ~200 | 飞书在线状态管理 |
| `feishu/card-renderer-v2.ts` | 293 | 飞书卡片渲染器 |
| `feishu/card-run-state.ts` | 286 | 飞书卡片运行状态机 |
| `feishu/card-stream.ts` | 174 | 飞书卡片流式更新 |
| `wechat-bridge.ts` | 915 | 微信集成（Bridge 模式） |
| `wechat-config.ts` | 98 | 微信配置 |
| `dingtalk-bridge.ts` | ~800 | 钉钉集成（Bridge 模式） |
| `dingtalk-bridge-manager.ts` | ~200 | 钉钉 Bridge 管理 |
| `dingtalk-config.ts` | ~100 | 钉钉配置 |
| `bridge-command-handler.ts` | ~700 | 统一 Bridge 命令处理 |
| `bridge-registry.ts` | ~150 | Bridge 注册表 |
| `memory-service.ts` | ~400 | 跨会话记忆存储与检索 |
| `memos-client.ts` | ~200 | Memos 笔记服务客户端 |

#### 适配器与工具

| 文件 | 行数 | 职责 |
|---|---|---|
| `adapters/claude-agent-adapter.ts` | 954 | Claude Agent SDK 子进程封装、query/cancel、stdout/stderr 解析 |
| `chat-tools/agent-recommend-tool.ts` | 141 | 智能体推荐工具 |
| `chat-tools/http-tool-executor.ts` | 150 | HTTP 工具执行器 |
| `chat-tools/memory-tool.ts` | 136 | 记忆工具 |
| `chat-tools/nano-banana-mcp.ts` | 384 | Nano Banana MCP 集成 |
| `chat-tools/nano-banana-tool.ts` | 420 | Nano Banana 工具 |
| `chat-tools/web-search-tool.ts` | 174 | 网页搜索工具 |
| `chat-tool-registry.ts` | ~300 | Chat 工具注册表 |
| `chat-tool-executor.ts` | ~400 | Chat 工具执行器 |
| `chat-tool-config.ts` | ~250 | Chat 工具配置 |
| `chat-tools-watcher.ts` | ~200 | Chat 工具配置变化监听 |

#### 文件与系统

| 文件 | 行数 | 职责 |
|---|---|---|
| `attachment-service.ts` | ~300 | 附件管理：存储/读取/删除、文件对话框 |
| `document-parser.ts` | ~400 | PDF/Office/文本文件提取 |
| `bridge-attachment-utils.ts` | ~200 | Bridge 附件通用工具 |
| `workspace-watcher.ts` | 190 | 工作区文件变化监听 |
| `config-paths.ts` | ~400 | `~/.proma/` 配置目录结构、默认 Skill 种子 |
| `safe-file.ts` | ~150 | 安全文件写入（原子写） |
| `storage-service.ts` | ~200 | 通用存储服务 |
| `local-file-protocol.ts` | ~120 | 本地文件协议处理 |
| `file-preview-service.ts` | ~200 | 文件预览服务 |
| `screenshot-service.ts` | ~250 | 截图服务 |

#### 运行时与环境

| 文件 | 行数 | 职责 |
|---|---|---|
| `runtime-init.ts` | ~400 | 运行时初始化：Shell 环境、Bun、Git 检测 |
| `bun-finder.ts` | ~200 | Bun 安装位置查找 |
| `git-detector.ts` | ~150 | Git 环境检测 |
| `shell-env.ts` | ~200 | Shell 环境变量加载 |
| `environment-checker.ts` | ~300 | 环境依赖检查 |
| `node-detector.ts` | ~120 | Node.js 检测 |
| `wsl-detector.ts` | 164 | WSL 检测 |
| `windows-env.ts` | 193 | Windows 特定环境处理 |
| `git-bash-detector.ts` | ~100 | Git Bash 检测 |
| `proxy-fetch.ts` | ~200 | 带代理的 fetch |
| `proxy-settings-service.ts` | ~250 | 代理设置持久化 |
| `system-proxy-detector.ts` | ~150 | 系统代理检测 |

#### 系统服务

| 文件 | 行数 | 职责 |
|---|---|---|
| `global-shortcut-service.ts` | ~250 | 全局快捷键注册 |
| `tray-menu-model.ts` | ~200 | 托盘菜单模型 |
| `titlebar-overlay.ts` | ~100 | 标题栏覆盖层 |
| `quick-task-window.ts` | ~300 | 快速任务窗口 |
| `voice-dictation-window.ts` | 394 | 语音输入窗口 |
| `text-insertion-service.ts` | ~150 | 文本插入服务 |
| `text-output-service.ts` | ~120 | 文本输出服务 |
| `microphone-permission-service.ts` | ~150 | 麦克风权限 |
| `detached-preview-window.ts` | ~250 | 独立预览窗口 |
| `dock-badge-service.ts` | ~100 | Dock 角标服务 |
| `app-lifecycle.ts` | ~150 | 应用生命周期工具 |

#### 配置与用户数据

| 文件 | 行数 | 职责 |
|---|---|---|
| `settings-service.ts` | ~250 | 应用设置持久化（主题等） |
| `user-profile-service.ts` | ~120 | 用户档案持久化 |
| `system-prompt-manager.ts` | ~400 | 系统提示词管理 |
| `migration-service.ts` | ~300 | 数据迁移 |
| `installer-downloader.ts` | ~250 | 安装包下载 |
| `installer-manifest.ts` | ~200 | 安装包清单 |
| `github-release-service.ts` | ~250 | GitHub 发布检测 |

#### 更新器

| 文件 | 行数 | 职责 |
|---|---|---|
| `updater/auto-updater.ts` | 166 | Electron Updater 集成 |
| `updater/updater-ipc.ts` | 42 | 更新器 IPC |
| `updater/updater-types.ts` | 35 | 更新器类型 |

#### Git / Diff

| 文件 | 行数 | 职责 |
|---|---|---|
| `git-diff-service.ts` | ~300 | Git diff 生成与解析 |
| `error-patterns.ts` | ~150 | 常见错误模式匹配 |

---

## 3. 渲染进程代码索引（`apps/electron/src/renderer/`）

### 3.1 入口与全局初始化

| 文件 | 职责 |
|---|---|
| `main.tsx` | 渲染进程入口，挂载 ThemeInitializer、AgentSettingsInitializer、AgentListenersInitializer、UpdaterInitializer |
| `App.tsx` | 根组件，应用路由与全局布局 |
| `index.html` | 渲染进程 HTML 模板 |
| `vite-env.d.ts` | Vite 环境类型 |

### 3.2 全局 Hooks（`hooks/`）

| 文件 | 职责 |
|---|---|
| `useGlobalAgentListeners.ts` | **最关键**：全局 Agent IPC 监听，永不销毁，直接操作 atoms |
| `useGlobalChatListeners.ts` | 全局 Chat IPC 监听 |
| `useBackgroundTasks.ts` | 后台任务管理，按 sessionId 隔离 |
| `useCloseTab.tsx` | Tab 关闭清理 |
| `useConversationSettings.ts` | 对话设置管理 |
| `useCreateSession.ts` | 创建会话 |
| `useOpenSession.ts` | 打开会话 |
| `useShortcut.ts` | 快捷键 |
| `useScrollPositionMemory.ts` | 滚动位置记忆 |
| `useSyncActiveTabSideEffects.ts` | Tab 切换副作用同步 |
| `useWorkspaceActions.ts` | 工作区操作 |
| `useMigrationImport.ts` | 数据迁移导入 |

### 3.3 状态管理（`atoms/`）

| 文件 | 职责 |
|---|---|
| `active-view.ts` | 主面板视图 |
| `app-mode.ts` | 应用模式（Chat / Agent） |
| `chat-atoms.ts` | 对话列表、当前消息、流式状态、模型选择、附件 |
| `agent-atoms.ts` | Agent 会话、流式状态、工作区、权限/AskUser 请求队列 |
| `tab-atoms.ts` | Tab 状态 |
| `theme.ts` | 主题模式（light / dark / system） |
| `user-profile.ts` | 用户档案 |
| `settings-tab.ts` | 设置面板当前标签 |
| `updater.ts` | 自动更新状态 |
| `feishu-atoms.ts` | 飞书相关状态 |
| `wechat-atoms.ts` | 微信相关状态 |
| `dingtalk-atoms.ts` | 钉钉相关状态 |
| `environment.ts` | 环境检查状态 |
| `notifications.ts` | 通知状态 |
| `search-atoms.ts` | 搜索状态 |
| `preview-atoms.ts` | 预览状态 |
| `system-prompt-atoms.ts` | 系统提示词状态 |
| `chat-tool-atoms.ts` | Chat 工具状态 |
| `draft-session-atoms.ts` | 草稿会话状态 |
| `sidebar-atoms.ts` | 侧边栏状态 |
| `markdown-font-size.ts` | Markdown 字体大小 |
| `ui-preferences.ts` | UI 偏好 |
| `working-atoms.ts` | 工作区相关状态 |
| `migration-atoms.ts` | 迁移状态 |
| `proxy-atoms.ts` | 代理状态 |
| `shortcut-atoms.ts` | 快捷键状态 |

### 3.4 组件架构（`components/`）

#### 应用壳层（`app-shell/`）

| 文件 | 职责 |
|---|---|
| `AppShell.tsx` | 三面板布局 |
| `LeftSidebar.tsx` | 左侧边栏 |
| `NavigatorPanel.tsx` | 导航面板 |
| `RightSidePanel.tsx` | 右侧面板 |
| `ModeSwitcher.tsx` | Chat / Agent 模式切换 |
| `Panel.tsx` / `PanelHeader.tsx` | 面板容器 |
| `SearchDialog.tsx` | 全局搜索对话框 |

#### Chat 模式（`chat/`）

| 文件 | 职责 |
|---|---|
| `ChatView.tsx` | Chat 主视图 |
| `ChatHeader.tsx` | Chat 头部：模型选择、上下文设置 |
| `ChatInput.tsx` | 富文本输入（TipTap） |
| `ChatMessages.tsx` | 消息列表与自动滚动 |
| `ParallelChatMessages.tsx` | 并排模式消息 |
| `ChatMessageItem.tsx` | 单条消息渲染 |
| `ModelSelector.tsx` | 模型选择器 |
| `SystemPromptSelector.tsx` | 系统提示词选择 |
| `AttachmentPreviewItem.tsx` | 附件预览 |
| `ClearContextButton.tsx` | 清空上下文 |
| `ContextSettingsPopover.tsx` | 上下文设置弹窗 |
| `MigrateToAgentButton.tsx` | 迁移到 Agent |
| `AgentRecommendBanner.tsx` | 智能体推荐横幅 |
| `ChatToolActivityIndicator.tsx` / `ChatToolBlock.tsx` | Chat 工具展示 |

#### Agent 模式（`agent/`）

| 文件 | 职责 |
|---|---|
| `AgentView.tsx` | Agent 主视图 |
| `AgentHeader.tsx` | Agent 头部：渠道/模型/工作区选择 |
| `AgentMessages.tsx` | Agent 消息列表 |
| `SDKMessageRenderer.tsx` | SDK 消息渲染 |
| `ContentBlock.tsx` | 内容块渲染 |
| `PermissionBanner.tsx` | 权限请求横幅 |
| `AskUserBanner.tsx` | AskUser 横幅 |
| `ExitPlanModeBanner.tsx` | 退出计划模式横幅 |
| `WorkspaceSelector.tsx` | 工作区选择器 |
| `BackgroundTasksPanel.tsx` | 后台任务面板 |
| `TaskProgressCard.tsx` / `TaskBadge.tsx` | 任务进度 |
| `ActiveTasksBar.tsx` | 活动任务栏 |
| `SidePanel.tsx` | Agent 侧栏 |
| `MoveSessionDialog.tsx` | 移动会话对话框 |
| `ContextUsageBadge.tsx` | 上下文用量徽章 |
| `TurnFileChangesSummary.tsx` | 单轮文件变更摘要 |
| `mention-suggestions.tsx` / `MentionList.tsx` | @ 提及建议 |

#### Agent 工具结果渲染器（`agent/tool-result-renderers/`）

| 文件 | 职责 |
|---|---|
| `default-result.tsx` | 默认工具结果 |
| `bash-result.tsx` | Bash 结果 |
| `edit-result.tsx` | 编辑结果 |
| `write-result.tsx` | 写文件结果 |
| `read-result.tsx` | 读文件结果 |
| `glob-result.tsx` | Glob 结果 |
| `grep-result.tsx` | Grep 结果 |
| `web-search-result.tsx` | 网页搜索结果 |
| `web-fetch-result.tsx` | 网页抓取结果 |
| `task-list-result.tsx` / `task-get-result.tsx` | Task 结果 |
| `collapsible-result.tsx` | 可折叠结果 |
| `preview-open-button.tsx` | 预览打开按钮 |
| `index.tsx` | 渲染器统一导出 |

#### 设置面板（`settings/`）

| 文件 | 职责 |
|---|---|
| `SettingsPanel.tsx` | 设置面板容器 |
| `SettingsDialog.tsx` | 设置对话框 |
| `GeneralSettings.tsx` | 通用设置 |
| `AppearanceSettings.tsx` | 外观/主题 |
| `ChannelSettings.tsx` / `ChannelForm.tsx` | 渠道管理 |
| `AgentSettings.tsx` | Agent 设置 |
| `McpServerForm.tsx` | MCP 服务器配置 |
| `MemorySettings.tsx` | 记忆设置 |
| `FeishuSettings.tsx` | 飞书设置 |
| `WeChatSettings.tsx` | 微信设置 |
| `DingTalkSettings.tsx` | 钉钉设置 |
| `ProxySettings.tsx` | 代理设置 |
| `ShortcutSettings.tsx` | 快捷键设置 |
| `AboutSettings.tsx` / `VersionHistory.tsx` / `UpdateDialog.tsx` | 关于/更新 |
| `StorageSettings.tsx` | 存储设置 |
| `PromptSettings.tsx` | 提示词设置 |
| `BotDefaultSettings.tsx` / `BotHubSettings.tsx` | Bot 设置 |
| `PromaLogoSettings.tsx` | Logo 设置 |
| `VoiceInputSettings.tsx` | 语音输入设置 |
| `MigrationSettings.tsx` | 迁移设置 |
| `SkillFilesPanel.tsx` | Skill 文件面板 |
| `ReleaseNotesViewer.tsx` | 发布说明查看 |
| `primitives/` | 可复用表单组件 |

#### Diff / 编辑器（`diff/`）

| 文件 | 职责 |
|---|---|
| `DiffView.tsx` | Diff 视图 |
| `DiffTabContent.tsx` | Diff 标签内容 |
| `DiffChangesList.tsx` | 变更列表 |
| `DiffPanelTabBar.tsx` | Diff 标签栏 |
| `MarkdownRichEditor.tsx` | Markdown 富文本编辑器 |
| `MarkdownEditorToolbar.tsx` | 编辑器工具栏 |
| `PreviewPanel.tsx` | 预览面板 |
| `markdown-preview-extensions.tsx` | Markdown 预览扩展 |
| `QuotedSelectionChip.tsx` | 引用选择芯片 |
| `TableBubbleMenu.tsx` | 表格气泡菜单 |
| `DetachedPreviewApp.tsx` | 独立预览窗口应用 |

#### 文件浏览器（`file-browser/`）

| 文件 | 职责 |
|---|---|
| `FileBrowser.tsx` | 文件树浏览 |
| `FileDropZone.tsx` | 文件拖放区 |
| `FileTypeIcon.tsx` | 文件类型图标 |
| `FileMentionList.tsx` | 文件提及列表 |
| `file-mention-suggestion.tsx` | 文件提及建议 |
| `tree-row-layout.ts` | 树行布局 |

#### AI 元素（`ai-elements/`）

| 文件 | 职责 |
|---|---|
| `conversation.tsx` | 对话容器 |
| `message.tsx` | 消息展示 |
| `reasoning.tsx` | 推理折叠 |
| `rich-text-input.tsx` | 富文本输入 |
| `context-divider.tsx` | 上下文分割线 |
| `file-path-chip.tsx` | 文件路径芯片 |
| `scroll-minimap.tsx` | 滚动小地图 |
| `speech-button.tsx` | 语音按钮 |
| `sticky-user-message.tsx` | 粘性用户消息 |
| `InputToolbarOverflow.tsx` | 输入工具栏溢出 |

#### Tabs（`tabs/`）

| 文件 | 职责 |
|---|---|
| `MainArea.tsx` | Tab 主区域 |
| `TabBar.tsx` / `TabBarItem.tsx` | Tab 栏 |
| `TabContent.tsx` | Tab 内容 |
| `TabSwitcher.tsx` | Tab 切换器 |
| `TabCloseConfirmDialog.tsx` | 关闭确认 |
| `TabErrorBoundary.tsx` | Tab 错误边界 |
| `TabPreviewPanel.tsx` | Tab 预览 |

#### 其他组件

| 目录 | 说明 |
|---|---|
| `components/ui/` | shadcn/ui + Radix UI 原始组件（~30 个） |
| `components/welcome/` | 欢迎页 |
| `components/onboarding/` | 新手引导 |
| `components/tutorial/` | 教程 |
| `components/quick-task/` | 快速任务窗口 |
| `components/scratch-pad/` | 草稿板 |
| `components/voice-dictation/` | 语音听写 |
| `components/shortcuts/` | 快捷键 |
| `components/migration/` | 数据迁移 |
| `components/environment/` | 环境检查 |

### 3.5 渲染进程工具（`lib/`）

| 文件 | 职责 |
|---|---|
| `markdown-rich-text.ts` | Markdown 与富文本互转 |
| `markdown-rich-text.test.ts` | 上述模块测试 |
| `dock-badge-count.ts` | Dock 角标计数 |
| `dock-badge-count.test.ts` | 角标计数测试 |
| `utils.ts` | 通用工具 |
| `file-utils.ts` | 文件工具 |
| `lowlight.ts` | 代码高亮封装 |
| `model-logo.ts` | 模型 Logo |
| `platform.ts` | 平台检测 |
| `shortcut-defaults.ts` / `shortcut-registry.ts` | 快捷键 |
| `tips.ts` | 提示语 |
| `voice-input-focus.ts` | 语音输入焦点 |
| `capabilities-toast.ts` | 能力变化提示 |

---

## 4. 共享包代码索引

### 4.1 `@proma/shared`（`packages/shared/src/`）

| 文件 | 职责 |
|---|---|
| `index.ts` | 统一导出 |
| `types/index.ts` | 类型统一导出 |
| `types/agent.ts` | Agent 相关类型（AgentEvent、AgentSessionMeta、AgentMessage 等） |
| `types/chat.ts` | Chat 相关类型 |
| `types/channel.ts` | 渠道类型 |
| `types/feishu.ts` | 飞书类型 |
| `types/wechat.ts` / `dingtalk.ts` | 微信/钉钉类型 |
| `types/environment.ts` | 环境类型 |
| `types/proxy.ts` | 代理类型 |
| `types/runtime.ts` | 运行时类型 |
| `types/system-prompt.ts` | 系统提示词类型 |
| `types/chat-tool.ts` | Chat 工具类型 |
| `types/github.ts` | GitHub 类型 |
| `types/installer.ts` | 安装包类型 |
| `agent/index.ts` | Agent 工具匹配、事件转换、流状态应用 |
| `config/index.ts` | 配置常量 |
| `constants/permission-rules.ts` | 权限规则 |
| `utils/index.ts` | 通用工具函数 |
| `utils/capabilities-diff.ts` | 能力差异计算 |
| `utils/capabilities-diff.test.ts` | 能力差异测试 |
| `utils/thinking-signature-error.ts` | 思考签名错误 |

### 4.2 `@proma/core`（`packages/core/src/`）

| 文件 | 职责 |
|---|---|
| `index.ts` | 统一导出 |
| `providers/index.ts` | Provider 适配器注册表 |
| `providers/anthropic-adapter.ts` | Anthropic / DeepSeek / MiniMax（Messages API） |
| `providers/openai-adapter.ts` | OpenAI / 智谱 / 豆包 / 通义 / Custom（Chat Completions） |
| `providers/google-adapter.ts` | Google Gemini |
| `providers/sse-reader.ts` | 通用 SSE 流读取器 |
| `providers/types.ts` | Provider 类型 |
| `providers/url-utils.ts` | URL 工具 |
| `providers/thinking-capability.ts` | 思考能力检测 |
| `highlight/index.ts` / `shiki-service.ts` | Shiki 代码高亮 |
| `types/index.ts` | Core 类型 |
| `utils/index.ts` | Core 工具 |

### 4.3 `@proma/ui`（`packages/ui/src/`）

| 文件 | 职责 |
|---|---|
| `index.ts` | 统一导出 |
| `code-block/CodeBlock.tsx` | 代码块组件 |
| `code-block/index.ts` | 代码块导出 |
| `mermaid-block/MermaidBlock.tsx` | Mermaid 图表组件 |
| `mermaid-block/index.ts` | Mermaid 导出 |
| `hooks/index.ts` / `useSmoothStream.ts` | 平滑流式 Hook |

---

## 5. 关键数据流

### 5.1 Chat 模式数据流

```
用户输入 → ChatInput.tsx
              ↓
       chat-atoms.ts（状态）
              ↓
       window.electronAPI.sendChatMessage
              ↓
       main/ipc.ts → chat-service.ts
              ↓
       packages/core/providers/*-adapter.ts
              ↓
       SSE 流 → main/ipc.ts → renderer
              ↓
       useGlobalChatListeners.ts → chat-atoms.ts
              ↓
       ChatMessages.tsx 更新
```

### 5.2 Agent 模式数据流

```
用户输入 → AgentView.tsx
              ↓
       agent-atoms.ts
              ↓
       window.electronAPI.runAgent
              ↓
       main/ipc.ts → agent-orchestrator.ts
              ↓
       adpaters/claude-agent-adapter.ts → SDK 子进程
              ↓
       SDKMessage 流 → convertSDKMessage → AgentEvent
              ↓
       main/ipc.ts → webContents.send
              ↓
       useGlobalAgentListeners.ts（永不销毁）→ agent-atoms.ts
              ↓
       AgentMessages.tsx / PermissionBanner / AskUserBanner 更新
```

### 5.3 飞书 Bridge 数据流

```
飞书消息 → feishu-bridge.ts
              ↓
       bridge-command-handler.ts
              ↓
       agent-orchestrator.ts / chat-service.ts
              ↓
       卡片/文本回复 → feishu-bridge.ts → 飞书
```

### 5.4 本地存储结构（`~/.proma/`）

```
~/.proma/
├── channels.json              # 渠道配置（API Key 加密）
├── conversations.json         # 对话索引
├── conversations/{uuid}.jsonl # 对话消息
├── agent-sessions.json        # Agent 会话索引
├── agent-sessions/{uuid}.jsonl# Agent 消息
├── agent-workspaces/{slug}/   # 工作区
│   ├── mcp.json               # MCP 配置
│   ├── skills/                # Skills
│   └── workspace-files/       # 工作区文件
├── attachments/{convId}/      # 附件
├── user-profile.json          # 用户档案
├── settings.json              # 应用设置
└── default-skills/            # 默认 Skills 缓存
```

---

## 6. 已知 Bug 与风险清单

### 6.1 环境/依赖问题（已确认）

| 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|
| 项目未安装 `node_modules` | `bun test` 与 `bun run typecheck` 均失败 | 无法运行测试、类型检查、开发构建 | 执行 `bun install` |
| `markdown-it` 测试失败 | `error: Cannot find package 'markdown-it'` | `markdown-rich-text.test.ts` 无法运行 | 安装依赖后重试 |
| `tsc` 命令未找到 | `/bin/bash: tsc: command not found` | 类型检查完全不可用 | 安装依赖后重试 |

### 6.2 数据解析风险（高优先级）

| 文件 | 行号 | 问题 | 风险 |
|---|---|---|---|
| `main/lib/feishu-bridge.ts` | 556, 562, 585, 601 | 直接 `JSON.parse(message.content as string)`，无 try/catch | 非法消息会导致主进程崩溃 |
| `main/lib/agent-session-manager.ts` | 134, 1132 | `JSON.parse(readFileSync(...))` 在 try 块外 | 损坏的 settings 文件导致崩溃 |
| `main/lib/agent-workspace-manager.ts` | 454, 782, 1053 | `JSON.parse(raw)` 外部 try 不完整 | 损坏的 MCP/Skill 配置导致崩溃 |

### 6.3 类型与空值风险

| 文件 | 行号 | 问题 | 风险 |
|---|---|---|---|
| `main/lib/agent-orchestrator.ts` | 90, 91, 103, 104, 115, 116 | 正则捕获结果用 `!` 断言非空 | 不匹配时访问 `undefined` |
| `main/lib/agent-session-manager.ts` | 821, 1361, 1400, 1453 | 多处 `!` 断言 | 数据异常时崩溃 |
| `main/lib/feishu-bridge.ts` | 806, 1451, 2070 等 | `windows[0]!`、`binding!.sessionId` | 空数组时崩溃 |
| `main/lib/wechat-bridge.ts` | 507, 595, 600 等 | AbortController / 客户端 `!` 断言密集 | 生命周期异常时崩溃 |
| `main/lib/agent-session-manager.ts` | 245-246 | 使用 `any` 做深拷贝 | 违反项目代码风格，丢失类型安全 |

### 6.4 并发 / 异步 / 资源泄漏

| 文件 | 问题 | 风险 |
|---|---|---|
| `wechat-bridge.ts` / `dingtalk-bridge.ts` | interval / listener 异常路径可能未清理 | 内存泄漏 |
| `adapters/claude-agent-adapter.ts` | `child.stderr?.on('data')` 无 remove | 内存泄漏 |
| `feishu-bridge.ts` | 长生命周期监听（`this.channel.on`、`agentEventBus.on`） | 内存泄漏 |
| `agent-orchestrator.ts` | `persistSDKMessages` 与 `getAgentSessionMessages` 并发读写 JSONL | 数据损坏 |
| `agent-session-manager.ts` | `appendAgentMessage` 读-改-写非原子 | 并发写入丢失消息 |
| `agent-orchestrator.ts` | 标题生成失败仅打印日志 | 用户无感知 |
| `adapters/claude-agent-adapter.ts` | `cancelQueuedMessage` 为空实现 | 取消消息不生效 |
| `bridge-command-handler.ts` | `.catch(console.error)` 仅日志 | 用户侧无反馈 |

### 6.5 UI / 渲染风险

| 文件 | 行号 | 问题 | 风险 |
|---|---|---|---|
| `packages/ui/src/mermaid-block/MermaidBlock.tsx` | 279 | `dangerouslySetInnerHTML` | XSS（SVG 一般可信） |
| `components/diff/DiffTabContent.tsx` | 955, 962 | `dangerouslySetInnerHTML` 显示 docx/office HTML | XSS |
| `renderer/lib/markdown-rich-text.ts` | 285, 317 | `innerHTML = html` | 依赖输入是否 sanitize |
| 多处组件 | 见 6.6 | `key={i}` / `key={index}` | 列表重排状态复用问题 |

### 6.6 使用数组索引作为 React key 的位置

- `components/agent/ContentBlock.tsx:269, 452`
- `components/agent/SDKMessageRenderer.tsx:631, 747, 1117`
- `components/agent/tool-result-renderers/default-result.tsx:50`
- `components/agent/tool-result-renderers/web-search-result.tsx:93`
- `components/agent/tool-result-renderers/grep-result.tsx:68, 127`
- `components/agent/tool-result-renderers/glob-result.tsx:34`
- `components/ui/spinner.tsx:45`

### 6.7 调试代码残留

多处 `[FLASH-DEBUG]` 日志残留在生产代码：

- `renderer/atoms/theme.ts:139-141`
- `renderer/App.tsx:15-19`
- `renderer/hooks/useGlobalAgentListeners.ts:469-478, 799`
- `renderer/components/tabs/MainArea.tsx:101`
- `renderer/components/tabs/TabContent.tsx:24-27`

### 6.8 测试覆盖严重不足

| 指标 | 数值 |
|---|---|
| 测试文件 | 3 个 |
| 测试代码行数 | 231 行 |
| 被测代码规模 | 72,000+ 行 |
| 核心服务测试 | 无 |

**未覆盖核心模块**：
- `agent-orchestrator.ts`
- `adapters/claude-agent-adapter.ts`
- `agent-session-manager.ts`
- `feishu-bridge.ts`
- `chat-service.ts`
- `channel-manager.ts`
- `conversation-manager.ts`

### 6.9 代码质量

- **无 ESLint / Prettier 配置**：所有 `package.json` 中均无 lint 脚本，仓库根目录无 `.eslintrc*` / `prettier.config.*`。
- **日志过多**：`main/lib/` 与 `packages/core` 中存在 981+ 处 `console.log/warn/error`，可能泄露敏感信息并影响性能。
- **IPC handler 同步抛错**：`main/ipc.ts` 中部分 Skill 文件管理 handler 未 try/catch，失败会直接抛到 IPC 层。

### 6.10 未实现功能（TODO）

| 文件 | 行号 | 说明 |
|---|---|---|
| `main/ipc.ts` | 1626 | `GET_TASK_OUTPUT` 返回空输出，TODO：通过 SDK TaskOutput 获取 |
| `main/lib/feishu-bridge.ts` | 1255 | 飞书 Chat 模式回复能力未实现，TODO：Phase 4 |

---

## 7. 开发命令速查

```bash
# 安装依赖（必须先执行）
bun install

# 开发模式
bun run dev

# 构建并运行
bun run electron:start

# 仅构建
bun run electron:build

# 类型检查
bun run typecheck

# 测试
bun test

# 打包分发（在 apps/electron 目录下）
cd apps/electron
bun run dist:mac
bun run dist:win
bun run dist:linux
bun run dist:fast
```

---

## 8. 重构/扩展建议优先级

1. **高**：安装依赖并修复 `markdown-it` 测试失败，恢复 `typecheck`。
2. **高**：为 `feishu-bridge.ts` 的 `JSON.parse(message.content)` 增加 try/catch，防止 malformed 消息崩溃主进程。
3. **高**：为 `agent-session-manager.ts` / `agent-workspace-manager.ts` 的 JSON 解析增加统一防护。
4. **高**：补充核心模块单元测试（至少 `agent-orchestrator` 重试逻辑、`agent-session-manager` fork/rewind、`chat-service` 流式编排）。
5. **中**：收敛 `!` 非空断言与 `any` 使用，统一错误处理。
6. **中**：清理 `[FLASH-DEBUG]` 日志与生产环境 `console.log`。
7. **中**：审查 `dangerouslySetInnerHTML` / `innerHTML` 输入源，确认已充分 sanitize。
8. **中**：平衡事件监听器 add/remove，修复 Bridge / Watcher 内存泄漏。
9. **中**：将 `key={index}` 替换为稳定唯一 key。
10. **低**：配置 ESLint + Prettier 或 Biome，统一代码风格。
11. **低**：将 `GET_TASK_OUTPUT` 与飞书 Chat 模式 TODO 纳入排期。

---

## 9. 版本信息

- `@proma/electron`: `0.9.46`
- `@proma/core`: `0.2.9`
- `@proma/shared`: `0.1.19`
- `@proma/ui`: `0.1.4`
- Electron: `^39.5.1`
- React: `^18.3.1`
- Bun: `1.3.14`（当前环境）

---

*本文档由代码索引扫描生成，未来每次大重构后建议同步更新。*
