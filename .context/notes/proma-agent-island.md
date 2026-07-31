# 官方 Proma 灵动岛（Agent Island）实现调研

调研对象：`~/LLM/Proma`（官方 Proma 仓库）的 `agent-island` 实现。
对比：当前 proma-mit 已实现的灵动岛（移植自 weavelynx，NSPanel + ObjC，队列式单条通知）。
时间：2026-08-01

## 总体判断

官方 Proma 的灵动岛不是「通知条」，而是**常驻的 Agent 工作状态条（Work Pulse）**：
收起态是一个 pill 胶囊（240×52），展开态是短 briefing 卡片（最大 640×520）。
设计参考 Cindy（makecindy/cindy）的 Agent Island。

**最值得借鉴的不是窗口技术，而是「主进程状态机拥有全部产品状态，渲染层只管画」的分层，
以及围绕 Agent 会话的完整状态语义。**

## 架构分层

```
AgentEventBus ──→ agent-island-service.ts（主进程状态机，唯一状态真源）
                     │ 会话快照 Map（phase/detail/activityLines/attention）
                     │ pill 聚合摘要
                     │ JSONL snapshot 推送
                     ├─→ Electron 窗口（AgentIslandApp.tsx，renderer fallback）
                     └─→ macOS Swift helper（原生 NSPanel，macOS 主 surface）
```

原生 helper 不可用/失败时**自动降级到 Electron 窗口**，不是二选一。

## 关键机制（按借鉴价值排序）

### 1. 会话状态机（phase 模型）——最值得借鉴
每个 Agent 会话折叠为 5 态：`idle / running / needs-interaction / completed / error`。
事件映射完整覆盖：permission_request / ask_user / plan_review → needs-interaction；
SDK result → completed/error；tool_use → running + 活动行。

**相比 proma-mit 当前实现**：我们只有「通知」概念，事件来了弹一条、4.5s 消失；
官方是「会话常驻状态」，权限请求等交互保持 attention 直到用户处理。这是根本差异。

### 2. 可见性判定（Visibility Key + dismiss）——高级
- 每个会话有 `attention`（需注意）与 `unread`（未读完成）标记
- `isIslandSession`：running 可见（执行脉冲）、needs-interaction 可见、error 可见、
  completed 仅在 UNREAD_RETAIN_MS（10 分钟）内可见
- `buildVisibilityKey`：把当前状态序列化成指纹；用户 dismiss 后记住指纹，
  只有状态变化（新事件/新事项）才重新出现
- **dismiss 不是「关掉通知」而是「本次状态已看过」**，避免同一状态反复打扰

### 3. 优先级排序 + pill 聚合
- `attentionScore`：needs-interaction(3) > error(2) > completed(1)
- pill 摘要：priorityStatus / sessionCount / pendingInteractionCount / unreadCompletedCount
- 排序只按语义优先级，不按 lastActivityAt（避免高频 token 流导致行乱跳）

### 4. 推送节流（三级）
- 交互/计划变更：80ms 合并
- 普通 Agent 流事件：2000ms 低频合并（running 的 token 流不触发重绘）
- 状态无变化（JSON 相同）完全跳过
- **待办/日程的独立 planningRevision**：解决同毫秒变更漏推

### 5. 待办/日程投影 + Plan 额度轮播
- 原生岛读取 Todo/日程最小投影（不泄露 notes/tags）
- 日程「进入 1 小时窗口」自动唤起（scheduleNextPlanningAttention）
- Plan 额度 5 分钟后台刷新，Swift 本地轮播展示
- **Planning 是独立的「非 Agent 场景」，让灵动岛在无 Agent 时也有用**

### 6. macOS 原生 helper（Swift）——技术要点
- 独立 Swift 可执行文件（swiftc -O -parse-as-library 编译，837 行）
- 主进程 spawn，JSONL stdin/stdout，`ready`/`intent`/`fatal` 协议，4s ready 超时
- `NotchMetrics.hasNotch` 判定：**无刘海（如外接屏）直接隐藏 panel 并保持 click-through**，
  不在无刘海屏伪造刘海
