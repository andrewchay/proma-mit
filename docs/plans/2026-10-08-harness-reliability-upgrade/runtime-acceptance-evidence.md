# R01/R02/R04 第二十六批：离线基准、PR 门禁核验与回滚演练证据

> 2026-10-10 00:20 GMT+8。基线 6398e055。

## R01 held-out 离线基准矩阵

- `agent-runtime/harness-benchmark/runner.ts`：任务模型（safety 零容忍标记 × runtime 矩阵）+ 报告（generatedAt/total/passed/failed/safetyFailures/results）。
- 内置任务集：默认策略四 runtime 无缺口、required toolScheduling 拒绝 claude、预算闸 fail-closed 矩阵、unknown 工具全局串行（真实调度器执行）、压缩 Golden 集（含三连压缩）、敏感记忆候选拦截。
- **费用规则**：所有结果 `cost: 'unknown'`——离线执行无费用计量，禁止写 0。
- **不跑 TCC 实验**：任务集只复用既有纯函数与调度器，无 Provider 调用。
- 报告可 JSON 落盘用于基线追踪；安全断言任一失败即出现在 safetyFailures（测试覆盖异常→失败映射）。

## R02 完整 PR 门禁与隔离打包核验（实际执行）

- typecheck（九包）、`bun run test`（567 文件 3844 pass/0 fail/28 skip）、lint、docs:check 全绿。
- `bun run dist:fast`（含 rebuild:natives + 渲染/主进程/preload 构建）1m18s 成功，产物 `Gravitas-0.12.136-arm64.dmg`。
- `bun scripts/package-smoke.ts` 对真实安装包执行通过：`{"packageSmoke":"passed","newMedia":{"schemaVersion":3,"migrations":3,"skills":6,"audits":3},"version":"0.12.136","tools":26,"defaultSkills":3,"skillSetToggle":2}`——隔离临时配置启动、SQLite 迁移重开、默认 Skills 注入与分组停用均验证；Kimi 压缩烟测按约定未启用（需显式渠道变量），不记为通过项。
- 原生 helper 构建在 dist 流程内成功（失败会上抛，dist 即失败）。

## R04 回滚演练

- `harness-rollback.test.ts` 四例：
  - 调度器禁用 → baseline 全串行（锁仍持有，硬底线不降低）；恢复后调度器可用。
  - 删除策略文件 → 回滚默认策略；损坏文件 → invalid 且保留原件；回滚动作=删除，不做修复性覆写。
  - 旧数据可读：无 `compactionSource` 的旧 boundary 原样加载；消息文件不删不改。
  - 硬底线与开关无关：Pilot 预算闸在禁用/回滚状态下仍 fail-closed。
- 分阶段启用现状：新机制均为"默认可用、可回滚"（调度器开关进程内、策略文件缺失即默认）；扩容/新 runtime 启用仍需正式门禁决策（记录于此，无自动化通道）。

## 边界

- R01 是离线矩阵骨架；多任务/多 Runtime 的**真实 Provider 基线与失败样本库**未做（需独立批准的真实运行预算）。
- package-smoke 未覆盖真实 Kimi 压缩链路（受控变量未设置）；CI 托管 runner 的完整隔离打包未在本批执行。
- 回滚演练覆盖本批新增机制；历史 flags（如 feature 级开关）不在本次范围。
