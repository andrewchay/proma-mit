# Codex 调研报告：MCP / Computer Use / Browser Control

> 调研对象：OpenAI Codex 官方仓库 `/Users/chaihao/LLM/Codex`（Rust 代码在 `codex-rs/`）
> 调研窗口：2026 年 6 月 – 8 月 11 日（Git log 近期迭代）
> 调研日期：2026-08-11

---

## 一、总体结论

**架构要点：Computer Use 和 Browser Control 的实际执行层不在 codex-rs 开源 Rust 代码中**，而是分别由「`computer-use` bundled 插件 + 服务端 Responses API `computer` namespace」和「桌面应用 app shell 的浏览器面板/WebView + CDP」承载。codex-rs 仓库只负责**配置门控（requirements gate）、feature 标志、协议下发层**，以及配套的本地图像工具（`view_image`）。MCP 则是 codex-rs 中非常活跃、迭代密集的能力面。

---

## 二、MCP 能力近期迭代（6月–8月，重点）

MCP 客户端基于 `rmcp`（已升级到 3.0.0），传输支持 **stdio + streamable HTTP（含 SSE/JSON）**。近期迭代集中在 OAuth 健壮性、事件订阅、性能缓存与安全边界。

### 近期重要提交（按时间）

| Commit | 日期 | PR | 功能 |
|---|---|---|---|
| `0ca439900e` | 8-11 | #37970 | **Cache tool catalogs for streamable HTTP MCP servers**：子代理无需先建连接即可用已知的 HTTP MCP 工具定义；对 transport 设置、环境变量、协议模式、插件状态、客户端能力做指纹，仅等价连接间复用缓存；OAuth/动态凭证配置不进共享缓存 |
| `4b0e2a0bff` | 8-10 | #37864 | **MCP form input（full-access 线程）**：识别 `openai/standard-form-input` 客户端扩展，在 full-access 用户根线程中展示非审批表单；client-only 能力不向服务端广播，会话启动后启用以免阻塞启动 |
| `dd22460869` | 8-10 | #37866 | MCP OAuth 凭证竞争（contention）回归测试 |
| `afcc95b431` / `8b1b065719` | 8-10 | #37860/#37842 | 加速 MCP OAuth 凭证读取 |
| `78d3665d15` | 8-11 | #37850 | 在 MCP server status 中暴露插件归属（plugin ownership） |
| `41014b11bd` | 8-07 | #37494 | **MCP event discovery & subscriptions**：`McpResourceClient::list_events` 暴露托管 Plugin Runtime 事件定义；可取消的 `events/stream` 订阅；限制事件通知/队列大小、超时 stalled response headers |
| `248d8c0e22` | 8-06 | #37477 | MCP 请求中包含 call IDs，明确 metadata 配置 |
| `9daa491f7c` | 8-05 | #37366 | 加固本地 MCP server 进程树清理 |
| `81b9bc2109` | 8-07 | #37363 | 识别 MCP tool hook 配置 |
| `b3ffe3d001` | 8-06 | #37337 | OAuth 重新认证后恢复 MCP server |
| `e1831db7c3` / `952e87d3f2` | 8-03 | #37273/#37101 | 跨采样步骤复用 MCP handler 与稳定 bindings |
| `1151b23f01` | 8-03 | #37261 | 子代理懒启动缓存的 MCP server |
| `3bbf1fe757` | 7月下旬 | #35590 | server 启动前先暴露已缓存的 MCP 工具 |
| `d9e1c9cd55` / `fbf666fa98` | 7月 | #35742/#35937 | 选项性 MCP 启动不阻塞 turn，让无关工具先跑 |
| `5548c95d66` | 7月 | #36339 | **在 MCP server 中启用 skills**（Codex 以 MCP server 形式暴露能力） |
| `bd12b3a9ec` | 8-03 | #36796 | Agent Plugins MCP 配置解析 |
| `51c9ed6d4f` | 8-03 | #36781 | per-surface MCP 工具暴露控制 |
| `5825699981` | 8-01 | #36534 | MCP catalog 条目上限提到 2,048 |
| `a05bcda3db` / `61de0d8fe8` | 7月 | #36001/#35720 | **rmcp 升级到 3.0.0** |
| `be2e4afcd7` / `f2bee854a7` | 7-28 | #35724/#35725 | **MCP 2026-07-28 协议 discovery 支持** |
| `84ccb2938b` | 7月 | #35777 | 并发解析 MCP 工具目录 |
| `709283b432` / `9ea975a2dc` | 7月 | #35814/#35806 | MCP OAuth 走配置的 HTTP client |
| `164b3bfeab` / `bf4d3f51ea` | 7月 | #36310/#36306 | 按环境隔离 MCP OAuth 凭证；托管 MCP 凭证限制在本地环境 |
| `9daa491f7c` | 8-05 | #37366 | 本地 MCP server 进程树清理加固 |

### MCP 关键 feature 摘要

1. **streamable HTTP tool catalog 缓存**（最重要）：通过 transport 指纹实现安全缓存，子代理/多线程复用工具定义而无需重复握手。
2. **OAuth 稳定性**：速度优化、重新认证后恢复、环境隔离、走统一 HTTP client。
3. **Event discovery + 订阅**：MCP 从 request/response 扩展到 event 流，支持可取消订阅。
4. **Form input**：full-access 会话中也能弹出需要用户填写的标准 MCP 表单。
5. **传输与协议演进**：rmcp 3.0、2026-07-28 协议 discovery、stdio + streamable HTTP。

---

## 三、Computer Use（CUA）近期迭代

