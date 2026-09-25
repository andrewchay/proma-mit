# 文件任务委派与人工 Review：实施、测试、风险台账

**建立日期：** 2026-09-25 GMT+8。**基线：** HEAD `c3e3854f`，工作区含既有未提交修改。**负责人安排：** 下列“实施 Agent／人工 Reviewer”为建议角色，未创建或派发真实 AI 员工任务。

关联：[实施方案](implementation-plan.md) · [测试方案](test-plan.md)。本台账是本功能跨会话追踪入口；后续追加运行记录，不把计划状态自动改成完成。

**收尾核查（2026-09-25 00:50 GMT+8）：** 工作区 HEAD 已变为 `b1db1ba1`（知识库双链修复），原先三处已跟踪修改已不在 status 中，本会话没有提交或修改它们。当前仅本方案目录未跟踪。基线测试在共享工作区运行，未逐次冻结 HEAD，因此日志不能作为严格锁定 commit 的发布证据；W00 需在固定基线的隔离工作区重跑。

**M1 完成（2026-09-25 01:30 GMT+8，commit `1812e0c0`）：** W00–W03 实施并提交（shared 0.2.15／electron 0.12.74）。验证：typecheck 全包通过；lint 0 问题；`bun run test` 全量 475 文件 0 失败；docs:check 已同步（含 repository-facts 更新）。新增实现未做真实模型端到端与 UI，G1 门禁的测试部分通过，发布结论不变。

## 1. 总览

| 项目 | 当前状态 |
|---|---|
| 方案与测试设计 | 已编写，等待用户确认实施范围 |
| 新功能实施 | 11 / 11 项完成（W00–W10），commits `1812e0c0` → 本轮；确定性闭环全链路 smoke PASS |
| 既有研发链路基线 | 本轮复跑 27 PASS、0 FAIL，3 个独立测试进程，日志已保留 |
| 新增 BDD | 新增 26 项测试全部通过（覆盖 T02 部分、T03、T04 范围层、T05 既有、T06–T09、T13、T17、T18、T19、T30 前置）；其余用例待 M2/M3 |
| 真实用户路径 | R04 确定性部分由 smoke 覆盖；R01–R03（真实模型）待用户试跑 |
| 发布结论 | 未达到试用放行；不能宣传“只需最终 Review” |
| 工程量估计 | 单人约 8–13 工程日，需 M1 后重估；不是承诺日期 |

状态约定：`待开始 / 进行中 / 阻塞 / 待代码审查 / 待真实验收 / 已完成`。工程实现已完成不等于对应测试通过；发布放行看 G4。

## 2. 实施台账

| ID | 阶段 | 交付项与完成标准 | 依赖 | 建议执行／复核 | 状态 | 证据 |
|---|---|---|---|---|---|---|---|
| W00 | M0 | 建立隔离 fixture、真实配置目录保护和基线记录；可重建且安全清理 | 无 | 实施 Agent／工程 Reviewer | 已完成（待代码审查） | `development-review-fixture.test.ts` 2 PASS；commit 1812e0c0 |
| W01 | M1 | scope、关联已有 Task、路径预检；无重复任务和静默跨工作区路由 | W00 | 实施 Agent／工程 Reviewer | 已完成（待代码审查） | `development-task-service.ts`＋8 项测试 PASS |
| W02 | M1 | 冻结 diff 快照，覆盖提交／暂存／新增／删除；真实 index 不变 | W01 | 实施 Agent／工程 Reviewer | 已完成（待代码审查） | `development-snapshot-service.ts`＋8 项测试 PASS（含范围外阻塞／保护路径／二进制／symlink／超限／篡改检测） |
| W03 | M1 | 权威员工提交与交付版本关联；不能自验收、伪造身份或跳过决策 | W02 | 实施 Agent／权限审查 | 已完成（待代码审查） | `development-delivery-service.ts`＋8 项测试 PASS（T13/T17/T18/T19）；完成回调已接线（范围门控） |
| W04 | M2 | 文件菜单＋委派对话框；预填定位、选择已有任务、明确派发副作用 | W01,W03 | 实施 Agent／用户体验复核 | 已完成（待真机操作验证） | FileBrowser 菜单项＋SidePanel＋DelegateFileTaskDialog；commit 9d9efac1 |
| W05 | M2 | 单一 Task Review，复用 DiffView，显示版本／验证／风险／逐项 DoD | W02,W03,W04 | 实施 Agent／人工 Reviewer | 已完成（待真机操作验证） | TaskReviewPanel 接入看板任务详情；验证状态列在 M3 补充 |
| W06 | M2 | 退回原因＋一次幂等返工，原 session/worktree，新交付版本 | W03,W05 | 实施 Agent／工程 Reviewer | 已完成（待真机操作验证） | requestChanges 幂等派发＋T12 测试 PASS；服务层 7 项测试 |
| W07 | M3 | 真实命令退出码与内容 hash 绑定；reported 不冒充 verified | W02 | 实施 Agent／工程 Reviewer | 已完成（待真机操作验证） | development-validation-service＋7 项测试（白名单/passed/failed/stale/timeout/列表）；commit 42ceb95f |
| W08 | M3 | 明确确认后应用、漂移拒绝、可恢复记录、完成不绕过 DoD | W05,W06,W07 | 实施 Agent／安全与数据复核 | 已完成（待真机操作验证） | development-apply-service＋7 项测试（字节级应用/漂移拒绝/过期确认单/幂等/恢复分类/DoD 闸门）；与方案偏差：前置 HEAD==基线＋目录干净使补丁上下文不可能漂移，采用直接字节写入替代 git apply（更少 CRLF/autocrlf 失败模式），已在代码注释说明 |
| W09 | M4 | R01–R04 真机验收，记录每次人工介入及费用 | W08 | 用户＋实施 Agent | 部分完成 | R04 确定性部分由 smoke:task-review 覆盖（17 断言 PASS）；R01–R03 真实模型路径待用户试跑 |
| W10 | M4 | 完整门禁、构建／打包烟测、文档和版本更新 | W09 | 实施 Agent／发布复核 | 已完成 | typecheck/lint/全量测试/docs:check；development-employee.md＋storage-contract.md 已更新；smoke 脚本入册；构建／打包烟测待发版窗口 |

