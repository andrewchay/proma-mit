# Proma 生态化实施总结（P0-P2）

> 时间：2026-08-01
> 规划来源：`.context/plan/habi-borrowing-roadmap.md`
> 现状：P0、P1、P2 三阶段全部完成并合入

## 一句话

Proma 从「一组功能」收敛为「一套工作系统」，建立了统一事件契约、通知协调、能力/扩展心智，
并以灵动岛为第一方样板验证了「主进程拥有状态、渲染层只画、扩展声明式管理」的完整链路。

## 统一心智（已落地）

> Chat 用来探索，Agent 用来完成，Workflow 用来重复；Workspace 保存上下文，Extensions 扩展能力和触达面。

- Agent / Workflow / Chat 三模式并列（ModeSwitcher）
- 跨模式转换：Chat→Agent（MigrateToAgentButton）、Agent→Workflow（SaveAsWorkflowButton）
- 能力指示器统一展示 MCP · Skills · 扩展

## P0：收敛底座（4/4 ✅）

| 任务 | 交付 |
|---|---|
| P0-1 测试/沙箱隔离 | 清理 15 个历史残留目录；CLAUDE.md 固化测试隔离/原生产物/打包规则 |
| P0-2 统一 AppEventEnvelope | shared 五态契约（started/progress/waiting_action/completed/failed）；AppEventBus 归一化层（8 测试） |
| P0-3 通知收口 | 评估报告 + 两步实现：主进程 SystemNotificationService → 完整 NotificationCoordinator（灵动岛优先 + 提示音 IPC + renderer 移除发通知） |
| P0-4 跨模式转换 | Chat→Agent 已有；Agent→Workflow 草稿（SaveAsWorkflowButton）；Workflow→Automation schedule UI 待后续 |

## P1：第一方扩展验证（4/4 ✅）

| 任务 | 交付 |
|---|---|
| P1-1 Manifest 骨架 | `plugin.ts` 类型：manifest/权限/生命周期/BUILTIN_PLUGINS |
| P1-2 扩展中心 | PluginManager 主进程服务 + 设置「扩展」tab（列表/启停/权限/surfaces/订阅） |
| P1-3 灵动岛插件化 | manifest 声明 + 启停联动灵动岛开关（配置隔离） |
| P1-4 能力发现统一 | 侧边栏指示器「MCP · Skills · 扩展」 |

## P2：形成复利（4/4 ✅）

| 任务 | 交付 |
|---|---|
| P2-1 本地运行记录 | RunStore 订阅 AppEventBus → JSONL（按月分片，2000 上限）；Context Hub 起点 |
| P2-2 统一 Run Center | 设置页「运行记录」：统一历史/来源筛选/导航会话/清空 |
| P2-3 飞书状态卡片 | completed/failed/waiting_action 状态色 + 查看详情按钮；失败自动从 RunStore 查 |
| P2-4 插件 SDK 契约 | extension-sdk.md：契约/权限/生命周期/安全边界/开放前清单（运行时未开放） |

## 关键架构成果

### 统一事件链路（P0-2 核心）
```
AgentEventBus（底层流）
  → AppEventBus（归一化 AppEventEnvelope）
     → NotificationCoordinator（系统通知/灵动岛优先/提示音）
     → RunStore（持久化运行记录）
     → （未来）飞书/托盘/Run Center 统一消费
```

### 通知收口（P0-3）
- renderer 不再直接发系统通知（只播音频 + 请求入队 UI）
- 主进程单一协调器决策：waiting_action/completed/failed → 通知；started/progress 不打扰
- 灵动岛启用时 Agent 事件走浮层，避免双通知

### 灵动岛（跨阶段样板）
- 通知条 → 会话状态机（phase/attention/pill/节流）
- ObjC NSPanel 260x40 胶囊 + 内容居中 + 鼠标穿透 + NSApp runloop
- 平台降级：mac 原生 / 无刘海贴顶 / 非 mac 系统通知
- 第一方插件化（PluginManager 管理启停）

### 扩展心智
- Skill=方法 / MCP=连接 / Tool=动作 / Workflow=编排 / Extension=产品扩展包
- 声明式权限（默认禁 FS/Shell/凭据/原生模块）
- 原生能力独立 helper 代理，第三方不碰主进程

## 测试基线

- 全仓 typecheck ✅
- 单测：**419 pass / 0 fail**（+26 于 P0-P2 期间）
- 构建/打包 ✅（macOS arm64）

## 后续建议（P0-P2 之外）

### 短期
1. Workflow 编辑器支持 schedule trigger UI（P0-4 剩余）
2. NotificationCoordinator 接入 Workflow/Automation 事件源（当前只归一 Agent 流）
3. RunStore 增加导出/清理策略（Context Hub 数据治理）

### 中期
4. Context Hub 增强：关联 Workflow Run / Task / Calendar / Artifact（当前只 Agent）
5. 钉钉状态卡片 + 审批/重试交互按钮
6. 插件签名验证与 sandbox 加载器（按 extension-sdk.md 检查清单）

### 长期
7. 第三方插件 SDK 开放（先稳定契约 + 签名 + 权限审批 + 崩溃隔离）
8. 本地语义索引（不从全量文件向量化开始，先高质量结构化事实）

## 关键文档索引

- 规划：`.context/plan/habi-borrowing-roadmap.md`
- 通知收口评估：`.context/plan/p0-3-notification-assessment.md`
- 插件 SDK 契约：`.context/notes/extension-sdk.md`
- habi 借鉴分析：`.context/notes/habi-proma-borrowing.md`
- Proma 官方灵动岛调研：`.context/notes/proma-agent-island.md`
- 项目规则：`/Users/chaihao/.proma/agent-workspaces/proma-mit/CLAUDE.md`
