# MCP 进程回收的身份校验：局部证据

日期：2026-10-29；范围仅 MCP stdio 服务端的进程树回收路径，不代表 Bash 进程组终止、其他 Runtime 或打包应用验收已覆盖。

## 缺口

`bb7dc7c6` 引入的回收顺序是「快照 pid → `client.close()` → 对快照里的 pid 发信号」。中间隔着 `close()` 与 SIGTERM/SIGKILL 两个宽限期（默认 1000ms + 800ms）。在这个窗口里，快照中的进程可能已经自行退出，操作系统会把同一个 pid 分配给一个**无关的新进程**。此时按 pid 发 SIGKILL 会误伤别人——这是一种不可逆的破坏，而它防的是"进程泄漏"这种可观测、可补救的问题。原来的实现没有做任何身份核对。

## 本次改动

**身份标识**：`listProcessTable()` 改为优先读取 `ps -A -o pid=,ppid=,lstart=`，把启动时间作为身份标识（`startedAt`）。`lstart` 精度到秒，同一 pid 在 1 秒内被复用且启动时间完全相同的概率可忽略。若 `ps` 不支持 `lstart`，退回只有 pid/ppid 的表——此时所有目标都会被判为身份不可验证。

**比对**：`verifyIdentity(table, pid, expected)` 返回四态：`match`（启动时间一致）、`gone`（表中已无此 pid，目标已退出）、`reused`（同 pid 但启动时间不同，PID 已被复用）、`unverifiable`（任一侧缺启动时间）。

**发信号的准入**：`terminateProcesses(pids, { identities, listProcesses })` 在动手前先读一次进程表逐 pid 比对：

- `match` → 允许发信号；
- `reused` → **不发信号**，记入 `skippedReused`（目标其实已退出，收口目的已达成）；
- `gone` → 不发信号，也不算 survivor；
- `unverifiable` → **不发信号**，记入 `unverified`，整体状态为 `unknown`；
- 进程表读取失败 → 不发信号，状态 `unavailable`。

`ReapEvidence` 新增 `skippedReused`、`unverified`、`identity: 'verified' | 'unverified'`，状态枚举新增 `unknown`。`mcp-client` 的断开日志按状态区分「无法核验（进程表不可用）」「身份无法确认，未下发信号」「已跳过 N 个 PID 被复用的目标」。

**快照后派生**：`reapProcessTree` 在首轮快照与发信号之间**再读一次进程表**，把首轮之后被 root 新派生的进程补进目标集合并补记身份。这一步只覆盖"发信号前仍在 root 子树里的新进程"；已经被 reparent 到 pid 1 的进程无法按父指针找回，这一点仍是窗口。

**调用方**：`mcp-client.disconnect()` 改用 `snapshotProcessTree`（快照同时取身份），`close()` 之后把 identities 传给 `terminateProcesses`。

## 证据

`mcp-process-reaper.test.ts` 由 12 项扩到 24 项：

- `verifyIdentity` 四态各一例；
- **PID 复用**：快照后同 pid 启动时间变为 `10:30`，`skippedReused === [102]`，102 未收到任何信号，`status === 'confirmed'`；
- **身份不可验证**：表里没有启动时间（模拟 `ps` 不支持 `lstart`），三个目标全部进 `unverified`，`signals === []`，`status === 'unknown'`；
- **发信号前进程表读不到**：`status === 'unavailable'`，`signals === []`；
- **后代重挂载**：首轮 101 挂在 100 下，父进程消失后 101 重挂到 pid 1，回收仍按快照身份终止 101，且不碰未在快照里的 102；
- **快照后派生**：首轮只有 100，二次枚举出现 103，`targeted === [100, 103]` 且两者都被终止；
- `parseProcessTable` 三例（含 `lstart` 空格、无 `lstart`、异常行）；
- 原有 6 项确定性用例改为给假表补启动时间（真实进程表带 `lstart`），行为断言不变；
- 真实进程用例（`sh` 派生 `sleep`，仅在 `ps` 可用的宿主执行）额外断言 `snapshotProcessTree` 能读到真实 `lstart`，并把 identities 传给终止。

`mcp-client` 9 项与 `mcp-process-reaper` 24 项零失败；typecheck=0、biome 通过。受限会话内 `ps` 不可用，真实进程与环境变量相关用例按 `skipIf` 跳过——**这是 skip，不计入通过**。

## 边界与残留窗口

- **启动时间不是绝对身份**：`lstart` 精度到秒，同秒内 pid 复用理论上可混淆；没有引入 pidfd / `proc_pidinfo` 级别的句柄绑定。
- **收到信号后仍可能误伤**：本切片只保证"发信号前身份一致"。SIGTERM 与 SIGKILL 之间还有 1000ms，目标若在此期间退出并复用，第二次信号仍可能落到新进程上。彻底关闭需要 pidfd 或按进程组隔离（`detached: true`），SDK 的 `StdioClientTransport` 未暴露该选项，未做。
- **重挂载后新派生的进程找不回**：`reapProcessTree` 的二次快照只在 root 仍存活时有效；root 死亡后子进程 reparent 到 pid 1，ppid 链断裂，既无法枚举也无法与无关进程区分。真正的关闭手段仍是让服务端自成进程组后整组终止（Bash 侧已用 `detached` 做到，MCP 侧受 SDK 限制未做到）。
- **身份不可验证时选择不回收**：`ps` 不支持 `lstart` 的平台会出现"该回收却标 unknown 且不动手"，进程泄漏仍然存在。这是刻意的取舍——泄漏可观测（证据 + 日志），误杀不可逆。
- **未做真实 MCP 服务端验收**：受限会话内 `ps` 被拒，真实进程用例在本环境为 skip；宿主结果尚未在本轮采集。
