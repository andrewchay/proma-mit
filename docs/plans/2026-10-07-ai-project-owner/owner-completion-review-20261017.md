# Owner 收尾复验：2026-10-17

本记录区分源码实现、固定包窗口、模拟响应、真实模型、独立验证和用户验收。没有按测试数量折算产品完成率。AO-A02 继续遵守用户“先留作待验收”的决定。

## 本轮发现及修复

1. **澄清保存后没有新准备**：effect 在来源仍在读取时记录“已尝试”，后续不再续接。现在等待目标、计划与 Runtime 来源均加载且干净、版本匹配后才记录；只创建一次无费暂停准备。浏览器回归故意延迟来源回读，证明准备一次、付费启动零次。
2. **规划结束需要手动刷新**：queued/running 期间每 4 秒和窗口 focus 只读刷新 Run/Plan，完成或离开组件即停止；不派工、不调用模型。固定包走通目标→澄清→保存答复→新准备→新规划，无需手动刷新或手动准备。
3. **已生成计划被误标为旧 Run**：Runtime 与 Home 复用同一精确来源判定；允许该 Run 生成并确认的计划推进 revision，仍拒绝手工替换、错回执或 stale 来源。
4. **计划不能移除步骤**：现在可移除没有下游依赖的步骤；至少保留一步。仅改未保存草案，保存新版本并重新确认后才生效。
5. **DeepSeek Reviewer 正文被思考内容挤占**：真实请求第 3 条在 4096 token 处 length，其中 reasoning 3894。只对 deepseek-flash Reviewer 提高为 8192，仍受审核模型上限、逐请求完整预留和原命令预算约束，不提高 grant 费用或次数。
6. **工具目录与用途门禁不一致**：Owner 实际只允许知识读取、逐次审批的 Write/Edit，却向模型暴露 58 个工具。现仅发送这四个工具，不加载 MCP；明确提示没有普通 Read、Shell、Grep/Glob 或子代理，缺少必要能力应报告未验证项并停止。没有扩大现有 G0 工具许可。
7. **Owner 业务请求仍可能自动重试**：业务与规划均关闭 Runtime 外层和 AI SDK 内部重试，并禁止业务请求用上下文超限压缩隐式重放。普通 Agent 行为保持原样。
8. **项目命令卡缺少审批直达入口**：增加“打开执行会话 / 处理审批”，按 command.executionId 精确核对项目、Task、员工及会话；拒绝跨项目、空会话、Workflow 和“最近会话”猜测。打开只读历史，不启动或重试执行。

## 固定包与本地传输证据

### 完整对话及真实原生确认

隔离 profile `owner-completion-window-1792239296322`，仅 loopback 模拟模型：目标→必要澄清→答复保存→自动暂停准备→第二次规划→内容确认→执行配置→任务登记/核验→真实 macOS 自主调度确认。取消后 grant=0、command=0、模型请求仍为此前两条规划。再次打开原生确认并允许后，主进程自动完成 Executor 0→Reviewer changes_requested→Executor 1→Reviewer approved，四条命令均 settled，Task 仍 paused，未伪造业务验收。

这是实际固定包、实际 Runtime、实际原生弹窗与 SQLite；模型输出为模拟响应。它证明调度、有限返工及门禁链，不能证明真实模型返工质量。

### 迟到回调与恢复 GUI 同场

独立 profile `owner-recovery-late-1792240117079`：正式命令进入实际 Runtime 请求后，传输端保持响应；SIGSTOP 暂停旧主进程，再以同一原生 WAL 数据库启动新固定包窗口，正常启动恢复将旧 execution 置 stale、grant 置 paused、command 置 needs_reconcile。随后释放迟到 Write 响应并恢复旧主进程。

新 GUI 恢复前后读取同一冻结链；迟到响应未写出 `denied-late.txt`，未新增 Provider 请求（loopback=1），原 250,000 microUSD 命令预留仍占额，actual cost 仍 null；旧 Runtime 不能自动结清、复活授权或派发下一角色。Renderer 异常为空、SQLite integrity_check=ok。此故障注入保留旧 Runtime 活体以验证迟到回调，不是声称做过真实远端停止验证。

本地原文、截图、脚本和 SQLite 备份分别在忽略目录 `test-results/owner-completion-20261017/`、`test-results/owner-recovery-late-20261017/`。

## 真实 DeepSeek：12 次请求的结果

用户本轮授权：最多 12 次模型请求，合计 ¥15，包含附属请求；费用或终态未知即暂停，不自动重试。转发器仅转发固定 DeepSeek chat/completions，不改请求体，记录请求序号、响应 ID、SSE 和 usage；发送前按 UTF-8 字节保守输入上界、输出上限及官方峰时人民币单价核验总预算，串行发送且达到 12 次即阻断。

