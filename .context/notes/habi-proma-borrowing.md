# habi 对 Proma 的可借鉴设计分析

更新时间：2026-07-31（含 macOS 灵动岛参考实现逆向分析）

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

macOS 没有供普通 Mac 应用直接使用的 iPhone Dynamic Island / Live Activity API。实现应是刘海附近的非激活浮层。

- 直接使用原生 NSPanel + SwiftUI（见下方参考实现），而不是 Electron BrowserWindow；JS 只负责业务，原生只管画。
- 无刘海机型退化为顶部贴顶通知条。
- 非 macOS / Windows：原生模块不加载，notify 返回 `{ ok: false, reason: "unsupported" }`，降级到系统通知。

推荐状态：

- running：紧凑显示任务标题、阶段和进度。
- waiting_action：展开提示需要审批或回答，点击打开对应会话；敏感审批仍回主应用完成。
- completed：短暂显示摘要后自动收起。
- failed：显示错误状态和打开会话入口。
- 多任务：同一时刻只显示一条，其余排队；同 id 就地替换（进度刷新不重播入场动画）。

默认不显示完整 Prompt、文件路径或消息正文，防止锁屏、投屏和共享屏幕时泄露。

## macOS 灵动岛参考实现（weavelynx 逆向分析）

以下为已验证落地的插件实现，可作为 Proma 刘海通知扩展的架构蓝图。整体分层：**JS 管业务（队列/计时/配置/路由），Swift 只管画**。

### 1. 后端大脑（defineExtension 注册）

通过 `weavelynx.defineExtension` 注册，`activeOnStart: true` 装完即活。对外暴露：

| 方法 | 作用 |
| --- | --- |
| `notify(args)` | AI 主动调用，`source="ai"` |
| `dismiss({id})` | 关掉某条 |
| `_getState()` | 给设置面板读「支持/运行中/开关/最近 20 条」 |
| `_setEnabled` / `_getProjectMuted` / `_setProjectMuted` | 设置面板开关 |
| `_test()` | 面板「发送测试通知」按钮，`source="manual"` |

### 2. 三源归一

AI 调用、hook 上报、手动测试三处入口统一成同一个 `NotifyRequest` 形状。归一化：

- 默认 `level=info`。
- 算 `timeoutMs`：`progress` 常驻=0，其余 4500ms。
- 截断 title 48 字 / body 72 字。
- 补 `createdAt` 和自动 `id`。

后端只按 `source` 区分来源，处理路径完全一样。

### 3. Hook 入口 = unix socket

`onActivate` 时创建 `net.createServer` 监听 `~/.weavelynx/ext-config/dynamicisland/ipc.sock`。收到一行 JSON 后：

- 带 `hook_event_name` → 按 hook payload 转默认通知：`Stop` → success「任务已完成」，`Notification` → warning「需要你的确认」+ `activateOnClick`。
- 否则当普通 `{title, ...}` 处理。
- 通过「总开关开 + 当前项目没静音」判断后才真正弹。

### 4. 通知队列状态机

同一时刻只显示一条，其余排队。`show()` 就地更新：

- `current.id === 新id` → 直接替换 current（不重播入场动画、不重置计时）。
- 在 queue 里找到同 id → 原地替换 queue 那条。
- 否则有 current 则推进 queue；没有则成为 current。

这就是「同 id 就地刷新进度」的底层实现。

### 5. 渲染控制器 + 渲染子进程

- 控制器持有队列，每次 `sync()` 把 current（含排队 +N）序列化成 `{type:"render", view}` 发给子进程，并 `setTimeout` 一个 unref 计时器过期；`progress`（timeoutMs=0）不挂计时器。
- 子进程用 `child_process.spawn` 拉起 `island.fork.js`，启动器优先用宿主提供的 bun / Electron-as-node 路径，找不到回退 PATH 里的 node。
- 崩溃重启：60s 内最多 3 次，超过放弃到下次 notify。
- stdin 不可写就丢命令；SIGTERM 后 1.5s 兜底 SIGKILL。

### 6. 渲染胶水进程

`island.fork.js` 只有 3 行有效代码，纯胶水：

```js
const native = require(.../native/darwin/island.node)
native.start({ width: 460, height: 140 })  // ISLAND_WIDTH/HEIGHT 环境变量可覆盖
```

生命周期由后端控制：stdin 写 `JSON\n` 命令（render / clear），stdout 回事件（clicked / log）。

### 7. 原生 Swift 模块（darwin/island.node）

