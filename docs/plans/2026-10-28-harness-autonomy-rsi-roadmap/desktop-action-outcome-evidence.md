# 桌面动作的结果分类：局部证据

日期：2026-10-29；范围仅 Computer Use 的写操作工具（click/move/doubleClick/drag/scroll/type/keyCombo），不代表截图等只读工具、WebBridge 动作或真实桌面验收已覆盖。

## 缺口

Computer Use 的写操作调用 `computerUseService` 后只拿到一句 message；服务抛错时异常直接穿出工具层，模型看到的只是错误文本。导致的后果是：**已经生效的动作被当成失败而重试**——重复点击、重复提交、重复输入，或者在用户机器上叠加本不该发生的操作。

计划里"Provider 或外部动作没有可核验回执时维持 unknown，禁止自动重试"正是这一层：桌面动作没有回执，抛错不等于没生效。

## 本次改动

新增 `computer-use-outcome.ts`：

- `classifyDesktopActionFailure(error)` 把失败分成两类：
  - **`not_applied`**：可以确认动作没生效。判据是明确的前置失败——错误码 `EPERM`/`EACCES`/`ENOTSUP`/`ENODEV`/`EINVAL`/`ENOENT`，或错误文案命中"未授权/无权限/permission/denied/不支持/不可用/越界/out of range/invalid/无效"。
  - **`unknown`**：无法确认是否生效。判据是 `TimeoutError`/`AbortError`、`ETIMEDOUT`/`ECONNRESET`/`ECONNREFUSED`/`EPIPE`/`EAI_AGAIN`/`EAGAIN`、或文案命中"超时/中断/未知/信号"。**默认落在这里**——拿不准就不假设没生效。
- `describeDesktopActionFailure(action, error)` 生成给模型的指令：`unknown` 明确写"动作可能已经生效。禁止自动重试；请先调用 ComputerUseScreenshot 确认当前屏幕状态，再由用户决定是否继续"；`not_applied` 写"已确认动作没有生效，修正前置条件后可以重试"。
- `computer-use-tools.ts` 统一走 `runDesktopAction(action, ctx, detail, run)` 包装：成功记 `outcome: 'applied'` 并保留原始 message；失败按分类记审计并返回错误结果。审计行现在带 `outcome`（和未知时的 `error`），可以直接统计"未知结果"的比例。

## 证据

`computer-use-outcome.test.ts`（9 项，纯函数）：
超时/中止/四种网络类错误码 → `unknown`；四种权限类错误码 → `not_applied`；中文前置失败文案（未授权、坐标越界、平台不支持）→ `not_applied`；普通异常与字符串/undefined → 保守 `unknown`；超长错误信息理由截断到 300 字符；文案层校验"禁止自动重试 + 要求先截图"与"可修正后重试"两种措辞不混淆。

`computer-use-tools.test.ts` 新增 4 项（围绕 `spyOn(computerUseService, …)`）：
- 服务超时 → `isError`、内容含"结果未知""禁止自动重试""ComputerUseScreenshot"；
- 权限拒绝（EPERM）→ 内容含"未执行"且不含"结果未知"；
- 未知异常（`CGEventPost failed`）→ 保守判为结果未知；
- 成功路径 → 保留原始 message 且标注 `applied`（回归）。

定向回归：`computer-use-outcome` 9 项、`computer-use-tools` 8 项全部零失败；typecheck=0、biome 通过。

实现期修掉一个真实 bug：包装器的 `catch (error)` 参数遮蔽了同文件内的 `error()` 构造器，导致把异常对象当文案返回。改名为 `thrown` 后类型检查即报错消失——这也说明类型检查在这里守住了行为。

## 边界

- **不是回执**：桌面动作仍然没有可核验的成功回执，`applied` 只表示"服务调用返回了"，不代表屏幕上真的发生了什么；真正的验证只能靠事后截图与用户确认。
- **只覆盖 Computer Use 写操作**：截图/能力查询等只读工具不做分类（失败无副作用）；WebBridge 的点击/输入仍是另一条链路，未纳入本切片。
- **未做真实桌面验收**：所有用例通过 stub 服务注入异常，未在真实 macOS 桌面触发真实超时或权限拒绝；审计写入走既有 `appendComputerUseAudit`，其落盘失败被静默忽略（既有行为，未改）。
- **分类是启发式**：靠错误码与文案模式，不同 macOS 版本或服务实现的错误措辞变化会导致归类落到 `unknown`——方向上是保守的，不会误判成"未执行"。
- 分类结果不自动触发重试或终止会话，只是把"未知"暴露给模型与审计；是否停下由上层策略决定。
