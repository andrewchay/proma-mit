# 移除会话多标签，主区只对应当前激活会话

日期：2026-11-13
状态：设计已确认，待实现

## 背景

主区顶部目前有一条 VS Code 风格的标签栏（`TabBar`），用于在多个已打开的会话之间切换。实际使用中，用户主要通过左侧边栏选择会话；顶部标签栏占用的 34px 高度没有换来对应的价值，反而引入两套并行的"当前会话"状态。

本设计移除多标签模型，主区恒定渲染侧边栏当前选中的那一个会话。

## 目标

- 主区顶部不再有标签栏，垂直空间还给会话内容。
- "当前会话"只有一个权威来源，消除标签与渲染状态之间的同步代码。
- Scratch Pad 不丢失，改为侧边栏入口。
- 不改变用户选择会话的方式（仍走左侧边栏）。

## 非目标

- 不做分屏 / 并排会话（代码里已有历史遗留的 splitLayout 兼容分支，本次一并清理）。
- 不改变会话本身的存储、消息格式或主进程协议。
- 不调整左侧边栏的会话列表交互。

## 设计

### 状态源

当前存在两套状态：

| 层 | 状态 | 位置 |
|---|---|---|
| 标签层 | `tabsAtom`、`activeTabIdAtom`、`activeTabAtom`、`tabMruAtom` | `atoms/tab-atoms.ts` |
| 渲染层 | `currentConversationIdAtom`、`currentAgentSessionIdAtom`、`appModeAtom` | `atoms/chat-atoms.ts`、`atoms/agent-atoms.ts`、`atoms/app-mode.ts` |

移除标签层，只保留渲染层。`appModeAtom`（`'chat' | 'agent' | 'scratch'`）成为主区渲染的唯一判据。

### 删除项

`atoms/tab-atoms.ts` 整体删除，包括：

- `tabsAtom`、`activeTabIdAtom`、`activeTabAtom`、`tabMruAtom`
- `tabIndicatorMapAtom`、`tabStreamingMapAtom`、`tabMinimapCacheAtom`
- `openTab`、`openTabPreview`、`openTabPermanent`、`closeTab`、`reorderTabs`、`ensureScratchPadTab`
- `SCRATCH_PAD_ID`、`SCRATCH_PAD_TITLE`、`TabItem`、`TabType`、`PersistedTabState`

`components/tabs/` 下的 `TabBar.tsx`、`TabBarItem.tsx`、`TabSwitcher.tsx`、`TabPreviewPanel.tsx` 删除。

`hooks/useCloseTab.tsx` 删除（关闭语义整体消失）。

`hooks/useSyncActiveTabSideEffects.ts` 删除（其职责并入 `useOpenSession`）。

### 保留并改名

| 现名 | 新名 | 理由 |
|---|---|---|
| `TabErrorBoundary` | `SessionErrorBoundary` | 每个会话独立错误边界的价值不变 |
| `TabContent` | 并入 `MainArea` | 只有一种渲染路径，单独的组件层没有收益 |
| `TabCloseConfirmDialog` | 删除 | 只在"关闭流式中的标签"时使用 |

### `useOpenSession` 保持签名

`hooks/useOpenSession.ts` 是 10+ 组件的统一入口（左侧边栏、搜索、Run Center、Mailbox、AgentView、AgentTeamPanel、ProactiveRunCard…）。**保持三个函数的签名不变**，实现收敛为同一段逻辑：

```ts
function activateSession(type: 'chat' | 'agent', sessionId: string): void
```

行为：

1. `setAppMode(type)`，`setActiveView('conversations')`
2. chat → `setCurrentConversationId(sessionId)`；agent → `setCurrentAgentSessionId(sessionId)`
3. agent 额外清除 `unviewedCompletedSessionIdsAtom` 中该会话
4. agent 额外同步 `currentAgentWorkspaceIdAtom` 并写回 `settings.agentWorkspaceId`

`openSessionPreview` / `openSessionPermanent` 保留为 `openSession` 的别名，避免一次性改动 10+ 个调用点。它们的"临时预览/常驻"语义随之失效，但调用方无需感知。

### MainArea 渲染

```
appMode === 'chat' && currentConversationId  → <ChatView conversationId={...} />
appMode === 'agent' && currentAgentSessionId → <AgentView sessionId={...} />
appMode === 'scratch'                        → <ScratchPadView />
否则                                          → <WelcomeView />
```

