# MAPro WebBridge 重构为"多标签 + CDP AX + 真实输入 + 下载/站点信任" 实现规格

> 计划模式 · 供审阅
> 目标代码库：`/Users/chaihao/LLM/ma-proma`（product: MAPro）
> 参考（只作机制提炼，不复制代码）：`/Users/chaihao/LLM/Proma`（上游）
> 原则：基于需求 + Proma 的设计要点，在 MAPro 里自主实现。

---

## 0. 已确认的需求决策

| 决策点 | 选择 |
|--------|------|
| 集成形态 | 替换/重构现有 WebBridge |
| 优先保住 | 多标签页 + 结构化 AX 元素列表 + CDP 真实输入事件 + MAPro 下载&站点信任权限 |
| CDP 引擎 | Electron `webContents.debugger`（对标 Proma）|
| 首版目标 | 跑通垂直切片验证 |

---

## 1. 现状盘点（MAPro 已有能力 & 缺口）

### 已具备（重构必须保留）
- **下载**：`WebBridgeDownload`（fetch 落盘，≤50MB，web-bridge-downloads/{sessionId}）
- **上传**：`WebBridgeUpload`（系统文件选择器注入，不落盘、不暴露绝对路径）
- **站点信任权限**：`agent-permission-service.ts` 的 `trustedWebBridgeHosts`，导航/点击/输入/下载在可信域名下自动放行，`WebBridgeUpload` 永远逐次确认
- **外部 Chrome 桥接**：`ChromeCdpClient`（原生 WebSocket CDP）+ `WebBridgeChromeTargets/ConnectChrome`
- **PERMISSION_RULES**：`SAFE_TOOLS` 已含 Snapshot/Screenshot/Scroll/ChromeTargets/Status 只读类
- **preload IPC**：`getWebBridgeStatus / stopWebBridge / stopAllWebBridges`
- **web-bridge-audit**：逐操作审计

### 缺口（本次重构要补）
- **多标签页**：目前单 BrowserWindow 单页，无 tab 概念
- **结构化 AX**：目前用 DOM 遍历 `SNAPSHOT_SCRIPT`（querySelectorAll），**非** CDP `Accessibility.getFullAXTree`
- **CDP 真实输入**：目前受管窗口用 `executeJavaScript` 的 `element.click()`/value setter，**非** `Input.dispatchMouseEvent`/`insertText`
- **嵌入主窗口布局**：目前是独立 BrowserWindow，非嵌入 contentView（这是多标签的基础）
- **ref 代际失效**：无
- **可交互优先排序**：无

---

## 2. 目标架构

### 2.1 核心思路（对标 Proma，自主实现）
把"每个会话一个独立 BrowserWindow"改为"每个会话在一个嵌入主窗口 contentView 的 `WebContentsView` 集合上运行多标签"。

```
BrowserController（主进程单例）
├── 会话 Map<sessionId, SessionRecord>（partition / agentAbortController / ledger）
│   └── Tab Map<tabId, TabRecord>
│       ├── view: WebContentsView（webPreferences.sandbox + webSecurity）
│       ├── debugger: webContents.debugger  —— CDP 通道 ★
│       ├── refs: Map<ref, backendNodeId>  —— AX 元素引用
│       ├── generation（导航/关闭/重观察后失效）
│       └── lastActivityAt（供 tab 回收）
├── presentation（跨会话：同一时刻只有一个原生 View 前台可见）
└── 依赖 Proma 提炼的多标签文件
```

