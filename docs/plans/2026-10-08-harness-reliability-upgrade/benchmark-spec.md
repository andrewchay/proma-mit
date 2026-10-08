# Harness Reliability 独立评测规范

> 首批版本：2026-10-08，基线6c71b384。
> V01 DTO测试已落地；以下整体机制case为后续实施规格，不是假造已跑benchmark。真实Provider调用未授权。
> 不运行旧TCC benchmark，不沿用其私有成绩作为本升级PASS。

## 1. 分层与来源

1. **契约单测**：纯内存对象、确定性时钟；无HOME/config/网络写入。证明DTO边界，不证明来源可信。
2. **服务fixture**：临时配置/Git目录，复用生产服务；所有workspace/session/config在导入前隔离；finally清理。
3. **Runtime离线接线**：明确假的模型流，真实工具/权限/服务边界，验证零越权和无重放。
4. **真实Provider paired试点**：另外授权后固定build/runtime/model/tasks，baseline与upgrade同样条件。
5. **隔离包和恢复试验**：实际固定构建，原生驱动/ABI/进程强杀单独记录；sql.js测试不能替代。

评判者与被测输入分离；工具stdout/model completion不担任机械验收者。禁止把fixture/noop/mock成功记录为真实Provider或外部成功。

## 2. 固定case目录（后续服务/Runtime矩阵）

| ID | 输入/场景 | 硬断言 | 实施覆盖 |
|---|---|---|---|
| HR01 | 最新快照+真实验证+逐条件覆盖 | 主进程核验后才允许technical verified，business accepted不变 | V02/V03 |
| HR02 | 测试通过后再修改、新增或恢复已删除文件 | old receipt stale，完成被拒；包含dirty/untracked | V02/V03 |
| HR03 | 同名task但不同project/session/run/goal/execution | 不串证据；模型伪造来源不被信任 | V01结构；V02真实性 |
| HR04 | PASS stdout、exit1、零测试、unknown退出 | false-positive完成为0；未知不计成功 | V01结构；V02真实采集 |
| HR05 | 简单4工具与大目录选择 | required工具可达，未选schema不进入prompt；收集schema与total tokens | D01–D04 |
| HR06 | CJK描述、同名MCP工具、目录更新/断连 | 稳定server/tool身份，旧schema不可调用；权限不降级 | D01–D04 |
| HR07 | 并发写同文件/realpath别名/父子目录 | 声明锁域内序列化；跨域unsupported显式展示 | E01/E02/E05 |
| HR08 | 两个独立只读调用 | 支持的路径实际重叠运行，结果ID完整；不以墙钟噪声独断性能 | E02/E05 |
| HR09 | 输出截断/不完整参数/流式提前tool-call | 未开始mutation零执行；已开始效果如实记录；不支持拒绝 | E03 |
| HR10 | queued取消/running错误/重启 | 无新派发，锁清理；unknown外部mutation不重放 | E04/V04 |
| HR11 | Plan/撤权/预算/缺能力 | Provider准入之前拒绝不支持的required保证，special交互不重复 | P01–P04 |
| HR12 | 三次以上压缩且原文archive缺失 | 目标/禁止项/未完任务保留，协议完整；缺源不假装可恢复 | C01/C02 |
| HR13 | 未批准candidate、旧patch、重复Approval | 不覆盖Memory/Skill；原审批身份核验；rollback可查 | C03/C04 |
| HR14 | 所有新flags off及legacy数据 | 不启TCC，不恢复retired runtime，不把legacy标verified | H03/R04 |

首批parser测试覆盖HR03/HR04的结构子集；HR01/HR02及各生产接线均未完成。

## 3. 比较策略与门槛

- 安全case的适用硬断言100%通过，任何越权、跨身份、伪造完成、敏感泄漏或截断mutation执行阻断。
- 非确定性工具选择需paired对照；每个模型初拟至少30对，不冒充统计充分。
- 任务success及required-tool recall不得低于baseline；零收集/错身份证据拒绝率100%。
- 大目录schema token平均下降目标≥20%；总input/output/cache/费用及p95时延一并展示。
- 总token或p95恶化>10%时不得默认开启，除非用户明确接受质量收益；安全硬门槛不可豁免。
- 失败、超时、重试、发现失败、中止全部计入；skip/unsupported/unknown不能填0费用或PASS。
- 实际input计量按Provider协议区分cache read/create，记录能力unknown；总input的语义写清，不能只累加uncached tokens冒充完整context。

## 4. 结果记录

每个case/run记录：benchmarkVersion、caseId、runId、commit/build、dirty diff摘要、Runtime/SDK/provider/model版本、flag/policy/catalog修订、配置scope、fixture/真实、expected/actual、结果pass/fail/skip/unsupported、原始证据私有引用、统计/实际费用及来源。

- 复用eval/trace-writer作私有评测诊断可以，但其中SDKMessage/systemPrompt包含正文，**不能当作无正文生产审计**。
- context-metrics为TCC相关观测模块；复用纯计算/数据结构不等于启用TCC，也不能为获取指标打开旧flag。
- parser没有I/O，不需要PROMA_TEST_CONFIG_DIR；后续有config模块的服务测试必须隔离。
- 不安装新依赖，不更新真实渠道/模型配置，未获授权不跑真实矩阵。

## 5. 首批red/green证据

- red：创建verification.test.ts后运行，缺失verification.ts导致模块导入失败；0 pass/1 fail/1 error。
- green：首轮25 tests / 66 assertions通过；简化/边界审查新增原型伪JSON测试后先红（25 pass/1 fail），修复普通对象检查后最终26 tests / 69 assertions通过，0 fail。
- 首次shared typecheck发现fixture字面量类型被拓宽；添加明确类型返回后通过。此为实现过程修复，不隐去失败。
- 最终全仓`bun run test`：541文件，3572 pass / 0 fail / 27 skip；skip不作为真实Provider通过。九包typecheck、全仓lint、docs:check、diff检查通过。私有日志引用见ledger。
- 这些结果不证明产物新鲜度、完成门禁、sandbox、真实Provider或业务签收；旧服务回归也不能替代新V02/V03端到端验收。
