# 本轮任务：五方向推进（2026-11-01 12:21 起）

目标：A) Harness Git 门禁误拒修复、B) 受控自主权限门禁接绑定身份、C) RSI 评测三来源冻结、
D) OpenDesign 会话目录安装+同名另存、E) Enterprise 集中授权模型、F) 更新进度文档。

授权边界：允许本地提交与建分支；不重建/不重启应用、不连生产、不产生真实 Provider 费用。

## 状态：A–F 全部完成（分支 codex/p1-five-direction-slice，3 个提交）

- [x] A `fix(p1)` 段：Bash Git 门禁改词法器 + 4 例误拒回归（9 例通过）
- [x] B：`requireBoundSessionId` + Proma `checkToolPermission` 前置校验（13+24 例）
- [x] B+：AI SDK `checkToolPermission` 前置 `isBoundSessionMarkerValid`（21 例）
- [x] C：`caseMaterialHash`/`judgeHash`/`runConfigHash` 冻结 + 对比不再无条件不可比（40 例）
- [x] D：`installOpenDesignIntoSessionDir`/`readInstalledOpenDesignFromSession` + 注入按 manifest 读另存名（8+27 例）
- [x] E：`workspace-access-policy.ts` 判定模型 + 开关单一来源（10 例）+ 设计说明文档
- [x] F：`delivery-progress.md` 更新到 08331f01 + 本会话五方向小节；`note.md` 追加；design-context 证据补充
- [x] 验证：`apps/electron`、`apps/server` tsc 通过；`docs:check` 通过；biome 无告警
- [x] 提交：0e3bbbf7（主体）、77482060（文档与事实同步）、3c94240c（AI SDK 绑定前置）

## 未做（需用户或环境）

- 重建应用后门禁改动才在线生效（当前会话 Bash 工具仍跑旧 bundle）
- OpenDesign 安装 IPC/UI 传入会话目录（需先定「哪个会话」）
- Enterprise 判定接进工作区读写 / Runtime / 成员管理（按设计文档 S1–S5）
- agent-runtime 目录 3 个沙箱用例需非沙箱宿主执行（嵌套 seatbelt EPERM）
