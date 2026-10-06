# TCC M3 初次真实评测决定

**日期：** 2026-09-22  
**模型：** GLM-5.3-Flash  
**矩阵：** 10 fixed cases × full context / brief / TCC projection × 3 次，共 90 次。

## 结果

| Variant | 成功 | Input tokens | 总时长 | 已验证 claims |
|---|---:|---:|---:|---:|
| Full context | 30 / 30 | 4,914 | 318.6s | 30 / 30 |
| Brief | 28 / 30 | 3,416 | 641.1s | 0 / 0 |
| TCC projection | 29 / 30 | 4,210 | 347.6s | 29 / 29 |

TCC 相对 full context 的 input token 减少为 14.3%，低于 20% 门槛；总时长也未改善。质量侧满足 success ≥ baseline 95%、evidence coverage ≥90% 和 required item 未遗漏。

## 决定

**不推广。** TCC 保持 default-off，不启动自动 relevance scorer、自动 compaction adoption 或自动模型路由。

本次 runner 使用 synthetic prompt，未经过生产 `runProviderAgnosticSubAgent()` 的完整 parent→spawn 边界；它可证明 typed protocol 和基础投影质量，但不能作为真实长会话的最终收益证据。后续仅可通过代表性长上下文、真实 spawn adapter 的冻结评测重新申请推广。

## 证据边界

原始逐次运行记录保存在会话工作台私有文件 `tcc-m3-glm-scoreboard.json`，不进入父 Agent 上下文或仓库版本控制。