**架构**：由三部分构成——
1. **`computer-use@openai-bundled` 插件**（实际 Computer Use 工具的载体，通过 tool suggestion 提供/安装，见 `core-plugins/src/discoverable.rs:47`）；
2. **`view_image` 本地工具**（配套的截图/图像查看，`Feature::ViewImage` 门控）；
3. **Enterprise Requirement gate**（`computer_use.allow_locked_computer_use` + `Feature::ComputerUse`）。

实际截图/点击/键盘控制由服务端 Responses API `computer` namespace 执行（不在本仓库）。

### 核心文件
- `features/src/lib.rs:221,1271` — `Feature::ComputerUse`（requirements-only gate，`default_enabled: true`）
- `config/src/config_requirements.rs:796` — `ComputerUseRequirementsToml { allow_locked_computer_use: Option<bool> }`
- `app-server/src/request_processors/config_processor.rs:405,444` — `map_computer_use_requirements_to_api`
- `app-server-protocol/src/protocol/v2/config.rs:398,454` — `ComputerUseRequirements`
- `core/src/tools/handlers/view_image.rs` — view_image 工具
- `core/src/config/mod.rs:3158` — `computer` 为保留 namespace

### 近期迭代（8月重点关注）
| Commit | 日期 | PR | 功能 |
|---|---|---|---|
| `0a0ebb8535` | 8-06 | #37206 | 新增 unified image budget（6000px/10000-patch 统一上限），隐藏 view_image detail 控件 |
| `78f00743f9` | 8-04 | #36966 | 允许禁用内置 image viewer（稳定 `features.view_image` 开关） |
| `7a18a5c528` | 8-10 | #37892 | view_image handler 解码校验，无效图像报错 |
| `260261ed8f` | 8-11 | #37902 | 图像字节透传 history-insertion 统一解码 |
| `41ece455b7` | 8-11 | #37939 | 最终版：tool 输出前拒绝无效/非图像，防泄露；保留 EXIF/元数据 |
| `758a2a7052` | 6-15 | — | Windows computer use requirement → runtime feature（`windows_computer_use`） |

### 历史演进（背景）
- `5f5b4fabbd`（4-30）首次 Computer Use requirements，当时含 `allow_persistent_approval` + `macos.denied_bundle_ids`/`allowed_bundle_ids`；后续**简化为单一 `allow_locked_computer_use`**（`d86352d520`，#23555）。
- `dd00efe781`（4-16，#18219）Computer Use tool suggestion 移入 core。

### 概念辨析
- **Computer Use（CUA）**：模型操作桌面 → `computer` namespace 工具 + `view_image` + `computer-use` 插件。
- **Remote Control**：`app-server-transport/src/transport/remote_control/` 的远程控制 relay（配对 controller 设备远端控制 Codex），`allow_remote_control` gate，与 CUA 独立。
- **Appshots**：app-server 应用截图能力，`allow_appshots` gate。

---

## 四、Browser Control（CDP / 浏览器）近期迭代

**架构**：Browser control 的执行层**不在本仓库** —— 由 Codex 桌面应用 app shell 内置浏览器面板/WebView 通过 CDP 驱动 `toolbar`/`web_use` 浏览器或连接外部浏览器。codex-rs 只负责 feature 门控 + requirements 解析 + app-server 协议下发，并校验 `browser` 保留 namespace。

### Feature 标志（均 requirements-only、stable、default_enabled true）
| Feature | Key | 用途 |
|---|---|---|
| `InAppBrowser` | `in_app_browser` | 桌面应用内建浏览器面板 |
| `BrowserUse` | `browser_use` | 桌面 Browser Use agent 集成 |
| `BrowserUseFullCdpAccess` | `browser_use_full_cdp_access` | 允许访问完整 CDP 表面 |
| `BrowserUseExternal` | `browser_use_external` | 允许连接外部浏览器（复用登录态） |

### Requirements 结构
`BrowserUseRequirementsToml { disable_auto_review: Option<bool> }`（`config_requirements.rs:807`），经 `requirements_layers/stack.rs` 分层合并，由 `config_processor.rs:408,452` 下发为 `browserUse.disableAutoReview`（`configRequirements/read` RPC）。

### 近期提交
| Commit | 日期 | PR | 功能 |
|---|---|---|---|
| `41775559ca` | 7-23 | #35033 | 通过 app-server 暴露 Browser Use requirements（disable_auto_review） |
| `ff37f4a6ef` | 6-22 | #28769 | **注册 `browser_use_full_cdp_access` requirements feature**（CDP 全量访问门控） |
| `719431da6e` | 4-30 | #20245 | browser_use_external feature 标志 |
| `568cdacc7e` | 4-22 | #18956 | 首次注册 `in_app_browser` + `browser_use` 为 stable feature key |

`browser` 是 Responses API 保留 namespace（`core/src/config/mod.rs:3157`，与 `computer`、`terminal`、`web` 等并列），multi_agent_v2 自定义 tool namespace 不得占用。

### CDP Full Access vs External
- **Full CDP Access**：解锁浏览器工具可调用的完整 CDP 命令（DOM 深度操作、网络拦截、性能追踪等），关闭时只能基础子集。6 月引入。
- **External Browser**：连接系统已装外部浏览器实例，复用登录态。与 CDP full access 正交。

---

## 五、附注

- computer use / browser control 的实际执行引擎（CDP 客户端、截图控制、桌面 app shell）不在开源仓库，需查看桌面应用层才能看到完整实现。
- MCP catalog 上限 2048 条、工具目录并发解析、缓存前置暴露等说明 MCP 正在向"大规模工具目录"方向演进。
