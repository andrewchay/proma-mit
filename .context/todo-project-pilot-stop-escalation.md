# Project Pilot 停止未核验升级对账切片（2026-09-27，台账 -37）

基线 HEAD `372c481d`（已推送）。目标：Pilot 执行停止请求被接受但进程终止未核验时，
保留预算（暂停授权）并留下升级人工对账记录；终态到达时回执消解。不调用 Provider。

- [x] schema：`pilot_stop_escalations`（每执行唯一，open→resolved 生命周期；两处迁移点 + 项目删除清理）
- [x] 新模块 `project-pilot-stop-escalation.ts`：record（校验 Pilot 运行中/幂等/暂停授权）+ resolve + getOpen + listOpen
- [x] 接线：cancelAgentExecution 未核验分支记录升级；已核验停止与 handleExecutionComplete 终态消解
- [x] 恢复集成：stale 时升级保持 open，原因带"停止升级待人工对账"标记
- [x] 测试 6 PASS：升级/幂等/非 Pilot 与已终结拒绝/消解与重复消解/故障注入恢复保持 open
- [x] 门禁：全仓 501 文件 0 失败、typecheck、Biome PASS；台账 -37；版本 0.12.94
