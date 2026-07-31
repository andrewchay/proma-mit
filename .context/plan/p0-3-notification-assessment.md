# P0-3 通知收口评估报告

> 评估时间：2026-08-01
> 目标：把 renderer Web Notification 收口为主进程 NotificationCoordinator
> 结论：**建议分两步走**——先引入「主进程系统通知 API」替代 renderer `new Notification`，
> 再视需要演进为完整 NotificationCoordinator。当前不一次性大改。

## 现状

### Renderer 通知（3 个调用点，全部在 useGlobalAgentListeners.ts）
1. `sendBlockingNotification`（第 357 行）：权限/提问/计划审批 → `force: true` + 提示音
2. 流式完成（第 817 行）：任务完成 → `taskComplete` 提示音 + 导航
3. 其他（飞书通知送达等经 onFeishuNotificationSent 间接触发）

实现：`renderer/atoms/notifications.ts` 的 `sendDesktopNotification`：
- `new Notification(title, {body, silent})`（Web Notification API）
- HTML Audio 播放提示音（8 个音效资源）
- 点击 → `window.focus()` + onNavigate

### 主进程通知现状
- **无主进程系统通知**（未用 Electron `Notification`）
- feishu-bridge 只有「飞书卡片通知」，不涉及系统通知

## 关键约束

1. **提示音在 renderer**：8 个 mp3 资源 + `playNotificationSound`，收口需迁移音频播放到主进程（或保留 renderer 音频）
2. **导航回调在 renderer**：`onNavigate` 依赖 Jotai store（tabs/conversations），主进程无法直接执行——需要 IPC 事件回传
3. **开关/音效配置在 settings**：主进程可读，但「通知音选择器」UI 在 renderer

## 推荐方案（分两步）

### 第一步（推荐，低风险）：主进程提供系统通知 API，renderer 委托
- 主进程新增 `notifications` 服务：
  - `sendSystemNotification({title, body, sessionId?, soundType?})` → Electron `new Notification` + `app.dock.bounce?.(...)`（macOS）
  - 保留 renderer 播放提示音（音频资源不动）
- preload 暴露 `sendSystemNotification`
- renderer `sendDesktopNotification` 改为：调 IPC 发系统通知 + 保留音频逻辑
- **改动面**：新增 ~80 行主进程 + ~30 行 preload；renderer 只改 `sendDesktopNotification` 内部

收益：通知从「窗口内 Web API」变为「主进程系统级」，锁屏/后台也能收到，点击事件由主进程处理。

### 第二步（可选）：完整 NotificationCoordinator
- 主进程统一接收 AppEventEnvelope（P0-2 已完成），按策略路由到：灵动岛 / 系统通知 / 托盘
- renderer 通知全部移除，由主进程直接发
- **改动面**：renderer `useGlobalAgentListeners` 3 处调用点迁移 + 通知音迁移主进程（较大）

## 建议

**先做第一步**（本轮 P0-3 交付评估，实现列入 P0 后续或 P1）：
- 改动可控（新增 + 委托，不迁移音频/导航）
- 立即解决「窗口未聚焦时通知不可靠」问题
- 为第二步（完整 Coordinator）打好基础

第二步待第一步稳定后再做，避免一次性大改引入回归。
