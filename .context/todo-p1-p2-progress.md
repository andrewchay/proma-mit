# P1 / P2 推进台账（2026-10-29 18:20 起）

基线 HEAD：`50ea51dd fix(autonomy): 收紧 MCP 误伤与未知动作门禁`（本地 ahead origin/main 1）

## P1：受控自主与 Harness

### 1. 绑定可信执行身份（部分完成）

已落地：
- `tool-utils.ts:requiresOwnerToolGate()` 从权威账本 `resolveOwnerExecutionGateSession(sessionId)` 重查；调用方传 `ownerMarker=true` 但账本为 `unrestricted` 时**直接抛错**，标记不可伪造。
- `ai-sdk-runtime-core.ts:isBoundSessionMarkerValid()` 用 WeakMap 绑定会话身份（sessionId + cwd），工具集创建后冻结 owner/worktree 标记，执行前后各复核一次。
- `ai-sdk-agent-adapter.ts:216`、`pi-agent-adapter.ts:319` 按 `getOwnerExecutionToolNames()` 裁剪受限 Owner 的工具集。
- Proma runtime 以 `assertNoOwnerBusinessSession(ctx.sessionId)` 在每次工具调用前拒绝 Owner 业务会话。

缺口：
- Pi / Proma 没有与 AI SDK 等价的进程内身份绑定（ctx 是普通对象，若被替换无独立复核）。
- 无专项测试覆盖「直接调用 / 子 Agent / 恢复会话 / 不同 Runtime」四条绕过路径的拒绝行为。

### 2. 停止、撤权与恢复对账（部分完成）

已落地：
- Bash：独立进程组 SIGTERM→SIGKILL，`kill(-pgid,0)` 探测，未确认即 `unconfirmed`。
- MCP：受管进程组 + 存活监督者停止同组进程；不再按事后 PID 快照强杀后代。
- Unknown 强制门禁覆盖三类外部动作：MCP 工具、Computer Use、Web Bridge（`blockIfUnknownAction` 在执行前拦截同会话同指纹）。
- `50ea51dd` 新增：失败原因持久化（`unknown_failed`）、人工确认已生效（`confirmed_applied`，确认后仍保持 pending）、MCP 仅 `-32601` 判为未执行。
- 重启重建有测试（`unknown-action-store.test.ts` 跨进程重建组）。

缺口：
- Bash 未纳入 unknown 门禁：超时/中止后命令可能已产生副作用，模型可立即重跑同一命令。
- 断电持久性、跨进程并发、其他 Runtime 的停止证明未覆盖。

### 3. 文件与 Git 隔离边界（部分完成）

已落地（有证据文档）：跨会话硬链接溶解私有副本、Git init hooks 命令后收口、config 可执行载体清洗、Read/Write/Edit 打开前 inode 基准比对。

缺口：`GIT_DIR` 等环境变量间接布局、命令运行期间的执行窗口；现有收口只能减少后续持久化，不能撤销已发生的执行。

### 4. 真实打包应用验证（未开始）

需要：完整重建原生依赖 → 检查 node-pty helper → 实测终端、停止按钮、MCP 子进程回收、OpenDesign 下载。此前测试包只证明启动与资源存在。

## P2：三条产品闭环（全部未开始，需真实环境/人工判断）

- RSI 影子评估：比较模块仍是无生产调用方的纯函数，需接实际采集、报告、审批。
- OpenDesign：完整规范的选择/版本绑定/授权/刷新与品牌资源审批验收。
- Enterprise：真实 IdP、TLS、生产对象存储、集中授权与审计投递。
- 五条路线的真实任务与人工签收。

## 本轮验证

- 全仓回归：`bun run test`（逐文件独立进程），日志 `.context/logs/full-test-20261029.log`。
- 基线：历史上「45 既有失败持平」。
- 当前观测到 22 个失败，集中在 `Bash 沙箱（macOS seatbelt）`（`sandbox-exec: sandbox_apply: Operation not permitted`）与「Bash 会话中止」——本机环境无法应用 seatbelt 沙箱，属环境性失败，需与基线逐文件核对。
