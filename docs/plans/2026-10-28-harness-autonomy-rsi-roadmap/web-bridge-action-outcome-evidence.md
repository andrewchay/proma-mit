# 受管浏览器动作的结果分类：局部证据

日期：2026-10-29；范围仅 Web Bridge 的写动作（navigate / click / type / scroll / upload / download / connectChrome），不代表标签管理、只读工具或真实网站验收已覆盖。

## 缺口

Web Bridge 走 CDP 真实输入。`web-bridge-tools.ts` 里的动作直接把 `webBridgeService` 的异常抛给模型，且**失败时连审计都不写**——`audit()` 只出现在成功路径之后。结果是：

- 点击提交按钮后连接断开，模型只看到一句 `Target closed`，最自然的反应是重试，在真实网站上是重复提交；
- 下载中断后重试，可能产生重复文件或重复计费；
- 失败动作在审计里没有任何痕迹，事后无法统计"有多少动作结果不明"。

上一片给桌面动作补了 `not_applied / unknown` 分类，Web Bridge 是同一路线上并列的遗留项（见 `controlled-autonomy-next.md` 第 3 条）。

## 本次改动

**抽出共用骨架** `external-action-outcome.ts`：`classifyActionFailure(error, rule)` + `describeActionFailure(action, error, rule, unknownHint)`。判定顺序固定为「超时/中止 → 未知错误码 → 未知文案 → 前置错误码 → 前置文案 → 默认 unknown」，理由截断 300 字符。判据由各域提供，骨架不预设。

**桌面域改为复用**，`computer-use-outcome.ts` 的导出 API 与文案逐字保持不变（原有 9 项测试一行未改仍通过），只是把判据表搬进规则对象。

**Web Bridge 域新增判据** `web-bridge-outcome.ts`，与桌面域的关键差异：

- `unknown` 判据包含 CDP/WebSocket 层失败：`Target closed`、`Session closed`、`WebSocket is not open`、`socket hang up`、`Protocol error`、`Node is detached`。这些恰好发生在动作已经发出之后，**必须算结果未知**。
- `not_applied` 判据是前置不成立或目标不存在：`尚未导航`、`No node with given id`、`No target with given id`、`element not found`、`ref 已失效`、`Invalid parameters`、权限拒绝，以及 `ENOTFOUND`（DNS 没解析，动作没发出）。
- 下载单独给了确认手段：`DOWNLOAD_CONFIRM_HINT` 指引核对下载目录落盘，而不是去看页面状态。

**接入 `runWebBridgeAction`**：七个写动作统一走包装器。成功记 `outcome: 'applied'` 并保留原来的审计字段（navigate 仍记规范化后的 URL、download 仍记 bytes/contentType、upload 仍记文件清单）；失败记 `outcome` 与 `error`（截断后的理由），并返回分类文案而不是裸异常。

## 证据

`web-bridge-outcome.test.ts`（11 项，纯函数）：
六种 CDP/连接失败文案 → `unknown`；`TimeoutError`/`AbortError`、六种网络错误码 → `unknown`；六种前置失败文案 → `not_applied`；权限拒绝与 `ENOTFOUND` → `not_applied`；`undefined`/普通对象 → 保守 `unknown`；理由截断到 300；文案层校验未知时出现 `禁止自动重试` + `WebBridgeObserve` + `WebBridgeSnapshot`，未执行时出现 `修正前置条件后可以重试` 且不含 `禁止自动重试`；下载走独立提示，不含页面观察指引。

`web-bridge-tools.test.ts`（13 项，原有 7 项 + 新增 6 项）：
`Target closed` → 结果未知；`No node with given id` → 未执行；`Protocol error (Input.insertText)` → 未知；下载 `socket hang up` → 未知且提示核对下载目录；成功路径返回快照且不出现未知提示；**失败动作写入审计**：JSONL 里 `detail.outcome === 'unknown'`、`detail.error` 保留原始理由、`detail.elementId` 记录目标，且不含页面正文（`text` 为 undefined）。

定向回归：`web-bridge-tools` 13 项连续三次全绿；`computer-use-tools` 8 项、`computer-use-outcome` 9 项不受影响；`pi-tool-bridge`、`tool-session-gate` 通过。typecheck=0、biome 通过。

测试自身暴露了两个真实时序问题，已修在测试里并记录在此：审计是 fire-and-forget，同一文件多个用例都会写 `click` 事件，因此断言必须按用例独有的 `element_id` 匹配——先按错误文案匹配会误命中前一个用例的事件（两次调试失败都由此触发）。

## 边界

- **`applied` 不是回执**：只表示 CDP 调用返回了，不代表页面上真的发生了什么。真正的确认仍要重新 Observe/Snapshot 或截图。
- **未触发真实断连**：所有用例用 stub 服务注入异常，没在真实 Chrome 上制造 `Target closed`、没做真实网站下单/上传验收。
- **审计写失败被静默忽略**（既有行为 `void … .catch(() => undefined)`），未改；因此"审计有记录"不能当作"动作一定发生过"。
- **未分类的入口**：标签管理（newTab/selectTab/closeTab/stop）与只读工具（snapshot/screenshot/observe/status/listTabs/chromeTargets）未接入分类——它们没有外部副作用，失败可安全重试。
- **分类是启发式**：判据基于 CDP 与浏览器引擎的现有文案，措辞变化会让归类落到 `unknown`（保守方向）。
- **未做真实 Provider / 打包应用验收**：本轮只跑单测与定向回归。Bash 相关套件在本沙箱内会出现嵌套 seatbelt 失败，本次改动前同样失败（已用 stash 对照确认），与本次改动无关；真实宿主结果沿用此前 `termination-evidence.md` 的记录。
