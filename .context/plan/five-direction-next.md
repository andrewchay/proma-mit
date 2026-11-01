# 五方向剩余工作与推进顺序（2026-11-01）

基线：分支 `codex/p1-five-direction-slice`（`0e3bbbf7`、`77482060`、`3c94240c`、`88f7a1c0`），
上游 `main 96bd10fe`。本文只列**还没做**的部分，按「能否现在动手」分三档。

## 一档：现在就能做，不需要决策或特殊环境

| # | 方向 | 事项 | 现状缺口 | 验收标准 |
|---|---|---|---|---|
| 1 | 受控自主 | Claude SDK 路径接入绑定身份 | `agent-orchestrator.ts` 从不绑定会话对象，`canUseTool`（:798）只按 sessionId 复核 `assertNoOwnerBusinessSession` / `assertOwnerCommandRuntimeContext`；这是 Proma/AI SDK 之外最后一处「只按字符串授权」的入口 | `RuntimeSessionIdentity` 增 `claude-sdk` 类型；orchestrator 在 query 前绑定、结束后撤销；`canUseTool` 进入前比对绑定，不一致直接拒绝且不进审批；补单测 + 现有 orchestrator 测试零失败 |
| 2 | RSI | 统计显著性 | 现在只有均值差、`scoreStd` 与阈值判定；单次 run 抖动会被当成提升 | `compareShadowRuns` 增加按 run 数的置信区间/显著性判定（不显著时结论降为 `no_difference`）+ 样本不足时明确标注；单测覆盖 1/3/30 run |
| 3 | Enterprise | 判定接进读路径与成员接口（设计文档 S1/S2） | `decideWorkspaceAccess` 无调用方 | 工作区读取入口与成员接口改用判定函数，开关保持关闭；所有者用例行为不变、成员用例拒绝原因码可审计 |
| 4 | Harness | 门禁语法覆盖缺口 | `eval "…"`、变量拼接、别名、`find -exec git …`、`python -c` 内调用 git 都不覆盖 | 每条新增拦截用例 + 明确写出「不覆盖清单」，不得引入新的误拒（用回归用例守护） |
| 5 | RSI | 用一条真实评测验证三来源冻结 | 三来源冻结只有单测，没有一条带 `caseMaterialHash`/`judgeHash`/`runConfigHash` 的真实记录证明「可比」结论真能产出 | 一次真实评测（含 judge）写入后，两条记录对比返回 `comparable: true` 且差值有解释 |

## 二档：需要环境或用户操作

| # | 方向 | 事项 | 阻塞点 |
|---|---|---|---|
| 6 | Harness | 让 Git 门禁改动真正生效 | 当前会话 Bash 工具跑的是改动前的 bundle，需 `bun run build:main` 并重启应用 |
| 7 | Harness | Bash 沙箱用例与三平台打包 smoke | 3 个沙箱用例在本机因嵌套 seatbelt 失败（`sandbox_apply` EPERM），需非沙箱宿主执行 |
| 8 | OpenDesign | 安装入口接线（IPC/UI 传会话目录） | 需先定目标会话口径：当前会话 / Owner 绑定执行会话 / 用户手选；三种语义不同 |
| 9 | OpenDesign | 安装走逐次审批（ownerActionApproval） | 与 #8 的目标一起定，审批对象依赖目标会话 |

## 三档：外部依赖

| # | 方向 | 事项 | 依赖 |
|---|---|---|---|
| 10 | 受控自主 | 脱组后代终止与重启后的恢复对账 | 真实 MCP / 子进程环境 |
| 11 | 受控自主 | 真实 Provider 下的撤权与身份验收 | Provider 费用授权 |
| 12 | RSI | 影子流量采集、Provider 账单核对、人工验收 | 费用授权 + 人工时间 |
| 13 | OpenDesign | 动态交互预览、真实 Provider 遵循验收、打包应用内手动安装 | 打包环境 + Provider |
| 14 | Enterprise | 真实 IdP/邀请流程/TLS、生产 S3、外部审计投递、客户环境验收 | 客户与基础设施 |
| 15 | Enterprise | 混合新旧实例滚动部署的发布版本检查 | 统一升级 + 部署编排 |
| 16 | Enterprise | 平台角色（operator/admin）与工作区判定的关系 | 需要权限口径决策：运维能否越过工作区判定 |

## 已核实、不再是缺口

- Headless Owner 执行的 `session_id = ''` 只是排队态：派发时以 `SET status='running', session_id = ?` 认领真实会话
  （`project-pilot-budget-ledger.ts:419`），不是活跃的绑定漏洞。
- Pi 与 Proma 的权限回调都已在等待前后复核绑定身份；OpenDesign 另存文件已能按 manifest 注入，不需要靠固定文件名发现。

## 建议顺序

先做 1（唯一还没堵的授权入口）→ 2（让 RSI 结论有统计意义）→ 3（Enterprise 从模型走到入口）→ 5（用真实数据验证冻结）
→ 4（门禁语法补强，注意别制造新误拒）。6/7 与用户约时间重启应用与非沙箱宿主跑测试。
