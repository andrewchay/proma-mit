# OpenDesign 剩余工作 · 一期后盘点（2026-11-01）

基线：origin/main `fe0d0b9c`（含 #95、#101）。本文档是会话级工作文档，只覆盖 OpenDesign 方向；
五路线总进度见 `docs/plans/2026-10-28-harness-autonomy-rsi-roadmap/delivery-progress.md`。

## 已落地（#95 / #101）

- Owner 可预览绑定工作区与 OpenDesign 参考版本；二次确认后仅在共享目录安装 DESIGN.md 与 tokens.css。
- 冲突（同名文件 / 安装目录 / 符号链接）拒绝覆盖；安装记录保存版本、绑定、确认身份与 SHA-256，读取时重新校验。
- 确认同时绑定 Owner 工作区修订、工作区 ID 与参考版本，任一变化要求重新预览。
- 仅声明 `od.design_system.requires` 的 Skill 获取共享安装上下文；本地已有设计文件时保留本地优先级。
- 打包资源路径补齐：目录索引与四个参考 JSON 随包复制到 `Contents/Resources/opendesign/`，未签名 arm64 产物已核实。

## 剩余工作（按用户口径：会话目录 + 另存）

### A. 安装目标改为会话目录 + 另存冲突策略（Medium）

现状安装目标是 Owner 绑定工作区的共享 `workspace-files/.opendesign/active/`，冲突即拒绝。
用户要求：写入当前会话目录；同名文件存在时另存而不是拒绝。

- A1 目标解析：新增会话目录目标（`agent-workspaces/<slug>/<sessionId>/`），与现有工作区目标并存；预览时标明目标路径。
- A2 另存策略：目标已存在 `DESIGN.md` / `tokens.css` 时，自动改用带品牌前缀的文件名（如 `acme-design.md`），并在 manifest 记录实际文件名；不再拒绝。
- A3 冲突展示：预览列出将写入的实际路径；确认后按该路径写入。
- A4 注入适配：`resolveActiveDesignSystem` 已优先本地 cwd 的 DESIGN.md/tokens.css；另存文件名需要注入路径提示或软链，待决策（见下）。

### B. 待用户决策

1. 会话目录安装后，Skill 如何发现另存文件：注入 manifest 路径提示、建立 `DESIGN.md` 软链，还是要求 Skill 读取 manifest？
2. 是否保留现有工作区共享安装作为第二模式，还是整体迁移到会话目录？
3. 安装动作是否走 Owner 逐次审批（ownerActionApproval）？

### C. 明确不在本期

- 动态交互预览、资源审批流、真实 Provider 对规范遵循情况的验收。
- 自动更新已安装品牌（只记录版本，提示用户手动更新）。

## 验收边界

- 浏览器/集成测试覆盖确认、另存、来源记录与注入读取。
- 不声称品牌授权、真实 Provider 遵循或打包应用验收。
