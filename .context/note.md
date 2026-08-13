# Gravitas 浏览器重构 · 工作日志

## 2026-08-13 元素定位收敛 + 站点信任权限 ✅
- **纯 AX ref**：BrowserEngineBackend.click/type 只认 Observe 的 AX ref（`r{g}-{i}`），不再做 element_id/selector DOM 定位回退（用户决策）；upload 仍用 CSS selector（合法例外）。Click/Type 工具描述已改。
- **站点信任权限**：agent-permission-service 新增 `noteWebBridgeHost/trustWebBridgeHost/trustCurrentWebBridgeHost/isWebBridgeSiteTrusted`；`WebBridgeDownload` 在当前站点被信任时自动放行，`WebBridgeUpload` 永远逐次确认，导航/点击/输入保持工具白名单；web-bridge-service 在 rememberSnapshot 时 note 当前 host。
- **验证**：53 单测全过 + 全仓库 typecheck 过 + 门面真机 slice 全过。

## 2026-08-13 WebBridge 底层已替换为 browser-engine（多标签 CDP）✅
- **交付**：在 proma-mit 新建 `browser-engine/`（controller/cdp/policy/key + 单测），并把 `web-bridge-service` 的默认 backend 换成 `BrowserEngineBackend`（实现 `WebAutomationBackend`，委托 browserController）。
- **工具**：新增 `WebBridgeObserve`（AX 结构化）+ `WebBridgeNewTab/ListTabs/SelectTab/CloseTab`（多标签），tool-registry 已注册，Observe/ListTabs 进 SAFE_TOOLS。
- **验证**：38 单测全过 + 全仓库 typecheck 过 + 门面集成真机 slice（`webbridge-backend-slice.ts`）全过。
- **架构要点**：
  - `WebAutomationBackend` 是稳定边界，`BrowserEngineBackend` 适配多标签 CDP 到单 tab 语义（`ensureTab` 兜底首标签）。
  - 保留 `PlaywrightCdpBackend`（外部 Chrome 桥接仍走 playbackwright）。
  - Snapshot(DOM) 保留给 WebBridgeSnapshot；Observe 走 AX。
  - 事件定位归一：click/type 支持 AX `ref`；`element_id`/`selector` 的 DOM 回退**尚未实现**（遗留项）。
- **遗留**：（1）click/type 对 element_id/selector 的 DOM 回退未做；（2）站点信任权限未加（下一步）；（3）browser-script-policy 受控脚本未接。

## 2026-08-13 方向锁定（重要）
**目标仓库：`/Users/chaihao/LLM/proma-mit` = Gravitas（package `gravitas`，remote `andrewchay/proma-mit.git`）**
- ❌ 不是 `ma-proma`（那是 `andrewchay/mapro.git`，package `ma-pro`，另一独立产品，上游指向 proma-mit）。
- 三个仓库浏览器实现归属：`Proma`(上游,CDP/AX/多标签) → fork `proma-mit`=Gravitas(DOM脚本,丢CDP/AX/多标签) → fork `ma-proma`(延续Gravitas + Playwright爬虫 + 站点信任权限)。
- **本次任务**：重构 proma-mit 的 WebBridge → 多标签 + 结构化AX + CDP真实输入，保留下载，并新增站点信任权限。
- 权限决策：引入 `ma-proma` 的 `trustedWebBridgeHosts` 站点信任机制（导航/点击/输入/下载在可信域名下自动放行，`WebBridgeUpload` 永远逐次确认）。注：proma-mit 现有无此机制（只 `isWebBridgeFileTransfer` 文件逐次确认）。
- CDP 引擎：Electron `webContents.debugger`（对标 Proma）。
- 首版：垂直切片（独窗口内多 tab + AX Observe + 真实点击填表 + 可信域下载）。
- 计划文件：`.context/plan/gravitas-browser-refactor.md`

## 仓库认知记录
| 仓库 | product | remote | package | 浏览器现状 |
|------|---------|--------|---------|-----------|
| `/Users/chaihao/LLM/Proma` | Proma | ErlichLiu/Proma | proma | CDP AX_tree 多标签 ref（最全）|
| `/Users/chaihao/LLM/proma-mit` | **Gravitas** | andrewchay/proma-mit | gravitas | 独立BrowserWindow + DOM脚本 + Playwright(cdp外部) |
| `/Users/chaihao/LLM/ma-proma` | MAPro | andrewchay/mapro | ma-proma | 同Gravitas + Playwright Python爬虫 + 站点信任权限 |

## 历史：Proma vs Gravitas 浏览器差异（源码级）

## 仓库关系
`proma-mit` 是从 Proma fork 出来的变体（产品名 Gravitas），但 in-app-browser 已被完全重写为不同的实现。

## 核心结论
两者底层都是 Electron/Chromium，但**驱动机制与语义抽象完全不同**：
- **Proma**：Electron 原生 `webContents.debugger`（CDP）+ `Accessibility.getFullAXTree`，**无障碍语义（AX）驱动**，元素用可回溯的 `backendNodeId`，ref 带代际防错位。
- **Gravitas**：独立 `BrowserWindow` + **注入 DOM 脚本**（`executeJavaScript` 执行固定模板），**DOM 驱动**（非 AX），元素用「写入 `data-proxima-web-element-id` 属性生成的 id」。

## Gravitas 实现细节（reading web-bridge-service.ts / web-automation-backend.ts / web-bridge-tools.ts）

