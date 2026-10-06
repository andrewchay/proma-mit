# Claude/Gravitas Runtime 软下线（2026-09-29）

- [x] 确认范围：仅禁止新增/切入 `claude`、`proma`；存量会话和后台任务继续运行；不删 adapter、SDK、历史数据。
- [x] 搜索入口与持久化兜底，确定兼容边界。
- [x] 实施用户新建/切换、默认设置、员工与新定时任务/Monitor 的限制；存量编辑保持原 runtime。新建旧 runtime Schedule/Monitor 不支持绑定既有旧会话（不新增旧 runtime 执行安排）。
- [x] 增加回归测试并运行 typecheck/定向测试；未覆盖现有 Codex/Pilot 未提交改动。定向 26 PASS（员工+Monitor+shared）、会话/调度 29 PASS、全包 typecheck PASS、diff-check PASS。
- [x] 汇报实际交付和未覆盖的后台/Workflow 风险（2026-09-29）。
