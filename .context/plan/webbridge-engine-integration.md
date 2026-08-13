# 接入 browser-engine：替换 WebBridge 底层 + 多标签工具

> 计划模式 · 供审批 · 目标：`/Users/chaihao/LLM/proma-mit`
> 前置：垂直切片（S1-S4）已真机通过，单测 33 例全过。

## 0. 已确认决策
| 决策 | 选择 |
|------|------|
| 接入方式 | **替换底层**（把 web-bridge 的默认 backend 换成 browser-engine 多标签 CDP） |
| 观察能力 | **新增 WebBridgeObserve（AX） + 保留 WebBridgeSnapshot（DOM）** |
| 引擎 | Electron webContents.debugger（browser-controller 已实现） |

## 1. 核心思路

`web-bridge-service.ts` 是门面（Facade），`web-bridge-tools.ts` 只依赖它。保持门面的**方法签名与契约不变**，只把**内部 backend 换掉**，可实现"工具名、权限、审计、UI 全部不动"的最小侵入。

## 2. 分层改动清单

### 2.1 `web-automation-backend.ts`（策略接口）
- **保留** `WebAutomationBackend` 接口 + `PlaywrightCdpBackend`（外部 Chrome 桥接仍用它）。
- 把 `ManagedElectronBackend` 的默认实现**切换为基于 browserController**：
  - `navigate/snapshot/click/type/scroll` 委托给 browser-controller 的对应能力。
  - Snapshot 的 DOM 能力要保住 → 保留一段仅用于 Snapshot 的 DOM 脚本注入；Observe 才走 AX。
  - 新增方法：`createNewTab / listTabs / selectTab / closeTab / observe`。

### 2.2 `web-bridge-service.ts`（门面）
- 方法契约不变：`navigate/snapshot/screenshot/click/type/scroll/download/selectAndUpload/connectChrome/listChromeTargets/getStatus/close/closeAll/canUseComputerFallback`。
- 新增门面方法：`observe(sessionId)`、`createNewTab(sessionId,url)`、`listTabs(sessionId)`、`selectTab(sessionId,tabId)`、`closeTab(sessionId,tabId)`。
- `getOrCreateManagedBackend` 返回新的 engine backend；session 记录增加 tabId 维度（当前工作 tab）。

### 2.3 `web-bridge-tools.ts`（工具层）
- **新增**（复用既有 WEB_BRIDGE_* 命名）：
  - `WebBridgeObserve`：AX 结构化元素（ref/role/name/editable），只读。
  - `WebBridgeNewTab` / `WebBridgeListTabs` / `WebBridgeSelectTab` / `WebBridgeCloseTab`：多标签。
- 既有工具（Navigate/Click/Type/Scroll/...）**签名保持**，只是底层变多标签 CDP。
- 元素定位：Observe 返回 `ref`；Click/Type 继续接收 `element_id`/`selector`——引擎内部归一。

### 2.4 `tool-registry.ts`
- 注册 `CORE_TOOL_NAMES` + `createCoreTools` 里的新工具。

### 2.5 权限（`agent-permission-service.ts` + `permission-rules.ts`）
- `WebBridgeObserve` → 加入 `SAFE_TOOLS`（只读，免询问）。
- `WebBridgeNewTab/ListTabs/SelectTab/CloseTab` → 页面操作（进 `isWebBridgeMutation` 语义，供后续站点信任）。
- 下载/上传仍走现有 `isWebBridgeFileTransfer`（本站信任是下一步）。

### 2.6 测试
- 新增多标签工具的单测（mock electron），沿用 `web-bridge-tools.test.ts` 风格。
- browser-engine 三个纯逻辑单测继续保留。
- electron 真机 slice 扩展：Open 2 tab + AX observe + click。

## 3. 多标签与元素定位归一（关键设计）
- browser-controller `observe` 产出 `{ref, role, name, editable}`。
- 让 Observe 返回的元素定位符兼容现有 `element_id` 语义：输入 `ref` 时 engine 直接定位，输入 `element_id`/`selector` 时回退旧 DOM 定位。二者并存，不破坏旧会话。

## 4. 风险与注意
- **替换底层是高风险**：变更默认会话行为。用「新增 Observe + 多标签工具」渐进，不放任旧工具消失。
- 多标签 hostWindow 复用：每会话一个 hostWindow + 内部多 WebContentsView，门面接口不变则 UI 不感知。
- CDP 超时/重连：browser-cdp 已封装。
- ref / element_id 归一：Agent 拿到 Observe 的 ref 须在当代际内使用（导航/重观察失效）。
- 上传仍逐次确认；下载保留。

## 5. 实施顺序
| 阶段 | 内容 | 验收 |
|------|------|------|
| T1 | backend 切换：ManagedElectronBackend 默认走 browserController，保 DOM snapshot | navigate/click 真机可用，旧 Snapshot 仍返回文本 |
| T2 | service 门面加多标签方法 + observe | 门面可 create tab / list / select / close / observe |
| T3 | 工具层加 Observe + 多标签工具 + tool-registry 注册 | 工具可被 Agent 调用 |
| T4 | 权限归类（Observe 只读、多标签归 mutation） | 权限判定正确 |
| T5 | 测试 + slice 验证 | 单测 + 真机 slice 全过 |

## 6. 交付物
- web-bridge-service/backend 底层替换为 browser-controller。
- 新增 WebBridgeObserve + 多标签工具（NewTab/ListTabs/SelectTab/CloseTab）。
- 权限归类更新。
- 单测 + electron 真机验证扩展。
