# habi 对 Proma 的可借鉴设计分析

更新时间：2026-07-31

## 核心结论

Proma 应借鉴 habi 的生态组织方式，而不是照搬其企业基础设施规模或垂直应用矩阵。

Proma 已经有 Chat、Agent、Workflow、Automation、Workspace、Skills、MCP、Bridge、权限和审计等关键零件。当前主要缺口不是功能数量，而是这些零件尚未形成稳定、统一、可解释的产品契约。

建议统一用户心智：

> Chat 用来探索，Agent 用来完成，Workflow 用来重复；Workspace 保存上下文，Extensions 扩展能力和触达面。

## 推荐产品分层

1. 入口与任务形态
   - Chat：承接模糊需求、探索和澄清。
   - Agent：完成一次有明确结果的复杂任务。
   - Workflow：把稳定方法发布为可重复、可审计的流程。
   - Automation：负责触发 Agent 或 Workflow，不作为第四种一级模式。

2. Context
   - Workspace、会话、文件、记忆、任务、日程、产物和运行记录。
   - 工作区是用户拥有的上下文与权限边界；测试目录、会话沙箱、Workflow Run 目录不得作为用户工作区展示。

3. Capability
   - Skill 是方法。
   - MCP 是外部连接。
   - Tool 是确定性动作。
   - Workflow 是编排。
   - Extension 是可安装的产品扩展包。

4. Reach
   - 桌面主窗口、Quick Task、菜单栏、系统通知、macOS 刘海浮层、飞书/钉钉/微信等只是同一任务系统的不同触达面。

5. Governance
   - 凭据、权限、审批、审计、预算、运行时和插件生命周期统一收敛。

## 最值得借鉴的 habi 机制

### 一套底座，可聚可散

Agent、Workflow、Chat 不应成为三个互相隔离的产品。三者应共享 Workspace、Capability、Run 和产物，并支持：

- Chat 中将澄清后的需求交给 Agent。
- Agent 成功任务可保存为 Workflow 草稿。
- Workflow 可绑定 Automation 或远程 Bridge。
- 任一入口产生的结果都回流到同一工作区资产。

### Ability 连接层

Proma 需要一个统一 Capability 契约，覆盖发现、授权、调用、版本、输入输出 Schema 和运行记录。UI 可以对普通用户统一称为“能力”或“扩展”，底层仍保留 Skills、MCP、Tools 等技术差异。

### 本地数据复利

不照搬企业 Data Center，建设本地优先的 Context Hub / Work Graph：

- 关联 Workspace、Session、Agent Run、Workflow Run、Automation Run、Task、Calendar 和 Artifact。
- 记录来源、更新时间、权限和用户确认状态。
- 优先沉淀高质量结构化事实，不从全量文件向量化开始。
- 支持把成功输出转化为 Skill、Workflow、Automation 或项目事实。

### 入口分工

桌面、Quick Task、Chat、Agent、Workflow 和 IM Bridge 应共享同一任务状态与上下文。Bridge 不只是设置项，而是本机 Proma 的远程入口；菜单栏和刘海通知是后台任务的低打扰入口。

### 插件共建

当前 `.claude-plugin/plugin.json` 只用于 Agent SDK 发现 Skills，不是 Electron 应用插件系统。MCP 只扩展模型工具面，也不能贡献原生窗口或 UI。

建议插件类型：

- Capability provider
- Workflow 节点与模板
- Automation trigger
- Bridge connector
- 通知、菜单栏、Overlay 等系统 surface
- 文件预览与产物 renderer

## macOS 刘海通知建议

macOS 没有供普通 Mac 应用直接使用的 iPhone Dynamic Island / Live Activity API。实现应是刘海附近的非激活浮层：

- MVP：Electron 透明、无边框、置顶 BrowserWindow。
- 正式版：Proma 自带并签名的 NSPanel helper，处理准确刘海区域、全屏 Space、多显示器、不抢焦点和点击穿透。
- 无刘海或非 macOS：降级到顶部 HUD、菜单栏或系统通知。

推荐状态：

