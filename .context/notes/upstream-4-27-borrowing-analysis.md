# 上游 Proma 4.27 之后变化 × proma-mit 独立开发机会分析

> 更新时间：2026-08-01
> 分析对象：`~/LLM/Proma`（官方上游，最新 v0.16.5）vs `~/LLM/proma-mit`（fork，基线 v0.10.21 / claude-agent-sdk 0.3.143）
> 范围：上游 2026-04-27 之后共 **1026 个提交**、8 个版本（v0.9.11 → v0.16.5）

## 一、基线关系（先搞清楚再谈移植）

| 项 | 值 |
|---|---|
| proma-mit 代码基线 | 上游 v0.10.21（2026-05-31，claude-agent-sdk 0.3.143 + Pi 内核） |
| git 历史 | 独立 init（2026-01-26），非上游分支，无法直接 merge |
| 与上游关系 | 同步过 v0.7.1～v0.9.41 release notes，之后走独立路线（生态化：Workflow/扩展/灵动岛/通知协调/Run Store） |
| 结论 | 上游 4.27 之后的变化需要**选择性移植/独立重写**，不能 cherry-pick |

## 二、上游 4.27 之后的主要变化域

### 1. Pi Runtime 深化（v0.15 系列，6-7 月）
- Pi 内核接入 + 联网/浏览器工具（#1170~#1180）
- Pi 会话分叉与回退（fork/rewind，#1203）
- 实时任务进度浮层（#1205）
- Codex OAuth 订阅额度 + 快速模式（#1188/#1190/#1196）
- Pi 上下文压缩工具（#1246）
- 会话级 OpenAI 推理控制（#1201）
- Pi 默认 + Claude 下线提示（#1327）
- 流式输出 20fps 快照合并、累计 partial 帧增量计算（#1191/#1187）

### 2. Planning 本地待办/日历工作区（v0.16 系列，主打功能）
- 本地 Todo / 日历 / 分组 / 标签 / 提醒（#1323）
- 日历周视图增强（#1333）
- 引用待办/日程到 Agent（#1329）
- 从待办启动 Agent（#1347）
- 独立计划窗口 + Cmd/Ctrl+Shift+T（#1344/#1345）
- 快捷键地图（#1318）
- 自动模式删除明确指定待办/日程（#1324）

### 3. 本地项目根目录（v0.15.7）
- 选择本地文件夹作为项目根目录 + Agent 默认工作目录
- 文件面板统一会话文件与项目文件
- 本地项目配置隔离（Skills/MCP/CLAUDE.md/Memory 仍由工作区管理）

### 4. 统一命令菜单 + Composer 引用（v0.16）
- `/` 命令菜单调用 Skill/MCP/会话/文件（#1326）
- `@` 文件、`&` 会话、`～` 待办/日程快捷引用（#1356）
- 跨平台附件选择（macOS/Windows/Linux）

### 5. 统一 Files 面板（#1322/#1354）
- 项目文件与会话文件统一浏览；会话文件可移入项目
- 按会话筛选文件来源

### 6. 设置/UI/体验
- 设置页工作区化（弹窗 → 独立工作区，#1331）
- 会话悬浮预览 toggle + 移除自动文件 reveal（#1335）
- 思考内容默认收起（#019e63b8 相关）
- 会话星标标记（#1232）
- 侧边栏会话创建入口收敛至项目层（#1252）

### 7. 模型/渠道能力
- Claude Opus 5 1M context（#1308）
- GPT-5 能力外推（#1250）
- OpenAI Responses API 渠道（#1176）
- Qwen Token Plan（#1210）、Qwen3.7 1M 渠道（#872）、Ark Coding Plan（#1118）
- OpenCode Go 订阅（#1263）
- Codex OAuth 语义标题（#1248）

### 8. 工程/自动化
- Git/PR Made-with 标识（#1275）
- updater 空闲时安装更新（#1360）
- automation once/maxRuns 一次性调度（#914）
- 定时任务支持 Pi 内核 + 自然日切片 + 70% 上下文安全阀
- 协作子会话模型选择（#938）、resultSummary 12K→50K（#955）、委派树嵌套（#922）、blocked event bubbling（#901）
- proma CLI 自包含二进制 + session-cleaner skill（#990~#994）

