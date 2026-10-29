# MCP stdio 服务端进程树回收：局部证据

日期：2026-10-29；范围仅 MCP stdio 传输在本机拉起的进程树，不代表 SSE/HTTP 传输、外部服务端、Provider 回执或崩溃重启对账已覆盖。

## 缺口

`@modelcontextprotocol/sdk` 的 `StdioClientTransport.close()` 逻辑是：先关 stdin，2s 内未退出则对**直接子进程**发 SIGTERM，再等 2s 未退出则 SIGKILL（`node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js` 第 143–175 行）。它从不枚举后代进程。

真实 MCP 配置里 `command` 常是包装器（`npx`、`uvx`、自定义 shell 脚本），真正的 server 是它的子进程。会话停止 → `disconnect()` → `close()` 只杀掉包装器，server 进程成为孤儿继续运行，仍持有凭据、网络连接和文件句柄。

## 本次改动

新增 `mcp-process-reaper.ts`：

- `collectDescendants(table, rootPid)`：按 `ppid` 建子表做深度遍历，结果先深后浅；`seen` 集合同时防进程表出现环；排除 pid 1 与当前进程自身。
- `snapshotDescendants(rootPid)`：读进程表（`/bin/ps -A -o pid=,ppid=`）并返回后代列表；读不到返回 `undefined`（表示无法核验，不假装成功）。
- `terminateProcesses(pids, options)`：对存活目标发 SIGTERM → 1s 宽限 → 升级 SIGKILL → 0.8s 宽限 → 逐个 `kill(pid, 0)` 探测；未消失的写入 `survivors`，`status` 为 `unconfirmed`。
- `reapProcessTree(rootPid)`：`snapshotDescendants` + `terminateProcesses` 的组合（root 仍存活时的便捷入口）。
- `McpClientManager.disconnect()` 接线：**先快照后代，再 `client.close()`，最后终止快照集合 + root**；证据存入 `reapEvidence`，可由 `getReapEvidence()` 读取；非 `confirmed` 时打印警告说明是"无法核验"还是"仍有 N 个进程存活"。

### 顺序约束是被宿主实测逼出来的

第一版实现是"close() 之后再按 ppid 枚举后代"。宿主真机用例立刻失败：杀掉 `sh` 之后，它的 `sleep` 被 reparent 到 pid 1，`ppid` 链断裂，`collectDescendants(root)` 只返回空，函数却返回 `status: confirmed` —— 典型的"确认终止但进程还活着"。因此现在把快照提到 close 之前，并把这一约束写进模块文档与测试注释。

## 证据

`mcp-process-reaper.test.ts`（13 项；11 项纯确定性 + 1 项 Manager 接线 + 1 项真实进程树）：

| 场景 | 断言 |
| --- | --- |
| 三层进程树 | `collectDescendants` 返回后代且先深后浅，不含无关进程 |
| 进程表成环 | 不死循环 |
| root 为 pid 1 | 目标集合不含 pid 1 与自身 |
| 后代响应 SIGTERM | 只发 SIGTERM、`status=confirmed`、无 survivor |
| 后代忽略 SIGTERM | 仅该 pid 收到 SIGKILL，`status=confirmed` |
| 进程表不可用 | `status=unavailable`、不发任何信号 |
| 目标一直存活 | `status=unconfirmed`，survivors 完整列出 |
| root 已自行退出 | 仍收口后代 |
| `readTransportPid` | stdio 有 pid 返回数字；`{}`/`undefined`/`0` 返回 null |
| `disconnect()` 接线 | 调用 `close()` 且写入一条回收证据（受限会话为 unavailable，宿主为 confirmed） |
| 真实 `sh` → `sleep` 树 | 先杀 `sh` 让 sleep 成孤儿，用快照集合回收后 sleep 确实不存在（`kill(pid,0)` 抛错） |

真实进程树用例依赖 `/bin/ps`：受限会话内 `posix_spawn('/bin/ps')` 返回 EPERM，该用例自动 skip；宿主真机执行且通过。宿主日志 `.context/mcp-reaper-verify.log`：`mcp-process-reaper` **13 pass / 0 fail / 0 skip**，`mcp-resource-tools` 2 项、`tool-impls` 20 项零失败。

## 边界

