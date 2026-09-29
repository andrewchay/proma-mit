# 2026-09-29 Pilot P0 收束诊断

## 状态与范围
G0 已审定；先前特批 G2 的 ai-sdk/bigmodel 两次受控 run 已结算，不代表 G1 通过。Pi Pilot readiness 保持关闭。本轮不调用 Provider，不更改 CLAUDE.md/README.md，不触碰 Codex/Pi/渠道并行修改。

## 本轮完成的有限接线
暂停确认 IPC 原先只调用 `confirmPilotGrantPause`，提交撤权/取消队列后仅返回 `pendingStopExecutionIds`，不会实际发出停止请求。现改为调用 `confirmPilotGrantPauseAndRequestStops`，逐条委托现有 `cancelAgentExecution`（其 Pilot 路径在发外部停止请求前调用 `requestPilotStopWithIntent`）；逐项结果写 `project_activities`，UI 分列接受/未确认/终止未核验，审计失败不会谎称请求未送达。未核验终止与费用保持人工对账。

## 审查发现的 P0 阻断（未修）
**撤权事务提交与逐项 `cancelAgentExecution` 之间有崩溃窗口**：持久暂停决策含目标，但尚未逐项持久 stop intent；进程此时退出则没有请求/结果，重启只读 `inspectPilotGrantPauseRecovery` 报 `needs_attention`，不自动重发。这是保守停等，不是可信终止闭环。下一切片宜把每条请求的 durable pending 与授权撤权同事务保存，恢复时按 session/generation 归属检查并设计幂等重试或明示人工对账，不能假称 crash-safe。另一风险：`project_activities` 写入失败时请求可能已发，返回带 `auditRecorded:false` 且暂停决策仍留存；进程崩溃后无法恢复即时结果，仍须人工核验。子代理审查提出以上两点。

## 2026-09-29 继续：撤权后的停止清单
`confirmPilotGrantPause` 现与 grant 撤权、排队取消同 SQLite 事务写入 `pilot_grant_stop_requests` 每项目标（grant/execution/project/command/session、pending）；逐项停止器结果和活动审计同事务记录为 accepted_unverified / unverified / stopper_reported，绝不把 stopper_reported 当可持久核验退出。审计事务失败仍保留 pending，调用方得到 auditRecorded:false；这个 pending 可能表示未发送或已发送，**不得自动重放**。旧库无新表时补建而不伪造请求状态；旧暂停决策仍由只读清单显示 legacy_unknown。控制面即使无活动授权也展示人工对账清单；重开与旧库补建测试通过。生产 WAL/SIGKILL 和真 Runtime 终止证据仍未验收，G1 未通过。

## 2026-09-29 原生 WAL 局部强杀证据
新增独立 Node 子进程夹具（非 Bun）运行 `initProjectDb` 的 NativeSqliteCompat / better-sqlite3 WAL 分支，临时 `PROMA_TEST_CONFIG_DIR`；在 `confirmPilotGrantPause` 外层事务 callback 完成但提交前、函数提交后各发 READY 并由父进程 SIGKILL，新进程重开验证：提交前 grant active / 无 decision / execution running / 无 request；提交后 grant paused / decision 恰一条 / execution running / request pending。子进程断言 NativeSqliteCompat，重开断言 `journal_mode=wal`。该证据只覆盖暂停事务的进程强杀，不包含停止请求送达窗口、Electron ABI 固定构建、断电持久性（生产 `synchronous=NORMAL`）、派发/审批/WAL 矩阵和 Runtime 外部副作用。`stopAgent→orchestrator.stop` 的实现始终回报 `processTermination: NOT_VERIFIED`，adapter abort 只说明目标代际请求被同步接受，不能提供退出凭据。G1 未通过。

## 管理者入口缺口
项目创建仅保存 title/description；Pilot 控制面展示已有任务与授权；现有 `planReadyDispatch` 是从结构化任务出发的候选派发，不是自然语言目标→澄清→任务/依赖/DoD/角色的计划生成。下一切片建议“只生成草案—澄清—用户批准结构化计划—事务性建任务—复核授权后派发”，避免模型输出直接触发创建/付费。主动通知与固定构建 UI 仍未验收。

## 本轮验证
定向暂停/停止升级/G1 固定夹具 37 PASS；九包 typecheck、Biome 六文件、diff-check 通过。另单跑研发执行套件 43 PASS/1 FAIL，失败因并行未提交的 Runtime retirement 改动使旧测试更新为已退休 `proma` 被拒，非本次接线；不得称全量绿。测试中的停止器仍是假对象，IPC 真机路径与 better-sqlite3/WAL 强杀窗口未验收，G1 继续不通过。
