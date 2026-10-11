# G3 真实验收证据

> 2026-10-11 13:40 GMT+8。基线 3e8a3b83。

## GLM 端到端工具/验证链（gated 场景，真实 Provider）

`g3-results/g3-report.json`（2026-10-11 首跑）：

```json
{"model":"glm-5.3-flash","durationMs":31668,"fixed":true,"goalStatus":"completed",
 "receipt":{"verdict":"passed","boundGoalId":"4eff978e-…","reportSha256":"69488641…","tests":1},
 "usage":{"input":30400,"output":258},"estimatedCny":0.025}
```

链：fixture 仓库 math.ts 有 bug → GLM 经 ai-sdk runtime 真实修复（独立核验 math.ts 含 a+b）→ 测试进程提交 → Goal complete 触发完成门禁 → seatbelt 沙箱对提交 HEAD 跑真实 `bun test`（JUnit 可信收集，tests=1）→ 回执 passed、boundGoalId 绑定 Goal 实体 id、reportSha256 存在。

legacy 场景：无门禁 Goal complete 完成且不触发验证（行为兼容）。

## 修正记录

首跑唯一失败为测试断言误用 sessionId 比对 boundGoalId（实际绑定 Goal UUID，行为正确）；已修断言为动态比对 goal.id。

## 口径

G3 通过为**筛查级**：单模型（glm-5.3-flash）/单 runtime（ai-sdk）/单场景。多模型、大样本与"验证失败→修复→重提"循环不在本批；费用为本地标准价估计（¥0.025），非账单。

## G3 组成回顾

- 工具/验证链：本批（新）+ R03（deepseek pilot）+ HR07/HR09（锁与取消真实证据）；
- 新 benchmark：D04 工具选择筛查 v2 非劣通过；
- 组合即 G3 筛查级通过；完整验收（多模型/大样本）需另行授权。
