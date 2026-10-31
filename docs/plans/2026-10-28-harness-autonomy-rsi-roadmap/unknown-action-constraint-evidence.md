# 「结果未知禁止重试」的执行约束：局部证据

日期：2026-10-29；范围仅三个工具执行入口（Computer Use 写动作、Web Bridge 写动作、MCP `callTool`），不代表 UI 审批流、其他 Runtime 或打包应用验收已覆盖。

## 缺口

前两片给桌面动作、Web Bridge、MCP 工具调用补了「未执行 / 结果未知」分类，但结论只写在两处：返回给模型的文案、审计记录。**提示不具备约束力**——模型下一轮完全可以再调一次同一个动作，造成重复点击、重复提交、重复下单。证据文档里也如实写了「分类结果不自动触发重试或终止会话，是否停下由上层策略决定」，而上层策略并不存在。

同时，原来的判据存在误判方向的问题：`EINVAL` 与裸的 `invalid` / `无效` 被当作「未执行」。这两个信号都可能出现在动作**已经派发**之后（内核在部分提交后报 `EINVAL`、CDP 在事件发出后报 `invalid`），判成未执行会诱导模型重试一个已经生效的动作——与分类的初衷正好相反。

## 初版改动（历史，当前语义见下文）

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

### 初版证据（历史计数）

`unknown-action-store.test.ts`（12 项）：
登记后可查到 pending；未登记不拦截；同会话同指纹被拒绝且文案含时间、理由、确认手段与解除接口名；不同会话互不拦截；同会话不同目标不拦截；按指纹解除后放行且保留处理依据；按 id 解除但会话不匹配时不生效；会话内多条只列本会话；**清空内存后从磁盘恢复 pending**；解除事件落盘后重建不再拦截；指纹稳定（键序无关、不同参数区分）；指纹带工具前缀。

端到端拦截（三处各一）：
- Computer Use：超时后同坐标再点 → `拒绝执行` 且 `computerUseService.click` **未被调用**；不同坐标照常执行并各自登记；调用 `resolveUnknownAction` 后同坐标重试成功；
- Web Bridge：`Target closed` 后点同一 `element_id` → 拒绝且服务未被调用，文案带 `WebBridgeObserve`；
- MCP：`Connection closed` 后同参数再调 → 拒绝且 `callTool` 调用次数不增加；参数不同照常调用。

判据收窄的阴性测试：`EINVAL` → unknown；`Invalid state transition`、`invalid event after dispatch`、`无效状态` → unknown。

定向回归：`unknown-action-store` 12 项、`unknown-action-tools` 10 项、`computer-use-tools` 9 项、`web-bridge-tools` 14 项、`mcp-client` 10 项、`computer-use-outcome` 13 项、`web-bridge-outcome` 11 项、`mcp-tool-outcome` 11 项零失败；typecheck=0、biome 通过。

## 解除闭环与人工结论（当前语义）

- `ListUnknownActions`（只读）列出本会话待处理记录；除指纹、工具、理由和时间外，还返回人工结论 `resolution` 与确认时间 `acknowledgedAt`。
- `ResolveUnknownAction`（写）**必须经过用户确认**。选择「动作没有生效」后，解除事件成功落盘才放行并标 `mayRetry: true`；选择「动作已生效」后追加 `confirmed_applied` 事件，返回 `acknowledged: true`、`mayRetry: false`，但保留 pending 和同指纹门禁；「暂不处理」、用户拒绝或确认请求抛错均保持拦截。
- 「已生效」不再只是一句返回文案：确认时间、结论和原始未知原因在重启后仍可恢复，后续拦截文案明确显示已确认生效且仍禁止重试。确认事件写入失败时不伪造内存结论。

**模型不能自行解除后重试**——没有 `onAskUser` 通道时工具直接拒绝，而不是退化成静默放行。

## 失败留痕与重放

`finishTrackedAction(record, false, reason)` 追加 `unknown_failed` 事件并保留 pending；Computer Use、Web Bridge、MCP 都传入实际异常原因，不再只留下「动作已登记，结果待确认」。重放时，`unknown_failed` 与 `confirmed_applied` 只更新同 session、同指纹且同记录 ID 的当前记录；旧事件不能改写或解除同指纹的新记录。

`unknown-action-store.test.ts` 现为 23 项，覆盖失败原因重启恢复、人工生效结论重启恢复、执行中禁止确认、确认写入失败不伪造结论，以及既有并发、解除和损坏文件失败关闭。`unknown-action-tools.test.ts` 现为 11 项，额外验证确认事件落盘、列表可见和持续拦截。

## 边界

- **解除使用专用安全确认卡片，但没有持久清单面板**：`interactionType: 'unknown_action_resolution'` 会显示独立的琥珀色核对提示；不同于普通问答，不预选第一个“未生效、允许重试”的选项。用户必须主动选择，跳过或延期仍保持拦截。`ListUnknownActions` 仍是当前会话内的只读工具，没有跨会话清单面板或批量处理。定向测试覆盖交互类型传递和未知动作不预选；不代表打包应用或真实 Provider 验收。
- **指纹粒度是启发式**：同坐标两次点击被视为同一动作，但同一个按钮的两次不同意图如果坐标相同会被误拦；语义等价的变形重试也可能绕过指纹。
- **后续成功不核销历史 unknown**：另一个同类动作成功不构成对上一次的核验，必须显式对账。
- **跨进程并发未解决**：JSONL 追加与单主进程内存缓存不能协调多个进程；打包场景仍需实测。
- **只在工具层强制**：绕过工具层直接调用 `computerUseService` / `webBridgeService` / `client.callTool` 不受约束。
- **持久性不是 fsync 保证**：写入失败会保持拦截，但断电与多进程场景不能承诺同等持久性。

## 本轮回归与未验收项

最终定向复验：`unknown-action-store` 23 项、`unknown-action-tools` 11 项、`computer-use-tools` 10 项、`web-bridge-tools` 14 项、`mcp-client` 14 项、`mcp-tool-outcome` 11 项零失败；Agent Runtime 全目录 121 个测试文件零失败；typecheck=0、biome 通过、`git diff --check` 通过。

全仓分四批覆盖 786 个测试文件，合计 5576 pass、47 skip、1 fail。唯一失败为 `academic/run-service` 的真实本地执行器用例（期望 completed、实际 failed），已独立复现，与本次门禁修改无关；因此本轮不能声明全仓全绿。

真实桌面、浏览器和远端 MCP 的异常注入、真实 Provider、生产部署、打包应用与最终用户接受仍未验收；单元测试和运行完成状态不能代替业务签收。
