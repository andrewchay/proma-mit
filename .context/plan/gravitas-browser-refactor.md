# Gravitas WebBridge 重构为"多标签 + CDP AX + 真实输入 + 下载 + 站点信任" 实现规格

> 计划模式 · 供审阅
> **目标代码库：`/Users/chaihao/LLM/proma-mit`（product: Gravitas，package `gravitas`）**
> 参考（只作机制提炼，不复制代码）：`/Users/chaihao/LLM/Proma`（上游 Proma）、`/Users/chaihao/LLM/ma-proma`（站点信任权限借鉴）
> 原则：基于需求 + 参考机制，在 Gravitas 里自主实现。

---

## 0. 已确认的需求决策（AskUserQuestion 锁定）
| 决策点 | 选择 |
|--------|------|
| 目标仓库 | **Gravitas = `/Users/chaihao/LLM/proma-mit`** |
| 集成形态 | 替换/重构现有 WebBridge |
| 优先保住 | 多标签页 + 结构化 AX 元素列表 + CDP 真实输入事件 + 下载 & 站点信任权限 |
| CDP 引擎 | Electron `webContents.debugger`（对标 Proma）|
| 权限模型 | **引入站点信任机制**（对标 ma-proma 的 `trustedWebBridgeHosts`）|
| 首版目标 | 跑通垂直切片验证 |

---

## 1. Gravitas 现状盘点（proma-mit）

### 现有 WebBridge 结构
- `main/lib/web-bridge-service.ts`：每会话一个**独立 Electron `BrowserWindow`**（1200×800），`webPreferences` sandbox 开。
- `main/lib/web-automation-backend.ts`：两种 backend——
  - `ManagedElectronBackend`（mode=`managed`）：受管窗口，`webContents.executeJavaScript` 注入 DOM 脚本（`SNAPSHOT_SCRIPT` 遍历 `querySelectorAll`、`element.click()`、value setter + 派发事件）。
  - `PlaywrightCdpBackend`（mode=`chrome-cdp`）：`chromium.connectOverCDP` 连接用户外部 Chrome。
- `main/lib/agent-runtime/tool-impls/web-bridge-tools.ts`：12 个 `WebBridge*` 工具（Navigate/Snapshot/Screenshot/Click/Type/Scroll/ChromeTargets/ConnectChrome/Download/Upload/Status/Stop）。
- `main/lib/web-bridge-audit-service.ts`：逐操作审计 → `~/.gravitas/web-bridge-audit/events.jsonl`。
- `app/electron/src/preload/index.ts`：仅 `getWebBridgeStatus / stopWebBridge / stopAllWebBridges`。
- **renderer 无 browser panel**（独立窗口，不需要布局 slot）。

### 缺口（本次重构要补）
1. **多标签页**：目前独立 BrowserWindow 单页，无 tab 概念、无 Agent/用户 tab 分离。
2. **结构化 AX**：目前 `SNAPSHOT_SCRIPT` 是 DOM 遍历 + 可见性启发式，**非** CDP `Accessibility.getFullAXTree`，无 `ref` 代际失效。
3. **CDP 真实输入**：受管窗口用 `element.click()` / value setter，**非** `Input.dispatchMouseEvent` / `insertText`。
4. **站点信任权限**：**proma-mit 没有**。现有权限 `requiresPerActionApproval = isComputerUseTool || isWebBridgeFileTransfer(Download/Upload)`，文件传输永远逐次确认。**需要新增 `trustedWebBridgeHosts` 机制**（借鉴 ma-proma）。

### 已具备（重构必须保留）
- `WebBridgeDownload`（fetch 落盘 ≤50MB）/ `WebBridgeUpload`（系统选择器注入，不落盘）。
- 外部 Chrome `connectChrome`（Playwright connectOverCDP）。
- 审计日志链路。

---

## 2. 目标架构（对标 Proma，自主实现）

### 核心迁移
把"每会话独立 BrowserWindow 单页"改为"**嵌入主窗口 contentView 的多标签 `WebContentsView` 集合**"，每个 tab 挂 `webContents.debugger` 作 CDP 通道。

```
BrowserController（主进程单例）
├── sessions: Map<sessionId, SessionRecord>
│   ├── partition（persist:proma-web-bridge-<sha>）
│   ├── agentAbortController / ledger
│   └── tabs: Map<tabId, TabRecord>
│       ├── view: WebContentsView（webPreferences sandbox + webSecurity）
│       ├── debugger: webContents.debugger        ← CDP 通道 ★
│       ├── refs: Map<ref, backendNodeId>          ← AX 元素引用
│       ├── generation（导航/关闭/重观察后失效）
│       ├── isLocalPreview / openedByAgent / lastActivityAt
│       └── commandTail（防同 tab 交错命令）
├── presentation（跨会话：同时只有一个原生 View 前台可见）+ latestPresentationRevision
└── 多标签依赖：嵌入 contentView + renderer 布局 IPC
```

### 2.1 Dashboard：宿主方案权衡（关键决策）
对标 Proma 用的是"嵌入主窗口 contentView"。但 Gravitas 现状是独立 BrowserWindow。两个子方案：
- **方案 1（对标 Proma）**：`WebContentsView` 挂 `owner.contentView`，renderer 用 `BrowserSlot`+ResizeObserver 上报布局。优点：多标签与主 UI 无缝、可做标签栏；缺点：renderer 改造大、跨窗口生命周期复杂。
- **方案 2（独立窗口内多 tab）**：保留独立 BrowserWindow，内部用多个 `WebContentsView` 叠放切换。优点：renderer 改动极小，聚焦主进程；缺点：登录态/布局/可见性都自己管，标签栏在窗口内自绘。
- **建议**：垂直切片阶段用**方案 2**（独窗口内多 tab，主进程自管、最贴合"先验证通路"），打通后再评估是否迁到方案 1。