| 请求 | 结果 | 可证明 / 限制 |
|---|---|---|
| 1 | Owner 生成有效三步定位提案 | 真实规划成功；不采纳机械拆分为单项业务需求本身已完成 |
| 2 | Executor 返回简报 | 真实后台执行成功；仍须独立核对内容 |
| 3 | Reviewer HTTP 200 + length + 完整 usage | 4096 上限不足；验收转发器错误将 length 改为 502，应用因此记 unknown。原失败证据和账本保留，不改写为成功 |
| 4 | 新 Task、新 grant 的 Executor 完整返回 | 修复后独立复验；旧失败记录保留 |
| 5 | Reviewer 使用 8192，完整返回 approved | 真实技术评审链成功；Task 保持 paused。人工独立复核仍指出部分竞品/痛点推导未被来源直接支持 |
| 6 | 命令绑定反馈重规划返回 stop，但 JSON 不合法 | 界面完整走通反馈→Task Goal→暂停准备→单次费用确认；模型结构不合格，系统拒绝新计划，没有隐式修复或补发 |
| 7–12 | 隔离报价仓库真实代码执行；一次 Write 获逐次批准 | Read/Bash/Grep 等被用途门禁拒绝，暴露工具目录错误。12 次上限后后续请求未转发；代码命令需要对账，未运行真实 Reviewer，不记完整代码闭环成功 |

实际转发模型请求共 12 次。完整 usage 按官方峰时价计算上界合计 **¥0.362544**（缓存输入全部按未命中保守计），不是 Provider 实际账单；Provider 账户级余额 API 前后下降 **¥0.11**，受显示精度、更新延迟及其他并发消费归因限制，不能替代逐请求账单。美元本地费用账本与人民币预算、Provider 余额分别记录，没有做隐含汇率换算。

价格与余额协议来源：[DeepSeek 官方模型价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[账户余额 API](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)。原始证据在 `test-results/owner-live-20261017/` 与 `test-results/owner-live-followup-20261017/`；不在文档中公开 API Key、账号余额总额或密文。

### 独立代码验证

冻结合成 Git 仓库基线 `eece75c`：`quotation.ts` 对负数量返回负报价；固定测试原先 1 fail / 3 pass。实际模型在系统创建的独立 worktree 中写入 quantity<0 的 RangeError 检查。代理结束后，独立执行原有 `bun test quotation.test.ts` 为 4 pass / 0 fail，涵盖负、正常、零、小数数量；只有 quotation.ts 改动，测试文件未改，源仓库仍干净且保留原实现。

这证明真实模型写入和独立测试；不证明 Owner 内部完成了验证命令、Reviewer 或成果应用。当前工具契约仍未开放普通源码读取与 Shell 验证；工程适配和产品验收不能用本次人工运行的测试替代。输入、before/after 输出与准备记录在 `test-results/owner-code-20261017/`。

[定位简报及保留意见](owner-positioning-live-20261017.md) 可直接审阅。

## 仍不能关闭的门禁

- 真实反馈重规划有效新版本，以及修复工具目录后的真实代码执行/Reviewer 复验。此前 12 次授权已用完；没有用本地模拟响应代替真实通过。
- 普通源码读取、研发验证命令及 Reviewer 对准确执行者产物的适配，当前 Owner 用途白名单尚不支持，不能在测试中绕过门禁或冒称已支持。
- AO-A02 用户个人产品验收仍待验收；业务成果签收未代用户完成。
- Provider 逐请求独立账单仍缺，账户余额和本地 usage 估算不等于该证据。

最终回归、固定包哈希、提交及本轮补充证据见 Ledger 后续收尾条目；本记录不把以上门禁标为完成。


## 最终工程与固定包核对

- 完整隔离回归：664个测试文件，失败0；全workspace typecheck、完整Electron build、17个变更TS/TSX文件Biome与diff检查通过。docs摘要首次过期，重新生成后检查通过。
- Electron 0.13.23 / Electron runtime 39.8.10；arm64目录包与正式package-smoke通过。`app.asar` SHA-256=`01802b319865903814baf7f90c6f7617305745cd284578e9eafcc5cac140f06c`。本地未签名测试包，未安装替换或推送。
- 最终包原生点击保留代码项目的命令直达按钮，显示准确报价执行者会话和quotation.ts写入历史；单步骤移除按钮禁用；Renderer异常为空。此次仅只读打开，无新模型请求、新审批或执行。多步骤移除仅有确定性BDD覆盖，未冒称原生完整检查。
- 独立code_simplifier只读复核最后工具目录、重试和会话映射改动，未发现明显权限扩大、普通Agent回归或会话串线。
- 最终日志在`test-results/owner-completion-20261017/`（`*-closed.log`及`final-window/`）。追加4次请求授权仍等待答复，不能用余额尚有余量替代次数授权。
