# AO-07 异常验收证据对账（2026-10-13）

## 范围与方法

对照 AO-07 台账、`validation-checkpoint-20261012.md`、当前分支的 Stage B 与严格技术评审测试，按具体断言映射授权/次数、费用、评审证据、返工、恢复与依赖场景。只运行隔离测试；本轮没有 Provider 请求，没有修改业务运行实现、用户数据或 unknown 账本。

## 场景映射

| 场景 | 结论 | 当前证据 | 限制 |
|---|---|---|---|
| 执行/Reviewer串行、冻结岗位身份、普通入口隔离 | 已覆盖 | `project-owner-execution-stage-b.test.ts`：冻结岗位员工；Scheduler fake 执行与评审；普通 start/registry 越权拒绝 | fake/loopback，不证明真实 Provider 或生产出口 |
| 运行次数、预算与岗位cap耗尽；超额结算 | 已覆盖 | Stage B：运行次数耗尽、独立费用耗尽、预留耗尽、超预留转 `needs_reconcile`、Reviewer同岗位 cap、unknown岗位占额 | fixture 结算不是真实账单；不能证明 Provider 侧硬封顶 |
| 无效/缺失评审回执、`blocked`、重复调度不重试 | 已覆盖 | Stage B：非法输出停等、合法 blocked 保留卡点、Reviewer无结构化回执不从 summary 补造且重复唤醒不重跑 | 只证明应用状态机处理，不证明评审文本质量 |
| 评审证据身份与幂等 | 已覆盖 | Stage B：重复同回执幂等、不同回执拒绝覆盖、跨项目 execution 与 Executor command 混配拒绝 | 本轮发现并补了“Reviewer命令轮次与Executor不一致”显式反例，见下方验证结果 |
| 外层事务回滚、数据库重开 | 已覆盖（隔离存储层） | 回滚后 Scheduler 不消费未提交证据；相同回执可重录；关闭重开读取已知结算和不可变评审证据，Task仍暂停 | 不是完整 Electron 进程崩溃/重启、断电或多进程争用验证 |
| 依赖 + 前置返工 + 复审 + 下游幂等续派 | 已覆盖（fake BDD + Native成功路径） | Stage B组合测试；Native run `91a5371c-df29-436e-9303-fb8cbeef60a8` | Native Runner/transport/dialog 为fake；Task完成条件由harness显式注入，不是业务验收 |
| 来源漂移、返工 Executor `unknown`、Reviewer停止未证实 | 已覆盖（fake BDD） | Stage B返工链三项专项测试，确保停为stale/needs_reconcile、不排后续角色、不重试 | 没有真实远端停止证明 |
| 返工轮次错配 | 已补确定性反例 | Stage B测试故意把Reviewer command的`rework_ordinal`改为与唯一Executor不同，证据写入被拒且列表为空 | 只证明隔离数据库服务拒绝，不代表其它来源/项目漂移故障的全部组合已穷尽 |
| 进程重启后旧Runtime晚到回调 | 已补fake-only进程边界组合测试 | 独立Bun测试子进程第一次恢复将running执行持久化为stale/unknown，第二次扫描返回空；父进程重开SQLite后将同一fake headless完成回调触发两次，状态/占额不变、无技术评审、无新命令 | 是两个Bun测试进程共享隔离SQLite的恢复/回调幂等契约证明，不是Electron完整应用崩溃/GUI重启、断电、真实Runtime、native WAL或多进程并发保证 |

## 本轮验证

- 修改：只扩展`project-owner-execution-stage-b.test.ts`的旧Runtime回调滞留/独立进程恢复BDD，加入第二次恢复扫描无操作及同一晚到完成回调重复触发两次的断言，没有改产品运行代码。
- `bun test apps/electron/src/main/lib/project-owner-execution-stage-b.test.ts`：**50通过、0失败、281断言**。
- `bun test apps/electron/src/main/lib/project-owner-technical-review.test.ts`：**4通过、0失败、8断言**。
- `bun run typecheck`：全workspace通过；`bunx biome check apps/electron/src/main/lib/project-owner-execution-stage-b.test.ts`、`bun run docs:check`、`git diff --check`：通过。
- 子进程首次尝试用普通`bun -e`加载Electron依赖时，因没有Bun测试运行器中的Electron mock而失败；已将子进程改为临时隔离Bun测试文件并注册项目完整Electron mock，再运行同一应用恢复服务，最终父子两侧断言通过。该初始失败是测试启动方式问题，不是产品缺陷，未隐去。
- 测试使用临时`PROMA_TEST_CONFIG_DIR`和fake headless runner；没有真实Provider请求、读取凭据或变更旧unknown账本。完整Stage B另有既有本机fake loopback用例，均不等于真实Provider。

## 仍未验证 / 不在本轮范围

1. Electron GUI完整进程被杀/启动后的窗口、服务和native SQLite WAL恢复；断电、多进程争用或真实Runtime停止后的回调行为。
2. Native组合故障矩阵（现有Native证据为成功路径，不是所有异常注入）。
3. 真实Provider的usage、账单、request ID、收费及远端stop；失败规划Run的unknown状态原样保留，不重试、不释放占额。
4. 代表性真实业务质量、新交付版本与旧验收隔离归AO-09/10，不能由AO-07 fake技术评审替代。
5. AO-07完整产品闭环与AO-G0～G3验收仍未通过；本次局部对账或测试通过不改变整体状态。
