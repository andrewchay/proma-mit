# PAA 工作模块迁移记录（项目管理 / 日程管家）

> 2026-08-04 · 将 `/Users/chaihao/LLM/PAA` 中的「项目管理」与「日程管家」两个功能模块迁入 proma-mit，
> 放置在左侧工作模块的对应位置（`projects` / `calendar`），配置能力一并迁入。

## 迁移内容

### 主进程服务（apps/electron/src/main/lib/）
- **日程管家**：`schedule-service.ts`、`schedule-nlp.ts`、`reminder-service.ts`、`reminder-ipc-handlers.ts`
- **日历同步**：`calendar-sync-service.ts`、`calendar-eventkit-bridge.ts`（含 `resources/read-calendar.swift`）
- **项目管理**：`project-types.ts`、`project-sqlite-store.ts`、`project-service.ts`、`project-summary-service.ts`、
  `project-alert-service.ts`、`project-agent-service.ts`、`project-sync-service.ts`、`project-auto-sync.ts`、
  `project-polling-service.ts`、`project-risk-service.ts`、`project-risk-report-service.ts`
- **依赖服务**：`dingtalk-doc-fetcher.ts`、`dingtalk-todo-provider.ts`、`feishu-todo-provider.ts`、
  `brief-service.ts`、`brief-callback-server.ts`、`dingtalk-connectivity.ts`、`contact-search-service.ts`
- **IPC 注册**：`work-module-ipc-handlers.ts`（schedule + calendar-sync + project + Todo Provider 初始化 + 轮询 + 自动同步）

### shared 层（packages/shared/）
- `types/work-module.ts`：`SCHEDULE_IPC_CHANNELS` / `CALENDAR_SYNC_IPC_CHANNELS` / `PROJECT_IPC_CHANNELS` 常量及请求/响应类型
- `types/index.ts` 追加导出

### Preload（apps/electron/src/preload/index.ts）
- `electronAPI.paa.schedule` / `electronAPI.paa.calendarSync` / `electronAPI.paa.project` 三组 API

### 渲染层（apps/electron/src/renderer/）
- `atoms/paa-atoms.ts`：schedule / calendar 相关 atoms
- `components/projects/ProjectView.tsx`：项目管理主视图
- `components/calendar/CalendarModuleView.tsx`：日程管家入口（子视图切换 日程管家 ↔ 日历同步）
- `components/calendar/ScheduleView.tsx` + `EventCreatePanel.tsx`：日程管家
- `components/calendar/CalendarSyncView.tsx`：日历同步
- `components/settings/CalendarSyncSettings.tsx`：日历同步配置（设置 → 日历同步）
- `hooks/useProjectActions.ts`
- `MainArea.tsx`：`projects` → ProjectView；`calendar` → CalendarModuleView；`tasks` 仍为占位

## 适配点（PAA → proma-mit）
- `@paa/shared` / `@paa/core` → `@proma/shared` / `@proma/core`
- `config-paths.ts` 新增：`getCalendarEventsPath` / `getCalendarDir` / `getTasksPath` / `getProjectsDir`
  （数据落在 `~/.proma-mit/calendar/`、`~/.proma-mit/projects/`）
- `settings-service.ts` 新增 `onSettingsChange`（PAA 原已有，proma-mit 缺失）
- `types/settings.ts` 新增 `feishuTodo` / `dingtalkTodo` / `briefCallback` 配置字段
- `feishu-bridge.ts` / `feishu-bridge-manager.ts` 新增 `sendProjectSummary`
- `apps/electron/package.json` 新增依赖 `sql.js`（+ `@types/sql.js`）
- `main/index.ts`：启动时 `initProjectDb()` + `startBriefCallbackServer()`；退出时 `closeProjectDb()`

## 数据与依赖
- 日程/任务：`~/.proma-mit/calendar/events.jsonl`、`tasks.jsonl`（JSONL 追加写）
- 项目：`~/.proma-mit/projects/paa.db`（sql.js SQLite，写后落盘）
- LLM 相关能力（会议纪要提取 / 风险报告 / 任务提取）复用 proma-mit 的渠道配置（`channel-manager`）
- 外部同步（飞书/钉钉 Todo）复用 proma-mit 已有 Bot Hub / dingtalk / feishu 配置

## 验证
- `bun run typecheck`（全仓库 7 个包全部通过）
- `bun run build:main` / `build:preload` / `build:renderer` 全部通过
- 相关既有测试通过

## 后续待办
- 「任务」模块仍为占位，PAA 侧任务模块完成后可参考本迁移方式接入
- 项目管理视图内「设置」Tab 为 `SettingsPlaceholder`，外部同步配置主要走 设置 → 日历同步 / 远程连接
