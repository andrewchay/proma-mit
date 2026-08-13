# 调研：Proma vs Gravitas 的 in-app-browser 实现差异（源码级）

> 2026-08-13 更新。
> - Proma 源码：`/Users/chaihao/LLM/Proma`（上游 `github.com/ErlichLiu/Proma`，MIT）
> - Gravitas 源码：`/Users/chaihao/LLM/proma-mit`（用户 fork `github.com/andrewchay/proma-mit`，package name=`gravitas`，License BUSL-1.1）
> 本报告为源码级对比，已修正此前基于闭源推断的部分。

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