包一层 `SessionErrorBoundary`，`key` 为会话 ID，切换会话时重置错误状态。

工作模块视图（`settings` / `workflow` / `proactive` / projects 等）的判断逻辑不变，仍在 `activeViewAtom` 分支上。

### 持久化

`AppSettings.tabState: PersistedTabSettings` 替换为：

```ts
export interface PersistedSessionState {
  mode: 'chat' | 'agent' | 'scratch'
  conversationId: string | null
  agentSessionId: string | null
}
```

`main.tsx` 的 `TabStatePersistenceInitializer` 改为 `SessionStatePersistenceInitializer`：

- **读取**：优先读新字段；缺失时回退解析旧 `tabState.activeTabId` + `tabs[]`，取 active 那个会话（含 `splitLayout` 历史兼容分支）。
- **写入**：只写三个标量，防抖 500ms + `beforeunload` 同步落盘。
- **清理**：恢复时校验会话仍存在，已被删除则回落 `WelcomeView`。

旧 `tabState` 字段保留读取能力但不再写入；下一个大版本可移除。

### Scratch Pad

`activeViewAtom` 增加 `'scratch'` 取值。左侧边栏底部（用户资料/设置按钮上方）增加一个便签图标入口。

`ScratchPadView` 组件与其自动保存逻辑（`scratchPadContentAtom` → `~/.gravitas/scratch-pad.md`）保持不变，只是不再通过标签页挂载。

进入 Scratch Pad 时 `appModeAtom` 设为 `'scratch'`，主区渲染 `ScratchPadView`；左侧边栏的 chat/agent 会话列表保持上一次状态，不因进入便签而清空。

### 快捷键

| 快捷键 | 现状 | 变更 |
|---|---|---|
| `Cmd+W` | 关闭当前标签页 | 改为关闭窗口（`role: 'close'`），移除 `menu:close-tab` IPC |
| `Ctrl+Tab` | MRU 标签切换器 | 删除 |
| `Cmd+Shift+B` | 切换文件面板 | 不变 |

`main/menu.ts` 中"文件 → 关闭标签页"菜单项改为系统默认的关闭窗口。

### 内存清理时机

`useCloseTab.cleanupMapAtoms` 现在挂在"关闭标签"上，负责清理 per-session 的 Map atoms（流式状态、草稿、预览缓存、附件 blob URL 等）。

标签关闭语义消失后，清理时机改为**删除或归档会话时**（`LeftSidebar` 的 `handleConfirmDelete` / 归档处理）。

同时打开的会话状态会一直驻留内存。按用户实际使用（同时打开 3-5 个会话）判断，成本可接受；`agentSessionStreamingStateAtomFamily` 等 atomFamily 的强引用会随会话数量线性增长，但每个会话的流式状态在完成结算后会被清空，不构成泄漏。

## 风险

| 风险 | 缓解 |
|---|---|
| 隐藏的多开入口被遗漏（托盘、深链、通知点击） | 全部走 `useOpenSession`，实现收敛后自动一致；实现时用 `grep -rn "tabsAtom\|activeTabIdAtom"` 确认零残留 |
| 旧 settings.json 里的 `tabState` 让应用启动崩溃 | 读取侧做格式校验与回退，任何解析异常都回落欢迎页而非抛错 |
| 用户误以为能同时看两个会话 | 这是有意的产品取舍；侧边栏状态指示（running/completed）仍在，可切换查看 |

## 验收

- [ ] 主区顶部无标签栏，垂直空间增加 34px
- [ ] 侧边栏点击会话 → 主区立即切换，无中间态
- [ ] 重启应用后恢复上次会话
- [ ] 旧 `tabState` 格式可正常恢复
- [ ] Scratch Pad 可从侧边栏打开，内容与自动保存正常
- [ ] `Cmd+W` 关闭窗口
- [ ] 删除会话时清理对应内存状态，无残留
- [ ] 全仓 `grep "tabsAtom"` 零命中
- [ ] typecheck、Biome、受影响的既有测试通过

## 影响面

约 25 个文件。核心是 `atoms/tab-atoms.ts`（删除）、`components/tabs/`（大部分删除）、`hooks/useOpenSession.ts`（实现收敛）、`components/tabs/MainArea.tsx`（渲染简化）、`main.tsx`（持久化改造）、`components/app-shell/LeftSidebar.tsx`（新增便签入口 + 清理时机）、`main/menu.ts`（Cmd+W）。
