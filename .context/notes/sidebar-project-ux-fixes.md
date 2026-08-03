# 侧边栏 / 项目 / 星标 UX 修复记录（2026-08-04）

> 背景：用户反馈 4 个问题——无法删除项目、星标应在会话而非项目、侧边栏太窄且不可拖动、侧边栏与主区/主区与文件面板之间有间隔。已全部修复。

## 1. 项目（工作区）删除入口

- **根因**：旧 `WorkspaceSelector.tsx` 含删除/重命名入口，但已变成**死代码**（无任何组件引用），导致删除入口消失。
- **处理**：`WorkspaceSelector.tsx` 已**删除**（含 `agent/index.ts` 导出与仅它使用的 `workspaceListHeightAtom`）。
- **当前入口**：左侧边栏「进行中的项目」列表，hover 项目行 → 🗑 删除（带确认弹窗）。逻辑：默认工作区（slug=default）与最后一个项目不可删；删除当前项目自动切到剩余第一个。
- **相关组件**：`CollapsedWorkspacePopover`（折叠 rail 快速切换，仅切换+新建）、`useWorkspaceActions`（切换/创建共享逻辑）。

## 2. 星标语义：会话级，项目级取消

- 项目行 ⭐「星标项目」按钮已移除；`togglePinAgentWorkspace` IPC 保留但 UI 不再暴露。
- 会话/对话的「置顶」统一改为「星标」：图标 Pin→Star（已星标显示 `text-amber-500 fill-current`），文案「置顶对话/置顶会话」→「星标对话/星标会话」。
- 涉及文件：`LeftSidebar.tsx`、`ChatHeader.tsx`（Chat 会话头部星标按钮）、`GeneralSettings.tsx`（自动归档文案）。
- 数据字段 `pinned` / IPC 名 `togglePinConversation/togglePinAgentSession` **保持不变**（仅 UI 语义改名）。

## 3. 侧边栏可拖拽调宽

- `sidebarWidthAtom`（`sidebar-atoms.ts`，localStorage key `proma-sidebar-width`，默认 260）。
- `AppShell.tsx` 在侧边栏右缘提供拖拽手柄，宽度 clamp 200~440px，拖拽中 `resizing` 禁用宽度 transition 保证跟手。
- `LeftSidebar` 展开态 `flexShrink: 0`，宽度精确等于设置值。

## 4. 布局无间隔规则（AppShell 布局约定）

- 侧边栏（展开态）与主区之间、主区与右侧文件面板（打开时）之间 **零 padding 间隔**。
- 中间容器 `p-2` + 条件 `pl-0`（侧边栏展开）/ `pl-2`（折叠 rail 时）/ `pr-0`（右侧面板打开）/ `pr-2`（否则窗口边缘）。
- 圆角配合：侧边栏右侧 `rounded-r-none`、主区左右按贴边状态直角（`MainArea.tsx` 根据 `sidebarCollapsedAtom` + 右侧面板状态计算）、`SidePanel` 左侧直角。
- 折叠成 rail 时保留小间隔与整体圆角（胶囊形态）。

## 5. 注意事项

- ⚠️ `apps/server/src/real-e2e.test.ts` 存在**既有失败**：provider 矩阵缺少 `deepseek-openai`（与本次 UI 改动无关，上游新增 provider 未同步到 server 矩阵）。
- 本次改动文件：`AppShell.tsx` / `LeftSidebar.tsx` / `MainArea.tsx` / `SidePanel.tsx` / `sidebar-atoms.ts` / `ChatHeader.tsx` / `GeneralSettings.tsx` / `CollapsedWorkspacePopover.tsx`（注释）/ `useWorkspaceActions.ts`（注释），删除 `WorkspaceSelector.tsx`。