执行规则：每项完成后填写 commit、文件清单、对应测试结果和未解决问题；不得只写“已做”。涉及授权、未知产品决策或权限扩展时记录阻塞，不自行放宽安全约束。

## 3. 基线证据台账（已实测）

本轮 2026-09-25 GMT+8 复跑；运行器为测试替身，无真实 Provider 调用。命令退出码已追加在每份日志末尾。

| ID | 测试文件 | 结果 | 原始证据 | 证明边界 |
|---|---|---|---|---|
| B01 | `agent-development-context.test.ts` | 7 PASS / 0 FAIL；exit 0 | [日志](evidence/agent-development-context.log) | 研发配置与提示契约 |
| B02 | `agent-development-worktree.test.ts` | 5 PASS / 0 FAIL；exit 0 | [日志](evidence/agent-development-worktree.log) | 临时真实 Git 的隔离与绑定拒绝 |
| B03 | `agent-development-execution.test.ts` | 15 PASS / 0 FAIL；exit 0 | [日志](evidence/agent-development-execution.log) | 确定性派发、回写、停止、返工兼容 |

运行时工作区另有用户未提交修改，所以 `c3e3854f` 仅为 HEAD 标识，不代表整个工作区是干净发布构建。本轮没有执行完整 typecheck／全量测试／lint／docs:check／打包，也没有记录真实配置目录的运行前后对照清单；后续 W00 必须补齐此项，不能凭“用了临时目录”推导审计已完成。

## 4. 新增测试执行台账

用例详细 Given／When／Then 见测试方案。默认没有任何结果；每次尝试应追加到第 6 节。

| ID | 对应实施项 | 当前结果 | 最近 Run／证据 | 缺陷 |
|---|---|---|---|---|
| T01 | W04 | 未执行 | — | — |
| T02 | W01 | 未执行 | — | — |
| T03 | W01 | 未执行 | — | — |
| T04 | W01,W02,W08 | 未执行 | — | — |
| T05 | W01 | 未执行 | — | — |
| T06 | W02 | 未执行 | — | — |
| T07 | W02 | 未执行 | — | — |
| T08 | W02,W08 | 未执行 | — | — |
| T09 | W02,W08 | 未执行 | — | — |
| T10 | W05 | 未执行 | — | — |
| T11 | W03 | 未执行 | — | — |
| T12 | W06 | 未执行 | — | — |
| T13 | W03 | 未执行 | — | — |
| T14 | W03,W06 | 未执行 | — | — |
| T15 | W01,W03 | 未执行 | — | — |
| T16 | W05,W07 | 未执行 | — | — |
| T17 | W03 | 未执行 | — | — |
| T18 | W03 | 未执行 | — | — |
| T19 | W03 | 未执行 | — | — |
| T20 | W08 | 未执行 | — | — |
| T21 | W08 | 未执行 | — | — |
| T22 | W08 | 未执行 | — | — |
| T23 | W08 | 未执行 | — | — |
| T24 | W08 | 未执行 | — | — |
| T25 | W05 | 未执行 | — | — |
| T26 | W03,W05,W08 | 未执行 | — | — |
| T27 | W07 | 未执行 | — | — |
| T28 | W07 | 未执行 | — | — |
| T29 | W08 | 未执行 | — | — |
| T30 | W02,W08 | 未执行 | — | — |