- 交互 surface 精确贴合：不用巨大透明 WindowServer hit area，hover/click 立即响应
- `expandedHeight` 用 NSHostingView 实测 SwiftUI 树 fittingSize 动态量高
- 动画：NSAnimationContext 0.36s frame 动画
- 事件全在 stderr 打日志，stdout 保持 JSONL 干净

### 7. 双 surface 策略
- macOS 原生 helper 就绪 → 主 surface
- 否则 Electron BrowserWindow（AgentIslandApp.tsx）作为优雅降级
- 关键：`setAlwaysOnTop(true, 'pop-up-menu')`——pop-up-menu 层级高于菜单栏，
  黑色 Surface 与硬件刘海连续融合

### 8. mascot（宠物动画）
- Canvas 矢量手绘 body + 程序化眼睛，四状态动画映射 phase：
  idle 漂浮呼吸/眨眼/睡觉 Zzz；working 弹跳+敲键盘；waiting 感叹号+glow；completed 对勾
- 纯 Canvas 不依赖外部素材，16×16 单位坐标缩放

## 与 proma-mit 当前实现的差距

| 维度 | proma-mit（当前） | 官方 Proma |
|---|---|---|
| 概念 | 通知条（弹一条消失） | 会话状态条（常驻） |
| 状态 | 队列 + 4.5s 超时 | phase 状态机 + attention |
| 交互 | 点击开会话 | hover 展开 + 点击开会话 + dismiss |
| 多任务 | +N 排队徽标 | pill 聚合摘要 + 会话列表 |
| 待办/日程 | 无 | 投影 + 临近自动唤起 |
| 原生 | ObjC N-API 模块 | Swift 独立可执行 helper |
| 降级 | 无 | Electron 窗口 fallback |

## 建议借鉴（按优先级）

### P0（核心价值，直接改）
1. **从「通知」升级为「会话状态条」**：主进程维护 session → phase 状态机，
   订阅 AgentEventBus 全量事件（现在只处理了 permission/ask/plan/complete/error），
   增加 running 态实时 detail（当前工具名/等待内容）
2. **attention/unread 语义**：权限/提问保持 attention 直到用户点击；
   完成/错误 10 分钟内保留，之后消失

### P1（体验升级）
3. **Visibility Key + dismiss**：用户关闭后同状态不反复弹，新状态才出现
4. **pill 聚合**：多个会话折叠成「N 个待处理 · M 个执行中」摘要，
   收起态不占屏幕；点击展开会话列表
5. **推送节流**：普通流事件 2s 合并，避免 token 流刷屏

### P2（锦上添花）
6. **Todo/日程投影**：无 Agent 活动时显示今天待办/临近日程
7. **Electron fallback**：非 mac 或无刘海屏时降级到 Electron 小窗
8. **mascot**：会话 phase 驱动的宠物动画

## 不建议照搬
- 完整 mascot 动画体系（成本高，价值偏「玩具感」）
- Plan 额度轮播进灵动岛（proma-mit 已在模型选择页展示额度）
- 双 surface 完整实现（当前 ObjC 模块已够用，若未来加 Swift helper 再考虑）

## 关键技术文件
- 状态机：`apps/electron/src/main/lib/agent-island-service.ts`（929 行）
- 窗口：`apps/electron/src/main/lib/agent-island-window.ts`
- 原生 host：`apps/electron/src/main/lib/mac-agent-island-native-host.ts`
- Swift helper：`apps/electron/native/agent-island/macos-agent-island-helper.swift`（837 行）
- Renderer：`apps/electron/src/renderer/components/agent-island/AgentIslandApp.tsx`
- 类型契约：`packages/shared/src/types/agent-island.ts`