### 9. 其他
- voice 流式听写反馈（#1377）
- agent-island 官方实现（常驻工作状态条，#1375/#1376）
- 文件预览查找（#599）、Mermaid 渲染（#597）、frontmatter 元数据块（#868）、多图翻页（#1126）
- 经典/现代界面风格（#915）、CRT 主题（#850）
- 拖拽文件到输入框引用（#1368）
- 输入框 Markdown 渲染开关（#1080）

## 三、proma-mit 已覆盖（无需重复开发）

| 上游能力 | proma-mit 现状 |
|---|---|
| Pi runtime 接入 + 工具桥接 + MCP | ✅ 已有（更早，7-19 起，pi-tool-bridge/pi-model-registry） |
| Proactive Scheduler（Cron/连续失败暂停/新建会话） | ✅ 已有（proactive-scheduler.ts + workflow-scheduler） |
| 渠道 Plan 额度查询 | ✅ 已有（DeepSeek 余额 / Kimi 5H·周） |
| Workflow 模式 | ✅ 已有（WorkflowView + workflow-agent-executor） |
| 灵动岛/会话状态机 | ✅ 已有（NSPanel + phase/attention/pill + 状态机） |
| 通知协调器（主进程统一） | ✅ 已有（NotificationCoordinator + AppEventBus） |
| 扩展中心 PluginManager | ✅ 已有（manifest/权限/启停） |
| Run Store / Run Center | ✅ 已有 |
| Web Bridge / Playwright CDP | ✅ 已有 |
| 任务进度卡片 | ✅ 已有（TaskProgressCard） |
| 文件路径 chip 系统打开 | ✅ 已有 |
| 输入框历史回溯 | ✅ 已有 |
| Mermaid / 代码高亮 / 多图（部分） | ✅ 已有 |
| 本地项目根目录 | 🟡 有 createWorkspaceFromFolder，但统一 Files/配置隔离细节待对齐 |
| 引用 @文件 &会话 | 🟡 有 MentionList，缺 ～待办/日程 |

## 四、值得在 proma-mit 独立开发（优先级排序）

### P0 核心 gap（强烈建议，与生态化路线契合）
1. **Planning 本地待办/日历工作区** —— proma-mit 完全空白（grep 无 planning/todo/calendar 代码）。上游 v0.16 主打，且 proma-mit 已有 AppEventBus/通知/自动化底座，承接成本低、用户价值高。含：本地 todo/calendar/groups/tags/reminders、日历视图、从待办启动 Agent、引用待办日程、独立计划窗口。
2. **统一命令菜单（`/` 菜单）** —— 已有 mention 基础，扩展为 Skill/MCP/文件/会话统一入口。
3. **Composer 引用体系完善** —— `@` 文件、`&` 会话、`～` 待办/日程 + 跨平台附件选择（对齐 #1356）。
4. **统一项目与会话 Files + 按会话筛选** —— 对齐 #1322/#1354，同时落地上游 v0.15.7 的本地项目配置隔离语义。

### P1 高价值增强
5. **Pi 上下文压缩 + 思考默认收起** —— proma-mit 的 Pi compaction 目前显式关闭（见 agent-runtime-capability-matrix），长会话上下文管理是真实痛点；对齐 #1246 + 收起交互。
6. **Pi 会话分叉与回退**（fork/rewind，#1203）—— Agent 工作流可回溯的刚需。
7. **Codex OAuth 额度 + 快速模式**（#1188/#1190）—— proma-mit 有渠道额度但没有 Codex OAuth 专项。
8. **updater 空闲安装更新**（#1360）—— 低风险体验优化。
9. **会话级推理控制**（OpenAI reasoning，#1201）。
10. **快捷键地图**（#1318）—— ShortcutSettings 已存在，补总览视图即可。

### P2 可选（锦上添花）
11. **agent-island 官方版借鉴** —— proma-mit 已有灵动岛通知条；官方是「常驻工作状态条」（pill→briefing 卡片），值得在现有状态机之上扩展成工作脉冲，而非照搬窗口技术（参考 proma-agent-island.md）。
12. **Made-with 标识**（可改成 proma-mit 专属，避免侵权语义）。
13. **语音流式听写反馈**（#1377）。
14. **多图预览翻页 / 拖拽引用 / 文件预览查找**（#1126/#1368/#599）。
15. **子会话模型选择 + 委派树嵌套**（#938/#922）—— proma-mit 已有 collaboration-utils，补 UI 呈现。
16. **主题扩展**（CRT/经典现代，如与现有主题体系兼容）。

