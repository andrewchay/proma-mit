# 受保护验证配置实施证据（决策后）

> 2026-10-09 12:16–12:50 GMT+8。决策来源：`protected-verifier-storage-design.md` §6。

## 决策与落地状态

| 决策 | 结论 | 落地状态 |
|---|---|---|
| 1. 测试削弱（缺口 B） | 选 (b)：基线之后受保护路径不得在任何后续提交中改动，删除与重命名按旧路径计入 | 已实现（`completion-protected-paths.ts`，11 例）；**依赖用户正确配置 `protectedPaths`** |
| 2. Agent Bash 不可信 | 需要沙箱 | **验证命令已在 seatbelt 中运行**；Agent 的 Bash 工具沙箱**未启用**（见下文 §未完成） |
| 3. 签名密钥 | `safeStorage` 加密文件 | 已实现（`protected-verifier-store.ts`）；生产 safeStorage 路径未在 Electron 运行时验证 |
| 4. 配置变更需重建 Goal | 是 | 已实现：Goal 绑定 `revision` 与记录哈希，不一致则拒绝完成 |

## 实现要点

1. **受保护路径（b）**：基线必须是 HEAD 的祖先；`git diff --no-renames` 中出现受保护路径即拒绝；模式支持 `**/`、单段 `*`、目录前缀、精确路径；拒绝绝对路径与 `..`。
2. **seatbelt 沙箱**：仅 macOS。默认拒绝写入，只允许写工作副本与用户临时目录；配置目录（含签名密钥与记录）显式拒绝读写。路径使用 realpath（`/var` 与 `/private/var` 不等价，未用真实路径时受保护目录仍可写，已在实验中确认并修复）。非 macOS 平台 fail closed：verdict `unknown`，不执行命令。
3. **签名存储**：配置记录用 HMAC-SHA256 签名，签名密钥（32 字节随机）由 `safeStorage` 加密后保存，目录 0700、文件 0600；审计 `audit.jsonl` 为哈希链。修订号单调递增，保存前若现存记录签名失效则拒绝覆盖。
4. **Goal 绑定**：创建时校验 `verifierRef`（修订 + 哈希）与 Goal 内配置逐字一致；完成时以签名存储的配置为准执行，并再次校验绑定。配置更新后旧 Goal 拒绝完成，错误信息要求重新创建 Goal。
5. **创建校验**：基线 SHA 必须为完整 40 位；受保护模式不能为空且必须合法；验证配置必须合法。

## 测试

- `completion-protected-paths.test.ts`：11 例（模式匹配、只改源码通过、修改测试拒绝并列出路径、删除测试拒绝、移动测试拒绝、基线非祖先拒绝、基线等于HEAD、未提交改动不计入）。模块与测试同批编写，**未单独记录红灯**，如实注明。
- `pinned-baseline-verifier.test.ts`：13 例（原 9 例在沙箱下仍通过；新增报告路径可写、受保护目录写入被拒且报告不生成、读取受保护目录被拒、非 darwin 不执行命令）。
- `protected-verifier-store.test.ts`：8 例（修订递增、0700/0600 权限、篡改记录被检测、重建密钥后旧记录不可验证、密钥无法解密时失败关闭、审计链篡改检测、绑定修订/哈希不一致拒绝、非法 verifierId）。红灯：模块缺失（加载失败）。
- `goal-completion-gate.test.ts`：12 例（验证未通过原因可见、受保护路径违规原因可见、通过写回执、无门禁旧行为、continue/blocked 不验证、验证期间配置漂移拒绝、创建校验、绑定不一致创建失败、真实 git 仓库的四个端到端场景含签名配置更新后拒绝）。
- 相关 7 个文件全部通过；类型检查九包通过；lint 通过。

## 未完成与限制（必须读）

1. **Agent 的 Bash 工具未受沙箱约束。** `executeBashTool` 直接 `exec`，ai-sdk/proma 与 Pi 运行时都经过它；Claude SDK 运行时使用自己的 Bash，本项目无法包装。直接包沙箱会影响 git worktree 提交（`.git` 指向主仓库目录，位于工作区外）与包管理器缓存，需要逐项兼容矩阵后再启用。**这是下一步需要你判断的取舍。**
2. 测试用的密钥保护器是可逆异或，仅用于单元测试；生产路径依赖 Electron `safeStorage`，**未在真实 Electron 运行时验证**（需要应用内验证钥匙串访问）。
3. 没有设置界面：无法在 UI 中创建验证配置或门禁，只能通过协调器 API。
4. Goal 存储（`goal-store`）仍是未签名 JSON；Goal 内的门禁副本只有在存在 `verifierRef` 时才与签名存储比对。没有 `verifierRef` 的门禁仍是“本机私有文件信任”。
5. (b) 的保证范围只覆盖你配置的 `protectedPaths`；未列入的测试文件可以被削弱而不被发现。
6. 沙箱只覆盖验证命令；验证命令内的网络访问未限制。
7. 只在 macOS 上测试过 seatbelt；`sandbox-exec` 是 Apple 标注为旧接口的机制，长期可用性需评估。
