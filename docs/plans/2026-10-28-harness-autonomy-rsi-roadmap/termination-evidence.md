# Bash 进程树终止与可核验证据：局部证据

日期：2026-10-29；范围仅 Agent Bash 工具在本机启动的进程组，不代表其他 Runtime、MCP 服务端进程、外部 Provider 动作或崩溃重启对账已覆盖。

## 缺口

停止会话此前只影响 UI 与 Runtime 循环，**Bash 工具完全不读取 `ctx.abortSignal`**：用户点停止后，正在运行的命令继续跑，且 `execFile` 只能杀掉直接子进程 —— `sandbox-exec` 之下的 shell 及其后代（命令里的 `cmd &`）会存活到自然结束。计划里"不得把 Abort 请求或本地状态更新当成终止事实"在当时无满足条件：既没有整组终止，也没有任何"是否真的退出"的探测。

## 本次改动

新增 `bash-termination.ts`，Bash 工具改走该入口（原 `execFileAsync` 移除）：

- **独立进程组**：`spawn(..., { detached: true })`，子进程即组长，`pgid === pid`，终止可覆盖全部后代。
- **终止阶梯**：中止或超时 → 对进程组 `SIGTERM` → 1.5s 宽限 → 仍存活则 `SIGKILL` → 1s 宽限。信号与时间戳记入证据。
- **可核验探测**：以 `process.kill(-pgid, 0)` 轮询判断进程组是否消失（`ESRCH` 即空）。不用 `ps` 枚举：受限会话内 `posix_spawn('/bin/ps')` 返回 EPERM，且额外进程会让探测本身引入新的失败模式。探测失败（非 `ESRCH` 错误）按"未知存活"处理，不视为已终止。
- **三态语义**：`exited`（自行退出且组已空）、`terminated`（信号后组已空）、`unconfirmed`（组仍存活或探测失败）。工具输出只在 `terminated` / `unconfirmed` 时追加说明，正常命令不产生噪音；`unconfirmed` 明确写"不能视为已终止"。
- **非零退出语义修正**：新实现最初把非零退出当成成功，宿主回归立刻暴露（9 个沙箱用例由"拒绝"变成"未报错"）。已恢复 `execFile` 语义：非零退出与信号终止都置 `isError`，并把 stderr 截断后带入失败信息。

接线确认：`ai-sdk-agent-adapter.abort(sessionId)` → `active.state.controller.abort()` → `ctx.abortSignal`，与本实现读取的是同一个 signal，因此停止按钮会真正下发整组终止。

## 证据

`bash-termination.test.ts`（10 项，不依赖 seatbelt，受限会话即可运行）：

| 场景 | 断言 |
| --- | --- |
| 正常命令 | `status=exited`、退出码 0、组已空、无终止说明 |
| 超时 | `requestedBy=timeout`、`SIGTERM`、`status=terminated`、组已空、失败信息含"超时" |
| 会话中止 | `requestedBy=abort`、`status=terminated`、失败信息含"中止" |
| 命令留后台子进程 | `status=unconfirmed`、`groupAlive=true`、说明含"终止未确认"（**不谎称已终止**） |
| 后台进程忽略 SIGTERM | 信号序列恰为 `SIGTERM→SIGKILL`，最终 `terminated` |
| 非零退出 | `isError`、信息含退出码与 stderr，`status` 仍为 `exited` |
| 启动前已 aborted | 不执行命令、`status=terminated` |
| 文案三态 | `exited` 无输出；`terminated` 含信号链与进程组；`unconfirmed` 含"不能视为已终止" |

`bash-sandbox.test.ts` 新增端到端用例：`sleep 3; touch marker` 运行中 200ms 后中止 → 工具返回 `isError` 且内容含"中止"，等待 3.5s 后 marker **不存在**（若命令或后代存活就会写下）。

宿主真机回归（`.context/bash-termination-verify.log`）：`bash-termination` 10 项、`bash-sandbox` 38 项、`tool-impls` 20 项，**三套件零失败**。受限会话内 `bash-sandbox` 那批失败是嵌套 `sandbox_apply` 的 EPERM，故在宿主 Terminal 复验。

## 边界

- **只覆盖 Bash 工具**：Claude SDK 自带的 Bash、MCP 服务端进程、Computer Use 动作、其他 Runtime 的子进程不在本切片内，计划中的"覆盖进程树、子任务与后续动作"尚未完整。
- **正常完成时遗留的后台进程不被主动终止**：只标记 `unconfirmed` 并提示，避免改变 `nohup`/`cmd &` 的既有可用性。若要"命令结束即清场"，需要产品决策。
- **外部动作与 Provider 回执仍是 unknown**：本切片只处理本地进程。外发请求无回执时的未决占额、自动重试禁令、崩溃重启对账均未实现。
- **pid 复用窗口**：`kill(-pgid, 0)` 依赖进程组仍然存在，pid/pgid 被复用的极端情况下探测可能误判为"仍存活"（保守方向，不会误报已终止）。
- **未做真实 Electron 打包应用验证**；中止路径经适配器源码接线确认，未在打包产物上做人工点击验证。
- 超时与中止的宽限参数（1.5s/1s/400ms）为经验值，未在慢速 IO 或大量后代的极端负载下压测。