### 2.2 分层职责（对标 Proma 的模块划分，各自实现）
| MAPro 新文件 | 职责 | 提炼的机制要点 |
|--------------|------|----------------|
| `main/lib/browser-controller.ts` | 会话/标签生命周期、CDP 调用、导航、Observe、Click/Fill/Press、Screenshot、多标签切换/回收 | WebContentsView 挂 contentView；debugger.attach('1.3')；presentation+revision 防布局竞态 |
| `main/lib/browser-cdp.ts` | CDP 命令封装、超时/中止包装 | sendCommand 永不 settle 的问题——用 Promise.race 超时 + recoverDebugger 重连 |
| `main/lib/browser-observation-policy.ts` | AX 候选收集、可交互优先排序、元素量/深度限制 | 默认240(160交互+80上下文)、深度8/16、NAME按角色截断 |
| `main/lib/browser-policy.ts` | URL 规范化/合法性校验（无 Electron 依赖，可单测） | loopback 判定、缺省协议补 https、拒绝非法 URL |
| `main/lib/browser-key-policy.ts` | BrowserPress 导航键语义 | 导航键需 windowsVirtualKeyCode 才能真正触发（PageDown 滚动、Enter 提交）|
| `main/lib/browser-script-policy.ts` | DomAction 固定脚本 + ExecuteJavaScript 受控 | selector/text 按数据 JSON 传参不执行代码；内置 shadow DOM 遍历兜底 |
| `main/lib/browser-profile-policy.ts` | profile/partition 隔离 | 按工作区/会话 sha256 生成稳定 partition |
| `main/lib/browser-identity.ts` | UA 处理 | 诚实 UA + 保留 Chromium token |
| `renderer/components/browser/BrowserSlot.tsx` | DOM 占位 + ResizeObserver → 推送布局 | revision 时间戳单调递增（跨 reload）|
| `renderer/components/browser/BrowserPanel.tsx` | 标签栏 UI、Agent/用户 tab 展示 | 从 browser-controller 状态驱动 |
| `renderer/components/browser/browser-layout-revision.ts` | 全局单调 revision | `Date.now()*1000 + seq` |

---

## 3. 关键机制设计（自主实现要点）

### 3.1 多标签 & 布局
- 所有 Tab 的 `WebContentsView` 挂到 `owner.contentView`；controller 层保证**跨会话同时只有一个 view 可见**（`hideAllViewsExcept`）。
- Renderer `BrowserSlot` 用 `ResizeObserver` 上报 `{sessionId, tabId, revision, visible, bounds}`；revision 全局单调，防旧 IPC 晚到抢占（`browser-layout-revision.ts`）。
- Tab 回收：超上限时只回收 `openedByAgent` 且非当前/非工作 tab 的最久未用者，绝不自动关用户 tab。
- tabId 生成：时间戳+随机数；每次 Observe 后 `generation++`。

### 3.2 结构化 AX 列表（Observe）
- 用 CDP `Accessibility.getFullAXTree`（带 depth），收集 `{backendDOMNodeId, role, name, editable}`。
- 交互角色集合（button/checkbox/combobox/link/textbox/...）标注 `editable`；可交互优先排序（默认 240 = 160 交互 + 80 上下文）。
- 为每个选中元素生成 `ref = r{generation}-{i}`，存 `backendNodeId`；导航/重观察使旧 ref 失效，操作前 `assertCurrentDocument` 校验代际。

### 3.3 CDP 真实输入
- Click：`DOM.getBoxModel` 取元素中心 → `Input.dispatchMouseEvent`(mousePressed/mouseReleased)；可用 `Overlay.highlightNode` 临时高亮（不注入脚本、不改 DOM）便于用户确认。
- Fill：`DOM.focus` → 平台 select-all → `Input.insertText` 整段替换。
- Press：导航键走 `Input.dispatchKeyEvent`（rawKeyDown + windowsVirtualKeyCode）；文本走 `Input.insertText`。
- 截图：`webContents.capturePage()`。

### 3.4 保留 MAPro 优势
- **权限**：新工具名接入 `agent-permission-service` 的 `isWebBridgeMutation` + `trustedWebBridgeHosts` 逻辑；上传仍 `SAFE_TOOLS` 之外、永远逐次确认。
- **下载/上传**：沿用现有 `web-bridge-service` 的 fetch 落盘 + 系统选择器注入逻辑。
- **外部 Chrome 桥接**：保留 `ChromeCdpClient` / `connectChrome` 路径（CDP 连接真实 Chrome）。