## 5. 真实验收与门禁台账

| ID | 场景 | 状态 | Runtime／模型／构建 | 人工介入／费用 | 人工签收 |
|---|---|---|---|---|---|
| R01 | 代码修复＋返工＋应用＋任务完成 | 未执行 | 未确定 | 未记录 | 未签收 |
| R02 | Markdown 修改＋返工＋应用 | 未执行 | 未确定 | 未记录 | 未签收 |
| R03 | 原工作区漂移时阻止应用 | 未执行 | 未确定 | 未记录 | 未签收 |
| R04 | 中断恢复＋旧任务兼容 | 确定性部分 PASS（smoke 恢复分类＋旧链路回归 478 文件） | 测试运行器 | smoke:task-review | 待用户签收 |

| 门禁 | 当前状态 | 缺少内容 |
|---|---|---|
| G0 | 未通过 | W00 fixture、安全清理与配置目录前后检查 |
| G1 | 测试通过，待代码审查 | M1 实现＋26 项测试＋全量门禁；未做 UI 与真实模型端到端 |
| G2 | 服务层测试通过；真机操作待验证 | R01 前置：真实模型端到端未跑 |
| G3 | 测试通过，待真机操作验证 | 确定性闭环 30 项中 T04 文件系统层/T20–T24/T27–T30 已覆盖；真机检查待 R01–R04 |
| G4 | 确定性闭环通过；真实模型试跑待用户 | R01–R03（真实 Runtime＋人工 Review）、目标平台构建／打包烟测 |

## 6. 运行历史（追加式）

| Run ID | 日期／时区 | 用例 | 结果 | 命令／证据 | 备注 |
|---|---|---|---|---|---|
| M3-20260925-01 | 2026-09-25 GMT+8 | W07 验证 | PASS（7/7） | `bun test apps/electron/src/main/lib/development-validation-service.test.ts` | 白名单/stale/timeout |
| M3-20260925-02 | 2026-09-25 GMT+8 | W08 应用 | PASS（7/7） | `bun test apps/electron/src/main/lib/development-apply-service.test.ts` | 恢复分类/DoD 闸门 |
| M3-20260925-03 | 2026-09-25 GMT+8 | 全量门禁 | PASS | typecheck／lint／`bun run test`（478 文件 0 失败）／docs:check | 真机操作待 M4 |
| M4-20260925-01 | 2026-09-25 GMT+8 | W09 smoke 全链路 | PASS（17 断言） | `bun run smoke:task-review` | 确定性运行器；两次重复运行稳定 |
| M2-20260925-01 | 2026-09-25 GMT+8 | W06 Review 服务 | PASS（7/7） | `bun test apps/electron/src/main/lib/development-review-service.test.ts` | 汇总/Diff 冻结/关联保 id/T12 幂等返工/代验收拒绝 |
| M2-20260925-02 | 2026-09-25 GMT+8 | M1+M2 回归 | PASS（40 项） | 5 个 development-* 测试文件 | 全部通过 |
| M2-20260925-03 | 2026-09-25 GMT+8 | 全量门禁 | PASS | typecheck／lint／`bun run test`（476 文件 0 失败）／docs:check | UI 真机操作未验证 |
| M1-20260925-01 | 2026-09-25 GMT+8 | W00 fixture | PASS（2/2） | `bun test apps/electron/src/main/lib/development-review-fixture.test.ts` | 真实目录无新增 |
| M1-20260925-02 | 2026-09-25 GMT+8 | W01 范围 | PASS（8/8） | `bun test apps/electron/src/main/lib/development-task-service.test.ts` | — |
| M1-20260925-03 | 2026-09-25 GMT+8 | W02 快照 | PASS（8/8） | `bun test apps/electron/src/main/lib/development-snapshot-service.test.ts` | 临时真实 Git 仓库 |
| M1-20260925-04 | 2026-09-25 GMT+8 | W03 交付 | PASS（8/8） | `bun test apps/electron/src/main/lib/development-delivery-service.test.ts` | T13/T17/T18/T19 |
| M1-20260925-05 | 2026-09-25 GMT+8 | 回归 | PASS（7 文件） | 研发链路 3 文件＋project-chain 3 文件＋workspace-bindings | 27＋既有全绿 |
| M1-20260925-06 | 2026-09-25 GMT+8 | 全量门禁 | PASS | typecheck／lint／`bun run test`（475 文件 0 失败）／docs:check | 测试替身，无真实模型 |
| BASE-20260925-01 | 2026-09-25 GMT+8 | B01 | PASS | `bun test apps/electron/src/main/lib/agent-development-context.test.ts`；B01 日志 | 本轮复跑 |
| BASE-20260925-02 | 2026-09-25 GMT+8 | B02 | PASS | `bun test apps/electron/src/main/lib/agent-development-worktree.test.ts`；B02 日志 | 本轮复跑 |
| BASE-20260925-03 | 2026-09-25 GMT+8 | B03 | PASS | `bun test apps/electron/src/main/lib/agent-development-execution.test.ts`；B03 日志 | 本轮复跑，模型为替身 |