- **窗口**：NSPanel（无边框、置顶、绕过普通窗口层级、非激活态、不抢焦点）。
- **贴合刘海**：读 NSScreen `safeAreaInsets` / notch / `_notchSize`，把窗口精确叠在物理刘海正上方；无刘海机型走 NotchlessView 退化为贴顶通知条。
- **UI**：SwiftUI 渲染 DynamicNotch（State / Style / TransitionConfiguration），支持收起/展开过渡和 hover 行为。
- **图标与颜色**：SF Symbols（`checkmark.circle.fill` 等），info=#0a84ff / success=#30d158 / warning=#ff9f0a / error=#ff453a / progress=#64d2ff。
- **通信**：`fileHandleWithStandardError` 打日志，stdin 读 JSON（`JSONObjectWithData:`），EOF 退出；stdout 回事件 JSON。

### 8. 自动通知链路（装完即生效，不碰用户配置）

```text
宿主 Stop/Notification 事件
  → hooks.json 静态注册（Stop + Notification, async, timeout 5s）
  → notify.sh（极轻 shell 脚本）
      - [ -S "$sock" ] || exit 0   # socket 不在 = 扩展没跑/不是 mac，微秒退出
      - nc -U -w 2 "$sock"          # stdin(hook payload) 原样透传，实测 6ms
  → unix socket → 后端解析 → 判断开关 → notify()
```

为什么用 sh + nc 而不是 node：hooks.json 是静态文件，没法写死运行时才知道的 launcher 绝对路径（Electron-as-node / bun 路径因机器而异）；nc 是 macOS 自带、零解析，整条链路 6ms（对比 node 冷启动 60ms+）。三条铁律：永远 exit 0（不阻断会话）、不写 stdout（不干扰宿主）、秒退（扩展没跑立刻退出）。

### 9. 升级清理（防御性保护用户配置）

0.1.0 老版本往用户 `~/.claude/settings.json` 注入 hook；0.2.0 改为插件自带 hook 后，onActivate 会把旧的注入条目摘掉。只删自己注入的条目、用原子 rename 替换、文件不是合法 JSON 就拒绝写入（宁肯留着旧条目）。

### 10. 关键设计点小结

- **职责分离**：JS 管业务（队列/计时/配置/路由），Swift 只管画——Windows 上原生模块根本不加载，notify 直接返回 unsupported。
- **同 id 就地更新**：队列状态机的「原地替换」语义，进度刷新不闪。
- **三源同构**：AI / hook / 测试共用一套 NotifyRequest，只按 source 记录来源。
- **配置隔离**：开关写在扩展自己的 `config.json`，刻意不碰宿主 settings（除升级清理那一个例外）。
- **崩溃自愈**：渲染进程崩了后端会重启，最多 3 次/分钟，且只有下次 notify 才重新拉起——不空转。

## 插件安全架构

推荐链路：

```
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

参考实现印证：灵动岛插件的原生模块在独立渲染子进程中加载（由后端 spawn），与宿主主进程通过 JSON 协议通信，原生代码不进入主进程、不继承宿主 TCC/凭据权限——这是「第三方不能碰主进程」的可行样板。

### 与参考实现的映射

| 安全建议 | 参考实现做法 |
| --- | --- |
| 原生能力隔离在主进程外 | island.node 只在 fork 子进程加载，宿主只 spawn + JSON 通信 |
| 事件按权限投影 | 后端只把队列状态序列化成 view 发给子进程，不传原始消息 |
| 插件自愈与降级 | 崩溃重启 3 次/分钟；无 socket / 非 mac / Windows 直接降级 |
| 配置隔离 | 开关写扩展自己的 config.json，不碰宿主 settings |
| 用户配置保护 | 升级清理只删自己注入的条目，非法 JSON 拒绝写入 |
| 零干扰宿主 | notify.sh 永远 exit 0、不写 stdout、秒退 |

## 分阶段路线

### P0：先收敛底座

1. 修复测试、运行沙箱与用户工作区隔离；测试不得污染真实配置目录。
2. 定义统一 `AppEventEnvelope`：started、progress、waiting_action、completed、failed。
3. 将 renderer Web Notification 收口为主进程 NotificationCoordinator，保留现有系统通知 fallback。
4. 明确 Chat、Agent、Workflow 的跨模式转换。

### P1：第一方扩展验证

1. 定义 PluginManifest、权限模型、安装状态和生命周期。
2. 设置增加“扩展”中心：权限、启停、故障、版本。
3. 将 macOS 刘海任务通知做成第一方内置扩展，按参考实现落地：
   - 三源归一（AI / hook / 手动测试共用 NotifyRequest）；
   - 通知队列状态机（同 id 就地替换 + 排队）；
   - 宿主事件 → hooks.json + notify.sh + unix socket 的零侵入链路；
   - 独立渲染子进程加载原生 island.node（NSPanel 贴合刘海，无刘海退化为贴顶条）；
   - 配置隔离与崩溃自愈；Windows/非 mac 降级到系统通知。
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