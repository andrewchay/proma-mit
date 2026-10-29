# 「结果未知禁止重试」的执行约束：局部证据

日期：2026-10-29；范围仅三个工具执行入口（Computer Use 写动作、Web Bridge 写动作、MCP `callTool`），不代表 UI 审批流、其他 Runtime 或打包应用验收已覆盖。

## 缺口

前两片给桌面动作、Web Bridge、MCP 工具调用补了「未执行 / 结果未知」分类，但结论只写在两处：返回给模型的文案、审计记录。**提示不具备约束力**——模型下一轮完全可以再调一次同一个动作，造成重复点击、重复提交、重复下单。证据文档里也如实写了「分类结果不自动触发重试或终止会话，是否停下由上层策略决定」，而上层策略并不存在。

同时，原来的判据存在误判方向的问题：`EINVAL` 与裸的 `invalid` / `无效` 被当作「未执行」。这两个信号都可能出现在动作**已经派发**之后（内核在部分提交后报 `EINVAL`、CDP 在事件发出后报 `invalid`），判成未执行会诱导模型重试一个已经生效的动作——与分类的初衷正好相反。

## 本次改动

**持久化登记** `unknown-action-store.ts`：
- 记录 `{ sessionId, tool, actionKey, detail, reason, createdAt, status }`，追加写入 `unknown-actions.jsonl`；
- 指纹 `actionKey = 工具 + 目标`：桌面点击是坐标 + 显示器，拖拽是起终点，输入是文本哈希，Web Bridge 是 `elementId` 或 URL，MCP 是工具名 + 参数稳定哈希（键排序序列化，同参数不同书写顺序得到同一指纹）；
- 内存缓存 + 首读从磁盘重建，进程重启后仍然拦截；
- 落盘失败只告警，内存判定照旧——宁可多拦一次，也不放行重复动作。

**执行入口强制拦截**：三个入口在调用服务之前先查同会话同指纹的 pending 记录：

- `runDesktopAction`（Computer Use 七个写动作）；
- `runWebBridgeAction`（Web Bridge 七个写动作）；
- `McpClientManager.executeTool`。

命中即返回错误并说明依据（时间、理由、确认手段、解除接口），**不再触达服务层**。判定为 `unknown` 时才登记；`not_applied` 不登记——那时已确认没生效，重试是合法的。

**解除** `resolveUnknownAction({ sessionId, id | actionKey, resolution })`：必须带上处理依据（例如"用户截图确认未生效""在 Issue 列表确认没有重复单"），解除事件也落盘，便于事后审计"为什么允许继续"。

**判据收窄**：桌面域从 `preActionCodes` 移除 `EINVAL`，从文案判据移除裸 `invalid|无效`，改为 `invalid (parameter|argument|coordinate)|参数无效|坐标`；Web Bridge 域把 `invalid` 收窄为 `Invalid parameter|Invalid argument|参数无效`，其余保持不变。两个域的 `not_applied` 现在只包含"派发前就能确定"的信号。

## 证据

`unknown-action-store.test.ts`（12 项）：
登记后可查到 pending；未登记不拦截；同会话同指纹被拒绝且文案含时间、理由、确认手段与解除接口名；不同会话互不拦截；同会话不同目标不拦截；按指纹解除后放行且保留处理依据；按 id 解除但会话不匹配时不生效；会话内多条只列本会话；**清空内存后从磁盘恢复 pending**；解除事件落盘后重建不再拦截；指纹稳定（键序无关、不同参数区分）；指纹带工具前缀。

端到端拦截（三处各一）：
- Computer Use：超时后同坐标再点 → `拒绝执行` 且 `computerUseService.click` **未被调用**；不同坐标照常执行并各自登记；调用 `resolveUnknownAction` 后同坐标重试成功；
- Web Bridge：`Target closed` 后点同一 `element_id` → 拒绝且服务未被调用，文案带 `WebBridgeObserve`；
- MCP：`Connection closed` 后同参数再调 → 拒绝且 `callTool` 调用次数不增加；参数不同照常调用。

判据收窄的阴性测试：`EINVAL` → unknown；`Invalid state transition`、`invalid event after dispatch`、`无效状态` → unknown。

定向回归：`unknown-action-store` 12 项、`computer-use-tools` 9 项、`web-bridge-tools` 14 项、`mcp-client` 10 项、`computer-use-outcome` 13 项、`web-bridge-outcome` 11 项、`mcp-tool-outcome` 11 项零失败；typecheck=0、biome 通过。

## 边界

- **解除入口没有 UI**：`resolveUnknownAction` 目前只有 API，没有审批流或对话入口调用它。也就是说"用户明确处理"这一步在产品层尚未闭环——模型会被拦住并收到指引，但人没有一键解除的地方。这是本轮之后最直接的欠账。
- **指纹粒度是启发式**：同坐标两次点击被视为同一动作，但同一个按钮的两次不同意图（例如先取消再确认）如果坐标相同会被误拦。粒度粗于语义。
- **成功不自动解除**：后续同类动作成功不构成对上一次的核验（可能是另一次点击），因此必须显式解除。
- **跨进程并发**：JSONL 追加是单行原子写，但多进程同时登记时内存缓存不同步；桌面应用是单主进程，这个限制在打包场景下未被验证。
- **只在工具层强制**：绕过工具层直接调用 `computerUseService` / `webBridgeService` / `client.callTool` 的路径不受约束。
- **未做真实桌面/浏览器/MCP 服务验收**：全部用例用 stub 服务注入异常，没有在真实设备上制造超时后重试的完整链路。