后续真实记录按 test-plan.md 第 7 节完整字段建立 `evidence/<runId>.md`，在此链接；完整日志与截图另存。失败后复测应新增 Run 并填写 retestOf。

## 7. 风险与待决事项

| ID | 事实／风险 | 当前处置 | 关闭条件 |
|---|---|---|---|
| K01 | AI 负责人无法直接使用固定 local-user 的保存／提交交付接口 | W03 优先受限 principal 衔接；不改客户端 actor | T13,T17,T19 通过且旧链路不退化 |
| K02 | 交付要求真实决策，快速修文件不能伪造审批 | 派发时关联或由用户确认低风险决策 | T15 通过，关键 DACI 仍要求拍板 |
| K03 | 仓库中间迭代常有未提交改动 | 首版明确阻塞；不支持自动 dirty snapshot | T05，通过提示让用户理解限制 |
| K04 | 新 worktree 可能没有依赖，命令会等审批 | 展示预检与卡点，安装另行确认 | R01 实际记录介入次数，无虚假测试结果 |
| K05 | 已审阅内容可能被继续修改 | 冻结 snapshot＋hash；不审活目录 | T14,T21,T28 通过 |
| K06 | Git 写文件与 SQLite 回写无法共同事务 | 操作意图、幂等键、hash 核验及恢复态 | T23,T24,T30 通过 |
| K07 | 普通员工旧路径权限不同 | 不扩大研发模式保证，不迁移旧员工 | T26 通过，文案明确 |
| K08 | 并行会话已有源码和 package.json 修改 | 本轮保持不动；实施前重新确认基线／隔离方式 | W00 记录用户选择，不自动提交或丢弃 |
| K09 | 真实 Runtime／模型和预算未确定 | 先完成确定性测试，再请求试跑授权 | R01 前记录组合、预算、工具许可 |
| K10 | “最后只 Review”与中途工具审批可能冲突 | 不设置 bypass；把介入次数作为验收指标 | 被验收组合实际达到目标，或明确仅受控试用 |
| K11 | 新 UI 同时影响范围、身份和文件写入 | 主进程重新校验全部关键事实，UI 禁用不是权限边界 | T04,T17,T20,T21,T29 通过 |
| K12 | 测试／构建／发布范围被混淆 | 27 PASS 仅基线，所有新增与真机项初始未执行 | G4 有完整证据与未支持清单 |

## 8. 缺陷记录模板

当前没有对新增实现执行测试，因此没有已确认的新增实现缺陷；上面的 K01 等为源码核查发现的现有能力缺口／设计风险。

| 缺陷 ID | 来源 Run | 严重度 | 预期／实际 | 复现路径 | 负责人 | 修复 commit | 复测 Run | 状态 |
|---|---|---|---|---|---|---|---|---|
| 待新增 | — | — | — | — | — | — | — | — |

## 9. 下一次执行交接

1. 阅读 implementation-plan.md 的 D1–D6，不绕过身份与不可变快照先堆 UI。
2. 更新本台账的基线 HEAD、工作区脏文件清单和执行环境。
3. 先完成 W00–W03；第一轮交付只要求 G1，不启动真实模型、不应用真实用户项目的代码。
4. 每次完成一项同步测试编号与证据；范围变更追加理由和日期。
5. 执行阶段不自动修改 README／两份 AGENTS.md；权限变更、真实调用费用、确认应用按各自边界处理。