- **只覆盖 stdio 传输**。SSE/HTTP 连接没有本地子进程，服务端侧资源释放依赖对端；本切片未涉及。
- **只覆盖 `disconnect()` 路径**。若 `close()` 抛出异常后被跳过，仍会执行回收（代码顺序保证），但进程在 `connectAll()` 失败重试中的中间态未单独处理。
- **快照—终止之间的新派生进程可能漏掉**：`client.close()` 到 `terminateProcesses` 之间服务端若再 fork，新进程不在快照里。窗口很短但没有原子手段（没有 cgroup/job 级隔离）。
- **`ps` 依赖**：进程表不可用时一律标 `unavailable` 并告警，不会假装已清理。Windows 未验证（当前 `platform !== 'darwin'` 的 Bash 沙箱本身就是默认拒绝，MCP 回收未加平台分支）。
- **未做真实 Electron 打包应用 + 真实 MCP server 验证**；接线经单测覆盖，未在打包产物里启动真实 `npx` 系 server 观察孤儿进程。
- Provider 无回执的 unknown 语义、崩溃重启对账仍属受控自主第 3 步的未完成部分。

## SIGKILL 前再次核对

SIGTERM 宽限期后重新读取进程表并核对身份；PID 已复用或身份不可验证时不升级发送 SIGKILL。定向测试模拟宽限期间 PID 复用。`ps` 启动时间仅精确到秒，检查与发送信号仍不具备内核级原子性，不能声称完全消除 PID 复用误伤风险。

## 默认安全降级

MCP 断开不再根据 PID 快照向后代追加 SIGTERM/SIGKILL。SDK 仍负责关闭连接及其直接子进程；后代可能成为孤儿，状态标为 unknown，不能宣称已清理。原 PID 回收函数只用于测试与研究，不再接入断开路径。单元测试核对断开时不调用本模块的进程信号、保留 SDK close，并记录 unknown/unavailable；不能据此推断 SDK 自身不会发送信号。受管启动及进程组退出证明尚待实现。

安全降级新增真实子进程测试：受控 sleep 持续运行时执行断开，断开保持 unknown/unavailable 且不额外发信号；测试结束由测试自身清理其直接子进程。这验证降级行为，不验证 SDK 的真实 MCP 关闭或后代隔离。

本地真实 MCP stdio 测试以独立临时配置目录运行，连接真实子进程、执行初始化和工具列表后关闭，断开记录 unknown/unavailable 且不额外发送终止信号；不代表打包 Electron 或复杂服务器验收。

## 受管进程组基础切片（尚未接入 MCP）

新增独立监督进程接口：监督者以 detached 进程组组长身份启动目标，透传 stdin/stdout/stderr；停止时由仍存活的组长向自身进程组发送信号，避免主进程依据事后 PID 快照杀后代。真实子进程测试覆盖输入输出、同组后代停止及不存在的命令。返回 unconfirmed，不能证明脱离进程组的后代已退出；仅在本地 Bun 环境测试，尚未接入 MCP transport、Electron 打包路径或其他平台，也不表示 P0 已完成。

## 受管 stdio 适配基础（尚未启用）

新增受管 stdio transport，测试使用真实 MCP SDK 完成握手和工具查询，覆盖服务立即退出、启动中关闭、大响应发出后退出、大量 stderr。监督者通过同一 stdout 流中的随机令牌结束标识保证读取顺序，目标命令启动超时会请求监督者停止；结果仍标 unconfirmed。Electron 自带二进制的 Node 模式通过本地握手和工具查询；没有在打包后的应用、真实第三方 MCP、脱组后代或异常崩溃下完成验收。该 transport 尚未接入默认启动流程，不能据此宣称 P0 完成。

## macOS MCP 接线切片

macOS 的 MCP stdio 连接使用受管 transport，并沿用 SDK 的安全默认环境与显式服务配置；其他平台继续使用 SDK 原有 transport。真实本地 MCP 连接测试覆盖初始化、工具列表与关闭，受管 transport 另覆盖大响应、异常退出和关闭竞态；定向测试及类型检查通过。停止只覆盖留在受管进程组内的进程，脱组后代和崩溃恢复无法证明，仍标 unknown；打包应用和真实第三方 MCP 验收尚未完成。

## 控制通道断开与测试包证据

独立测试主动断开监督进程 IPC 通道，确认仍在同组的后代未执行延迟写入；这模拟控制通道断开，不等于覆盖所有强杀、断电或脱组情况。对 `00b7b645` 的未签名 macOS 测试包检查确认主进程 bundle 包含受管 MCP 代码，包内可执行文件以 Node 模式运行独立编译的 transport 可完成 MCP 握手、工具查询及未确认停止。尚未通过应用界面运行包内实际接线或真实第三方 MCP，构建跳过原生依赖重建。
