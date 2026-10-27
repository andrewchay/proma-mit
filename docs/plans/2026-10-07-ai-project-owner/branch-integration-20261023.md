# Owner 分支集成候选 · 2026-10-23

## 范围与来源

候选分支：`codex/owner-main-integration`。基于本地 main `32c21bb7`（远端 main `d1620241` 加客户支持/升级员工模板）；集成过程不修改原 main、Owner 和设计工作树。

- 设计内容：提取 `fc2ba89c`、`8a1a2c0a`、`451940e1`、`09c9d4af`、`cab1f9ae`，形成候选提交 `9f4cdadd`。包括技能集市、HTML/OpenDesign 内容、YAML 解析和各 runtime 的设计上下文注入。没有重合输入体验分支整段旧历史；Codex context 用量修复已在 main，无需重复摘取。
- Owner：三方合并 `feat/owner-a02-a05-context-role` 的 `0b0b4409`，包含 `.252` 模型/超时收口、`.253` 三部分页面、默认项目团队和准确员工会话入口。
- 研发员工标准 `6909916e` 保持独立，尚未纳入本候选。其 SQLite 字段迁移、标准资源 hash、冻结 prompt 与评审证据需单独检查；不隐式混入 Owner 合并。

## 冲突处理

10 处冲突按当前功能契约合并，没有用整目录覆盖：

1. 保留 main 的 Dev/Stable appId、协议、发布和独立输出目录；新增 `electron-builder.owner-test.yml` 与 `dist:owner-test-zip`，E2E 继承该测试配置。Owner Test 使用 dev 通道关闭更新及默认外部服务，并保留测试身份和按版本隔离的资料目录。
2. 主进程先应用测试 profile，再处理 Dev 路径，避免 Dev 标记覆盖测试目录；接入 Owner 启动恢复、调度和退出清理。Owner 管理循环不属于 Dev 默认跳过的外部服务。
3. Pi 保留 main 的 Codex 错误提示及 Owner request-gated 判定；保留各 runtime 的工具范围和设计上下文注入。
4. 权限界面保留稳定的 Hooks 顺序与 Owner 逐次动作确认；全局监听同时保留 pending 快照恢复和输入建议。
5. 研发验证保留进程树终止、close 终态和完整原始字节 hash/长度；文本采集改为有界尾部，避免大输出耗尽内存。
6. shared 导出取功能并集；Electron 统一为 `0.13.255`，shared 为 `0.2.108`，生成事实重新生成。
7. 发布检查改用仓库逐文件测试 runner，避免多个文件在同一 Bun 测试进程中相互污染 mock。

## 本地核查

- 全 workspace TypeScript 通过。
- Owner/运行时/权限/监听/旅程等 23 个行为回归文件通过，共 201 tests、0 fail。包括隔离 Chromium 的基础交付与 2048/FDE 双案例。
- 设计上下文、技能集市、渠道/构建身份、研发验证共 9 个基础文件已核对。初次 app-identity-import 因忽略依赖安装脚本而缺 Electron binary 失败；按 lockfile 安装 binary 后该文件复跑通过。
- `release:check` 通过，内部 5 个文件、17 tests、0 fail；全仓 Biome（2308 files）、生成文档及 diff 检查通过。
- code-simplifier 只读检查已完成，其输出内存问题已按上文修正并通过研发验证回归。

## 仍开放的门禁

测试使用 fake Provider/Runner、隔离 SQLite 和合成 PDF，不证明固定 Electron 的真实团队交付。本轮没有发送真实 Provider 请求，没有改写用户配置、历史费用或已有预留；约 48,869 tokens 仍不能视为已知金额。

仍需外部账单/用量回写与原未知请求安全恢复入口，以及固定版本真实员工、Reviewer、反馈续跑和用户验收。源码集成、构建完成与产品验收分别记录。候选尚未推送、创建 PR 或合并到 main。

## 扩大回归与 `.256` 收口

初次扩大到 73 个 Owner 文件时，有 5 个文件失败；在原 Owner `0b0b4409` 工作树中逐文件复跑，同样 5 个文件失败，排除本次三方合并才引入的假设。

其中一个真实断点：同一目标版本内，用户确认已有相同澄清答复后，新 `answer_saved` 规划链接被已有对话链接的去重规则挡住，无法继续。现只允许 requestId 精确对应同项目、同任务、同目标修订且已消费的 `answer_saved` 事件的准备穿过该过滤；仍经过启动时完整来源、预算、请求和状态校验。已有正例从稳定超时转为通过，重复确认及等待后均保持 3 次 fake execution；新负例验证普通 `goal_saved` 的旧链接在重启后仍不追加执行。

其余夹具按当前契约修正：员工候选使用已有审价的模型；GLM 输出上限为 8192；知识来源先绑定再确认方案，新增项目资料使旧来源 stale 但不扩大冻结集合；后台观察在 userPrompt 中提供结构化 developmentArtifact，systemPrompt 按 executionObservation 约束解释。没有为了断言修改生产提示词或历史请求 hash。

修复后 73 文件、811 tests、0 fail；再加入相邻负例后，管理理解变更文件 9/9 通过。全仓 TypeScript 和 Biome 再次通过。Electron 升至 `0.13.256`，shared 保持 `.108`（本次新增修复只涉及 Electron）。`.255` Dev 包已通过临时空目录内的实际安装包烟测、CRC 和身份检查，但不包含此续跑修复，不作为最终体验候选。

## 最终固定构建 `.256`

源码提交 `c578463d`。执行 `apps/electron` 下 `bun run scripts/dist.ts --dev --current-arch --zip --no-sign`，5 个步骤全部成功、退出 0；这是未签名本地 Dev 候选，不上传或触发更新。

- ZIP：`apps/electron/out-dev/Gravitas Dev-0.13.256-arm64-mac.zip`，286587446 bytes。
- ZIP SHA-256：`e37f02336e6242e7de5898be099ea2a0641e26fe8f48d835695f955b7cb2157a`。
- `app.asar` SHA-256：`fc6b08461e1c42abcce7afeb2c0f9eaff566814d7af798180243b9357998c13c`。
- CRC 通过；Info.plist 版本 `0.13.256`、Bundle ID `com.gravitas.app.dev`；ASAR 元数据为 `gravitasChannel=dev`，没有 Owner Test 标记。

首次直接烟测在 macOS 窗口恢复模态提示处受阻，60 秒超时后没有及时退出，已仅终止该测试子进程。进程采样明确经过 `NSPersistentUIRestorer promptToIgnorePersistentStateWithCrashHistory` 和 `NSAlert runModal`，不将这次结果记为成功。

从最终 ZIP 新解压的 `.app`，在新临时配置目录下，经 `scripts/package-smoke.ts` 重新运行；仅该次测试追加 `--use-mock-keychain -ApplePersistenceIgnoreState YES`，关闭系统窗口恢复并隔离系统钥匙串。结果 `packageSmoke=passed`、版本 `.256`、退出 0：验证 SQLite WAL/重开、3 个核心默认 Skills、26 工具、知识编辑、新媒体 3 次迁移等。本次 Kimi 真实调用开关明确移除，`kimiCompaction=false`；测试 profile 自动删除。正常 UI 启动、系统钥匙串交互及真实 Owner 项目旅程不由这个带参数的烟测证明。

复核命令可从最终 ZIP 解压后，用仅传递上述两个参数的临时启动 wrapper 作为 `bun scripts/package-smoke.ts <wrapper>` 的入口。没有修改系统全局偏好、正式 Dev profile、用户凭据或旧请求费用。
