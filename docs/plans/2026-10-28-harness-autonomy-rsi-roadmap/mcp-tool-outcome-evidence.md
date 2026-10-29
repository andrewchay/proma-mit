# MCP 工具调用的结果分类：局部证据

日期：2026-10-29；范围仅 MCP `callTool` 的失败语义，不代表资源读取、工具列举、真实远端 MCP 服务或打包应用验收已覆盖。

## 缺口

`mcp-client.ts` 的 `executeTool` 把所有失败压成一句：

```
return { content: `MCP 工具调用失败: ${message}`, isError: true }
```

MCP 服务端是外部进程或远程服务。一次 `callTool` 抛错**不能**说明工具没执行：请求可能已经送达并在服务端产生了副作用（发出邮件、写入远端记录、提交工单），只是响应在返回途中超时或连接断开。模型看到"调用失败"就会重试——在真实系统上是重复执行。同时这也丢掉了唯一可用的结构化判据：JSON-RPC 错误码。

## 本次改动

**共用骨架扩容**：`describeActionFailure` 增加可选 `classify` 参数，允许域内提供额外判据，保证"文案"和"归类结论"走同一个实现。这一条是被测试逼出来的——初版 `mcp-tool-outcome` 的文案函数内部重新调用了通用 `classifyActionFailure`，导致 JSON-RPC 错误码分支在文案侧根本走不到，同一错误会出现"文案说未执行、归来说未知"的错位。

**新增 `mcp-tool-outcome.ts`**：

- 先看 JSON-RPC 错误码（比文案可靠得多）：
  - `-32600` Invalid Request、`-32601` Method not found、`-32602` Invalid params → **未执行**（服务端明确拒绝）；
  - 其余错误码（`-32603` Internal error、`-32000` 至 `-32099` 服务端自定义）→ **结果未知**，因为服务端报错前可能已经产生部分副作用。
- 没有数字错误码时退回共用骨架：传输层断连（`Connection closed`、`socket hang up`、`ECONNRESET`、`EPIPE`、超时、中止）→ 未知；`未连接`、`Method not found`、`工具不存在`、权限拒绝 → 未执行；其余默认未知。
- 文案：未知时明确"工具可能已在服务端执行。禁止自动重试；请先核对目标系统的实际状态（重新读取相关资源或查询对应系统），再由用户决定是否继续"。

**接入 `executeTool`**：`catch (thrown)` 走 `describeMcpToolFailure`，日志按"结果未知/未执行"分级输出，返回分类文案。未连接服务器与调用前已中止两条早退路径保持原样——它们确实没发出请求。

## 证据

`mcp-tool-outcome.test.ts`（11 项，纯函数）：
三种拒绝码 → 未执行；三种服务端错误码 → 未知；**错误码优先于文案**（文案写着"工具未执行"但码是 `-32603` 时仍判未知）；超时/中止 → 未知；六种传输错误码与三种断连文案 → 未知；五种前置失败文案 → 未执行；`undefined`/字符串 → 保守未知；理由截断 300；文案层校验两种措辞互不串台，并专门断言"`-32603` + Invalid params 文案"仍归未知。

`mcp-client.test.ts`（9 项，原 4 项 + 新增 5 项，注入 stub client，不拉起真实进程）：
`Connection closed` → 结果未知且文案带 `demo__create_issue` 命名空间；`-32602` → 未执行；`-32603` → 未知且提示核对目标系统；服务器未连接 → 保持原明确文案；调用成功 → 不出现未知提示。

定向回归：`mcp-client` 9 项、`mcp-tool-outcome` 11 项、`mcp-resource-tools`、`runtime-mcp-service`、`pi-tool-bridge`、`tool-session-gate`、`web-bridge-tools`、`computer-use-tools` 全部零失败；typecheck=0、biome 通过。

## 边界

- **不是回执**：判为"未执行"只依据服务端明确拒绝或连接未建立；判为"未知"时无法判断副作用，只能靠人去核对目标系统。
- **未接真实 MCP 服务**：全部用例用 stub 注入异常，没有对真实 stdio / HTTP MCP 服务制造超时或断连。
- **资源读取与工具列举未分类**：`listAllResources`、`readResource`、`listAllTools` 失败仍走各自日志路径；只读操作没有外部副作用，因此未纳入。
- **错误码映射依据 JSON-RPC 2.0 标准与 MCP 服务端惯例**：服务端自定义码（`-32000..-32099`）一律按未知处理，不猜测具体含义。
- **进程回收未变**：孤儿进程树回收仍是 `bb7dc7c6` 的独立机制，本切片不改变它。