### 底层结构
- 每个 Agent 会话一个**独立可见的 Electron `BrowserWindow`**（1200×800，sandbox 开、nodeIntegration 关、contextIsolation 开）。
- 两种 backend（`WebAutomationBackend` 接口统一）：
  - `ManagedElectronBackend`（mode=`managed`）：`window.webContents.executeJavaScript(...)` 注入 DOM 脚本控制页面。
  - `PlaywrightCdpBackend`（mode=`chrome-cdp`）：用 `chromium.connectOverCDP`（playwright-core）连接**用户主动开启远程调试的真实 Chrome**，复用其登录态与页面——Proma 完全没有此能力。
- 不需要任意脚本工具：只有固定的 navigate/snapshot/click/type/scroll/setFileInput 模板脚本。

### Snapshot（`SNAPSHOT_SCRIPT` DOM 注入）
- 遍历 `document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')`，可见性过滤后取前 **200** 个，生成可交互 `accessibility[]`。
- 另递归生成树形 `accessibilityTree`（上限 500、深度上限 6，含 shadow DOM）。
- 返回 `url / title / text(innerText≤16000) / accessibility / accessibilityTree`。
- **元素 id**：`frameId + '-e-' + N`，通过 `element.setAttribute('data-prom-web-element-id', ...)` 持久化；selector 兜底 `id/#name/[role]/tag`。
- 注意：**不用 CDP AX tree**，纯粹 DOM 遍历 + 可见性启发式（offsetParent / getClientRects）。

### 交互（DOM 模板脚本）
- Click：`element.click()`。
- Type：`focus()` → 对 input/textarea 用原型 value setter 写入 / contenteditable 写 textContent → 派发 `InputEvent('input')` + `Event('change')`；`submit=true` 时补派发 Enter keydown。
- Scroll：`window.scrollBy({top:~,instant})`，clamp 100–2000。
- Upload：`DataTransfer` 注入 `input.files`，不落盘。
- 全部经 `executeJavaScript`，参数 JSON 序列化（数据非代码）。

### 文件
- Download：`fetch(url,{redirect:'error'})` → 落盘 `{configDir}/web-bridge-downloads/{sessionId}`，≤50MB。
- Upload：**通过系统文件选择器**（`dialog.showOpenDialog`）选文件，Agent 不能传本地路径；内容注入当前页面，不暴露绝对路径。

### 安全边界
- `normalizeWebUrl`：仅 http/https，拒绝带用户名密码。
- `will-navigate` / `will-redirect` 拦截非 http/https；`setWindowOpenHandler` deny（不新建未受管窗口）。
- 无 Proma 的 proma-file:// 本地预览协议；也不做文件系统/局域网白名单（Chromium 决定）。

### Profile / 登录态
- partition `persist:proma-web-bridge-{sessionId}`，**按会话隔离**（Proma 按工作区隔离）。
- 可 `connectChrome` 桥接到用户真实 Chrome 复用登录态。

### 权限模型（agent-permission-service.ts）
- `requiresPerActionApproval = isComputerUseTool || isWebBridgeFileTransfer(Download/Upload)`——**只有文件传输逐次确认**。
- 导航/点击/输入等页面交互：auto 模式下走 SDK classifier / 会话白名单（`"始终允许"`，对齐 kimi-cli `approve_for_session`），可免逐次确认。
- Worker 子代理工具调用自动批准（除需逐次确认的 CUse/文件传输）。

### 审计
- `appendWebBridgeAudit` 写 `~/.gravitas/web-bridge-audit/events.jsonl`，记录 navigate/click/type/scroll/download/upload/connect_chrome/stop（含 elementId、length、bytes）。

## Proma 实现要点（回顾）
- 见本文件下方旧条目；核心差异快速对照见下。

## 快速对照表

| 维度 | Proma | Gravitas |
|------|-------|----------|
| 驱动 | Electron `Debugger`(CDP) + `Accessibility.getFullAXTree` | `BrowserWindow` + 注入 DOM 脚本 / Playwright-core 连真实 Chrome |
| 语义 | AX 无障碍树（backendNodeId） | DOM 遍历 + 可见性启发式（写属性生成 id） |
| 元素引用 | `ref=r{g}-{i}` 带代际，失效校验 | `element_id`（data 属性）+ selector 兜底，重快照刷新 |
| 交互 | CDP `Input.dispatchMouseEvent`/`insertText`（真实输入事件） | DOM `element.click()`/value setter + 派发事件 |
| 任意 JS | 有受控 `BrowserExecuteJavaScript`(≤20KB) | 无任意 JS 工具，仅固定模板脚本 |
| 本地预览 | `BrowserPreviewOpen` + `proma-file://` 授权目录 | 无 |
| 外部 Chrome | 无（完全隔离） | `WebBridgeConnectChrome` 复用登录态 |
| 文件收发 | 禁下载 | Download/Upload（文件传输逐次授权） |
| 权限 | 首次风险声明 + 操作可 abort，按会话白名单 | 导航确认 + 文件传输/ComputerUse 逐次确认，页面交互走白名单 |
| 登录态隔离粒度 | 按工作区 | 按会话 |
| Tab 管理 | 多 tab（Agent/用户分离，上限20） | 单 BrowserWindow 单页（无多 tab 工具） |
| 快照内容 | 结构 AX 元素 | DOM 元素 + innerText + 通用 selector |

## 一句话
Proma 用 CDP AX 语义做稳定的 Agent 自动化（多 tab、本地预览、工作区隔离、受控 JS）；Gravitas 的 WebBridge 更轻——用 DOM 脚本注入 + 可桥接用户真实 Chrome，聚焦"看得见、可人工介入、能发文件"，权限在导航与文件层面把关，页面交互交给白名单。
