# 2026-09-30 Project Pilot G1 零付费固定构建验收记录

## 范围及固定性
- 用户选择：以干净 HEAD `f22521704df5130e7feeca1f5984706a7a1b2184`、零付费方式先验收；未授权新 Provider 调用。
- 隔离 worktree：`/private/tmp/pilot-g1-fixed-f2252170`。初次构建发现复用根 `node_modules/@gravitas/*` 符号链接会指向并行未提交源码，故初次构建**作废、不入结论**。重定向所有 workspace 包链接到隔离 worktree 后重新 typecheck、构建、打包、烟测。第三方 node_modules 仍复用现有安装，未做独立 `bun install --frozen-lockfile`；macOS arm64 未签名目录包，非分发 DMG。
- 固定产物：`apps/electron/out/mac-arm64/Gravitas.app`，`app.asar` SHA-256 `3a51d84fd045f5e82eb0c8c8beca45031786aa0f2ca6d187fb4ccfc5c54fe287`；Electron 39.8.10，应用 0.12.98。worktree 的受跟踪文件无修改；存在未跟踪 `node_modules.shared-link`（最初的外部依赖链接，非构建输入）。

## 已执行及结果
- 干净 worktree 九包 `bun run typecheck`：全通过。
- `apps/electron` 的 `bun run build`：通过（Vite 大 chunk 警告）；`CSC_IDENTITY_AUTO_DISCOVERY=false bunx electron-builder --dir --mac --arm64 --publish never`：通过，未签名；平台不匹配的可选依赖提示缺失。
- `env -u GRAVITAS_PACKAGE_SMOKE_KIMI_CHANNEL_ID -u GRAVITAS_PACKAGE_SMOKE_CHANNELS_PATH -u GRAVITAS_PACKAGE_SMOKE_KIMI_MODEL bun scripts/package-smoke.ts apps/electron/out/mac-arm64/Gravitas.app/Contents/MacOS/Gravitas`：`packageSmoke:passed`、exitCode=0、`kimiCompaction:false`、`sqlite:node:sqlite`、知识编辑通过、新媒体 schema 3／迁移 3。隔离临时配置、烟测脚本生成专用临时签名权益，结束清理；无 Provider 调用。烟测出现 safeStorage 不可用、临时新媒体账户密文降级为 base64 的提示；该测试不验证 Pilot 渠道 `createChannel`/safeStorage 创建链。此烟测不打开 Pilot UI，也不触发 Pilot Runtime。
- G1 局部六文件（`project-pilot-g1-fixture`、`background-e2e`、`native-crash`、`grant-pause`、`approval`、`recovery`）在修正 workspace 包链接后的干净 worktree 复跑：**57 PASS/0 fail/339 assertions**。这些是干净 HEAD 源码的局部回归，强杀使用 Electron run-as-node；仍不是打包产物内部的 UI／Runtime 全场景。

## 未通过/未覆盖（不得宣称 G1 完成）
- `g0-contract-ratified.md` §5 的 A01–A07/A09a 全量同场景确定性验收尚未执行；现有用例各自为局部切片，强杀用 Node/Electron run-as-node，不是打包主进程强杀和 UI。
- P0 目标确认→必要澄清→结构化计划/角色选择→离开页面后台推进→真实技术评审识别缺陷并返工→主动必要人工请求→答复后自动推进至最终人工验收前的闭环未在固定构建中实测。离线 fixture 注入模型结论和启动替身，不能充当真实 ai-sdk 场景。
- 本次未打开打包应用的真实 Pilot UI、未以生产 `createChannel` 创建渠道，未验证生产持久授权完整操作链、真实 Runtime 文件边界/停止证明/外部副作用；不得以 package-smoke=passed 推断这些能力。
- 用户未授权新付费请求，真实 ai-sdk 评审与闭环不执行；若要继续，须单独冻结隔离项目、模型、预算、请求上限、有效期和凭据安全接入方式；旧 `needs_reconcile` 占额继续保留。