### 不建议照搬
- 官方 agent-island 完整实现（与自有灵动岛重复，只借鉴状态语义）
- Nowledge Mem 记忆卡片（proma-mit 有自己的 mem 体系）
- 统一 MCP 单一事实源 default-mcp.json（proma-mit 有 mcp.json 结构）
- 经典/现代 UI 整体切换（proma-mit 走「简约项目管理 + 生态化」路线）

## 五、执行建议

1. **先做 P0-1（Planning）**：作为新一级工作区入口，与现有 Workflow/Run Store 打通，形成「待办 → 任务 → 运行记录」闭环，最符合 proma-mit 的生态化心智。
2. **P0-2/3/4 打包为一个「输入与文件体验」迭代**：命令菜单 + Composer 引用 + 统一 Files 是同一交互层，一起做避免重复改动。
3. 每一项立项前对照 `proma-agent-island.md` 的「主进程拥有状态、渲染层只画」原则，复用 AppEventBus 事件契约。

## 六、执行记录

### 2026-08-01：P0-2/3/4 完成（统一命令菜单 + Composer 引用 + 统一 Files）
- `/` 统一命令菜单（root 页：Skills/MCP/会话/文件/添加附件/附加文件夹 + 子页搜索），保留 @/#/& legacy 前缀
- 新增：agent-command-menu-state.ts（+23 单测）、agent-command-suggestion.tsx、mention-utils.ts、FileSearchBar.tsx
- SidePanel 顶部 FileSearchBar（会话/项目统一搜索 + 来源徽标 + 自动定位）、会话附加文件「移入项目文件」
- 会话引用搜索支持跨工作区 + workspaceName/slug（供命令菜单描述）
- Mention 新增 referenceType（todo/calendar_event 预留，供 P0-1 接入）、isDirectory、commandMenuMention 属性

### 2026-08-01：思考默认收起
- ContentBlock ThinkingBlock 默认折叠（移除 thinkingExpandedAtom 全局偏好，移除「展开思考」开关）
- Chat 模式 Reasoning 组件保持原样（流式展开、结束 1s 后自动收起）

### 2026-08-01：Pi Skill 加载器移植（借鉴上游 skillsOverride + 按需展开）
- 新增 `pi-skill-loader.ts`：白名单过滤（realpath 防 symlink 逃逸）+ `/skill:xxx` 按需展开 + frontmatter 剥离 + XML 包裹
- pi-agent-adapter.ts：`noSkills: true` + `skillsOverride`（不再全盘扫描，只保留工作区 skills 目录内 skill）
- 链路：renderer skill mention → orchestrator `mentionedSkills` → `runPiAgent({ skillMentions })` → `preparePromptWithPromaSkills` 注入 prompt 头部
- 19 个单元测试覆盖：白名单、路径安全、frontmatter、正则提取、按需展开

### 2026-08-01：Proma/AI SDK Runtime Skill 支持（自研 runtime 补上矩阵待办第一条）
- 新增 `tool-impls/skill-tool.ts`：`ReadSkill` 工具（skill_slug + 可选 file_path），复用 `readSkillFile` 安全层；readSkillFile 增加 `allowSkillMd` 透传（默认读 SKILL.md）
- `createCoreTools({ workspaceSlug? })`：有工作区才注册 ReadSkill；加入 CORE_TOOL_NAMES + SAFE_TOOLS（只读免审批）
- `buildAgentSystemPrompt(base, cwd, skillContext?)`：注入 `<available_skills>` 清单 + 「使用 Skill 前必须先 ReadSkill」指引
- Proma/AI SDK adapter：skillMentions + `/skill:xxx` → `<skill_requested>` 指令块注入 prompt 头部；工具执行 ctx 携带 workspaceSlug
- orchestrator：runProviderAgnosticAgent 传 `skillMentions: mentionedSkills`（AI SDK 走同一入口）
- 7 个 skill-tool 单测 + 3 个 prompt-builder 单测；全量 513 pass
- 设计差异：自研 runtime 靠「提示词引导 + ReadSkill 工具」而非 SDK 注入（与 Pi/Claude 本质不同，属预期）