### 2.2 分层职责（Gravitas 内新建，自主实现）
| 新文件 | 职责 | 机制要点（提炼参考） |
|--------|------|----------------------|
| `main/lib/browser-controller.ts` | 会话/标签生命周期、CDP 调用、导航、Observe、Click/Fill/Press、Screenshot、多标签切换/回收 | WebContentsView 挂 contentView；debugger.attach('1.3')；presentation+revision 防竞态 |
| `main/lib/browser-cdp.ts` | CDP 命令封装、超时/中止 | Promise.race 超时 + `recoverDebugger` 重连 |
| `main/lib/browser-observation-policy.ts` | AX 候选收集、可交互优先、元素量/深度限制 | 默认 240(160 交互+80 上下文)、深度 8/16、NAME 按角色截断 |
| `main/lib/browser-policy.ts` | URL 规范化/校验（无 Electron 依赖，可单测） | loopback 判定、缺省补 https、拒绝非法 URL |
| `main/lib/browser-key-policy.ts` | Press 导航键语义 | 导航键需 `windowsVirtualKeyCode` 才触发默认行为 |
| `main/lib/browser-script-policy.ts` | DomAction 固定脚本 + ExecuteJavaScript 受控 | selector/text 按数据传参；shadow DOM 遍历兜底 |
| `main/lib/browser-profile-policy.ts` | profile 隔离 | 按会话/工作区 sha256 partition |
| `main/lib/browser-risk-disclaimer.ts` | 首次风险声明（Gravitas 已有雏形可升级版本化） | 版本化确认 |

### 2.3 站点信任权限（保留 + 对标 ma-proma）
在 `agent-permission-service.ts` 新增 `trustedWebBridgeHosts: Set<string>`（按 session）：
- 导航/点击/输入/下载：目标站点域名被信任 → 本会话自动放行。
- `WebBridgeUpload`：永远逐次确认。
- 用户"始终允许"时，把 `extractUrlHost(contextUrl)` 加入信任集合（而非整个工具）。
- 需同步：
  - `permission-rules` `SAFE_TOOLS` 只读名单（Snapshot/Screenshot/Scroll/ChromeTargets/Status）不变；
  - 新工具名接入 `isWebBridgeMutation`。

---

## 3. 工具面（重构后）
沿用 `WebBridge*` 命名（减少权限/UI/审计改动），新增多标签与 AX 工具：
- **新增**：`WebBridgeNewTab` / `WebBridgeListTabs` / `WebBridgeSelectTab` / `WebBridgeCloseTab` / `WebBridgeObserve`（AX 结构化，可保留 DOM snapshot 兜底）/ `WebBridgeFill` / `WebBridgePress` / `WebBridgeWaitFor`
- **保留**：`WebBridgeNavigate` / `WebBridgeScreenshot` / `WebBridgeScroll` / `WebBridgeStatus` / `WebBridgeStop` / `WebBridgeChromeTargets` / `WebBridgeConnectChrome` / `WebBridgeDownload` / `WebBridgeUpload`
- `WebBridgeClick`/`Type` 升级为基于 CDP ref 的真实输入（旧 DOM 路径作 fallback 可逐步移除）。

---

## 4. 垂直切片（首版范围：S1–S4）
最小闭环，验证"多标签 + CDP AX + 真实输入 + 站点信任下载"端到端：
1. **S1 引擎**：browser-controller + browser-cdp 最小实现——独立窗口内 2~3 个 `WebContentsView` tab、debugger attach、navigate。
2. **S2 AX Observe**：`Accessibility.getFullAXTree` → 结构化元素列表 + ref + generation。
3. **S3 真实输入**：Click 用 `Input.dispatchMouseEvent` 真点，Fill 用 `insertText`，Press 用 `dispatchKeyEvent`。
4. **S4 多标签 + 权限**：NewTab/ListTabs/SelectTab/CloseTab；新增站点信任；`WebBridgeDownload` 在可信域名下自动放行。
- **切片不含**：WaitFor、tab 上限自动回收、renderer 标签栏、Overlay 高亮、外部 Chrome 桥接重构。

---

## 5. 实施顺序
| 阶段 | 内容 | 验收 |
|------|------|------|
| S0 | 建 `browser/*` 骨架；梳理 IPC/preload/permission 接入点 | 编译通过 |
| S1 | controller 独窗口多 tab + debugger + navigate | 2 个 tab 加载不同页面 |
| S2 | AX Observe → 结构化 + ref + generation | 返回 role/editable 元素 |
| S3 | CDP 真实输入 Click/Fill/Press | 表单页真实生效 |
| S4 | 多标签切换 + 站点信任 + 下载 | 切 tab 不丢态；可信域下载免打断 |
| S5 | WaitFor、tab 回收、高亮、renderer 标签栏、外部 Chrome | 全链路可用 |

---

## 6. 风险与注意
- `webContents.debugger` 与 `will-navigate` 次序：导航前失效 document/ref，防旧 ref 新页误操作。
- CDP sendCommand 可能永不 settle：必须超时 + 重连。
- 独立窗口内多原生 View 前台竞争：controller 层统一可见性控制。
- 权限归类：新工具须同步进 `SAFE_TOOLS` / `isWebBridgeMutation`，否则只读操作也打断。
- `WebBridgeUpload` 保持永远逐次确认，不回归。
- 参考 `ma-proma` 的站点信任实现时，**只借鉴设计，Gravitas 内自主编写**。

---

## 7. 交付物
- Gravitas 内自主实现的分层文件。
- 垂直切片 demo（双 tab 切换 + AX Observe + 真实点击填表 + 可信域下载）。
- 更新 Gravitas 技术笔记/设计文档，记录重构后架构。