### 3.5 工具面（新增/重构后）
新增多标签 + AX + 操作工具，命名跟随 MAPro 现状（`WebBridge*` 或引入 `Browser*`，建议沿用 `WebBridge*` 减少权限/RULES 改动）：
- `WebBridgeNewTab` / `WebBridgeListTabs` / `WebBridgeSelectTab` / `WebBridgeCloseTab`
- `WebBridgeObserve`（原 Snapshot 升级为 AX 结构化，可选保留 DOM snapshot 兜底）
- `WebBridgeClick`（CDP 真实输入）`/ WebBridgeFill` / `WebBridgePress`
- 保留：`WebBridgeNavigate` / `WebBridgeWaitFor`（新增）/ `WebBridgeScreenshot` / `WebBridgeScroll` / `WebBridgeStatus` / `WebBridgeStop` / `WebBridgeChromeTargets` / `WebBridgeConnectChrome` / `WebBridgeDownload` / `WebBridgeUpload`

---

## 4. 垂直切片（首版 PR 范围，先验证通路再扩展）

一个最小闭环，验证"多标签 + CDP AX + 真实输入 + 权限/下载融合"端到端成立：

1. **引擎尾部**：`browser-controller.ts` + `browser-cdp.ts` 最小实现 —— 一个会话、两三个 tab、`WebContentsView` 挂 contentView、debugger attach。
2. **Observe**：`Accessibility.getFullAXTree` → 生成结构化元素列表 + ref。
3. **CDP 真实输入**：`WebBridgeClick` 用 `Input.dispatchMouseEvent` 真正点一个按钮，`WebBridgeFill` 用 `insertText` 填框。
4. **多标签**：`WebBridgeNewTab` + `SelectTab` 切换不丢状态；布局 revision 正确。
5. **融合验证**：`WebBridgeDownload` 在一个可信域名 tab 下自动放行（站点信任生效）；同一会话权限行为与现有一致。
6. **测试**：单测（policy/observation/key 纯函数）+ 手测脚本（开两个标签，分别链接:8801/8802 的小页面，Observe→Click→Fill）。

> 垂直切片不实现：`WebBridgeWaitFor`、tab 上限自动回收、外部 Chrome 桥接重构、Overlay 高亮、renderer 完整标签栏 UI（可用最简 tab 切换先验引擎）。

---

## 5. 实施顺序（v1 切片 → v2 完整）

| 阶段 | 内容 | 验收 |
|------|------|------|
| **S0 准备** | 建 `browser/{controller,cdp,policy,observation,key,script,profile,identity}.ts` 空壳；梳理 IPC/preload/permission 接入点 | 编译通过 |
| **S1 引擎** | controller 单会话多 tab + WebContentsView + debugger attach + navigate | 本地两个 tab 能加载不同页面 |
| **S2 AX Observe** | Accessibility.getFullAXTree → 结构化列表 + ref + generation | 返回带 role/editable 的元素 |
| **S3 真实输入** | Click(Fill/Press) 用 Input.* 事件 | 真实点击/填表生效（可用表单页验证）|
| **S4 多标签融合** | NewTab/ListTabs/SelectTab/CloseTab + 权限/下载接入 | 切 tab 不丢状态；站点信任自动放行；下载成功 |
| **S5 完整** | WaitFor、tab 回收、Overlay 高亮、renderer 标签栏 UI、外部 Chrome 桥接 | 全链路可用 |

---

## 6. 风险与注意

- **`webContents.debugger` 与 `will-navigate` 的次序**：确保在导航前失效 document/ref，避免旧 ref 新页误操作（Proma 注释强调）。
- **CDP sendCommand 可能永久不 settle**：必须封装超时 + 失败重连 debugger，否则卡住整个 turn。
- **多原生 View 前台竞争**：必须在 controller 层用 presentation + revision 控制，不能依赖 renderer 卸载顺序。
- **`WebContentsView` 需挂 contentView**：与现 MAPro 独立 BrowserWindow 不同，涉及 renderer 布局与主窗口生命周期互操作，是最大工程点。
- **权限归类**：新工具必须同步进 `permission-rules` SAFE_TOOLS / `isWebBridgeMutation`，否则只读操作也会打断。
- **不回归上传**：`WebBridgeUpload` 必须保持在"永远逐次确认"。

---

## 7. 交付物
- 上述分层文件实现（MAPro 内自主编写）。
- 垂直切片可运行 demo（两个本地页面切换 + AX Observe + 真实点击填表 + 可信域下载）。
- 更新 MAPro 设计文档/技术笔记，记录重构后的浏览器架构与决策。