- running：紧凑显示任务标题、阶段和进度。
- waiting_action：展开提示需要审批或回答，点击打开对应会话；敏感审批仍回主应用完成。
- completed：短暂显示摘要后自动收起。
- failed：显示错误状态和打开会话入口。
- 多任务：聚合为运行数量，避免多个浮层竞争。

默认不显示完整 Prompt、文件路径或消息正文，防止锁屏、投屏和共享屏幕时泄露。

## 插件安全架构

推荐链路：

```text
Agent / Workflow / Automation / Bridge
  -> AppEventBus
  -> CapabilityBroker（权限、脱敏、限流）
  -> NotificationCoordinator / PluginManager
  -> Platform Adapter / sandboxed UI surface
```

Manifest 应至少包含：

- schemaVersion、id、version、publisher、minHostVersion
- platforms、activationEvents、subscriptions
- surfaces、permissions、entrypoints
- settingsSchema、updateSource、签名或 hash

权限必须细分：

- 读取 Agent/Workflow 摘要事件
- 读取敏感正文
- 创建 Overlay 或系统通知
- 打开会话
- 受限网络域名
- 插件私有存储
- 全局快捷键

默认禁止文件系统、Shell、任意 IPC、渠道凭据、麦克风、Computer Use 和主进程原生模块。

第三方插件不能直接注入 Electron 主进程或复用完整 `electronAPI`。插件 UI 使用独立 sandboxed BrowserWindow/WebContentsView 和最小 preload；原生能力由 Proma 签名的平台 adapter 或独立 helper 代理。

## 分阶段路线

### P0：先收敛底座

1. 修复测试、运行沙箱与用户工作区隔离；测试不得污染真实配置目录。
2. 定义统一 `AppEventEnvelope`：started、progress、waiting_action、completed、failed。
3. 将 renderer Web Notification 收口为主进程 NotificationCoordinator，保留现有系统通知 fallback。
4. 明确 Chat、Agent、Workflow 的跨模式转换。

### P1：第一方扩展验证

1. 定义 PluginManifest、权限模型、安装状态和生命周期。
2. 设置增加“扩展”中心：权限、启停、故障、版本。
3. 将 macOS 刘海任务通知做成第一方内置扩展，验证事件订阅、surface 和平台降级。
4. 统一 Skills、MCP、Tools 与 Extensions 的能力发现体验，但不抹平底层安全差异。

### P2：形成复利

1. 建设本地 Context Hub / Work Graph。
2. 统一 Agent、Workflow、Automation 的 Run Center。
3. 飞书/钉钉等使用交互式状态卡片展示运行、审批、重试和结果。
4. 开放签名第三方插件 SDK、脚手架、兼容性测试和更新回滚。

## 不建议照搬

- 不自建公司级 GPU Inference 平台作为 Proma 核心方向；优先做多模型路由、成本、隐私和企业部署策略。
- 不把 Coding、Knowledge、PM、AIGC 等都新增为一级模式；优先做 Workflow Pack 或 Extension。
- 不做全量企业人员画像和集中数据采集，与本地优先定位冲突。
- 不先做插件市场；先用少量第一方插件稳定契约与安全边界。

## 关键风险

- 只有“能力中心”新名称，没有统一运行契约。
- 插件任意执行主进程代码，继承 Proma 的 TCC 和凭据权限。
- 插件 API 过早膨胀，未来无法兼容。
- Context Hub 变成隐式监控或积累过期错误事实。
- macOS 特效主导产品路线，跨平台体验失衡。
- 持续增加一级入口，让 Proma 退化为功能集合。

## 相关代码入口

- Agent 事件总线：`apps/electron/src/main/lib/agent-event-bus.ts`
- Agent 事件 IPC：`apps/electron/src/main/lib/agent-service.ts`
- Skills/MCP 与 SDK plugin：`apps/electron/src/main/lib/agent-workspace-manager.ts`
- Workflow 能力隔离：`apps/electron/src/main/lib/workflow-service.ts`
- 当前 renderer 通知：`apps/electron/src/renderer/atoms/notifications.ts`
- 透明置顶窗口参考：`apps/electron/src/main/lib/quick-task-window.ts`
- 系统托盘：`apps/electron/src/main/tray.ts`
