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
