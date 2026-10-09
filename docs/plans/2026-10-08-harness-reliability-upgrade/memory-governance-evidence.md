# C03/C04 第二十五批：记忆治理链与 Skill 版本契约证据

> 2026-10-09 23:55 GMT+8。基线 0a01fe39。

## C03 记忆治理

- 链路钉板（`memory-approval-chain.test.ts`）：候选提取 → `createMemoryApproval`（pending）→ 用户批准 → `executeApprovedChange` → `createMemoryItem` 写入；**批准前零写入**；重复批准幂等（非 pending 直接返回，不二次执行、不产生第二条）；拒绝不写入。
- 敏感候选上游拦截：`containsSensitiveContent`（sk-/api_key/私钥/Bearer/password 模式）在 `extractMemoryCandidatesFromOutput` 中过滤，命中即丢弃并告警——敏感事实不进入审批链，更不可能自动推广。
- 跨项目/矛盾事实：当前无自动推广通道（一切经人工审批），scope 字段由审批载荷携带；语义级矛盾检测未实现（`textSimilarity` 只做合并建议），如实记录为缺口。
- Skill 安全扫描边界：`AuditReport.disclaimer` 固定文案「静态启发式扫描仅覆盖已知风险模式；safe/review 均不构成无恶意证明」，测试钉住任何 verdict 都携带该声明。

## C04 Skill 版本/来源/恢复

- 安装时记录 `contentHash`（SKILL.md SHA-256）进 `.external-source.json`（shared 类型新增可选字段，旧数据兼容）。
- **stale 拒绝**：已安装版本 SKILL.md 与记录哈希不一致（本地漂移）→ 拒绝覆盖并说明原因，`force` 人工确认后放行并刷新基线。
- **重复批准/重试幂等**：同 rev 且无漂移 → `skipped: true`，不重写磁盘。
- **更新失败恢复**：原子替换（临时目录 + rename）为既有实现；漂移拒绝路径测试验证旧版本原样保留。
- **缺授权不写 AGENTS/README**：安装器只写 workspace `skills/` 目录；slug 规整阻断路径穿越（测试覆盖 `../../escape` 输入）。
- 旧数据无 contentHash：`detectSkillDrift` 返回 undefined（无法检测，不阻止更新），如实降级。

## 门禁

全仓 567 文件 3844 pass/0 fail/28 skip；九包 typecheck、lint、docs/diff 通过；真实 workspace 36→36。

## 边界

- 敏感模式是启发式清单，只拦截明显凭据形态；不构成敏感识别完备性承诺。
- 矛盾事实的语义检测、跨项目推广的自动阻断（目前靠"无自动通道"）均为后续项。
- portSkill 的 force 同时放行 audit review 与 stale 覆盖；两者在结果中未区分记录。
