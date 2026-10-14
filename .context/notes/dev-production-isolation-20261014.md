# Gravitas Dev / Stable 双版本隔离（2026-10-14）

## 目标与边界
- 一套代码，两个独立应用：Gravitas Dev / Gravitas。
- 保留生产版现有 .gravitas 与 Electron userData；不移动、不复制正式数据，不替换正在运行的应用。
- Dev 独立配置、userData、协议、安装包输出；禁止读取正式更新渠道。
- Dev 默认不启动后台外部服务、自动评测、Pilot/Workflow 自动执行与副作用恢复；手动操作仍保留既有审批，不等于网络沙箱。
- 双渠道打包均构建新代码；开发身份不等于付费功能解锁。
- 发布门禁包括自动测试/构建及人工升级、恢复、并存验收。未验收不宣称生产可用。

## 探索发现
- 源码 cwd 就是实际仓库，/Users/chaihao/LLM/proma-mit 为指向 cwd 的符号链接。
- app-identity.ts 将 Dev 与 Stable 合并；electron-builder.dev.yml 仍为 com.gravitas.app / Gravitas。
- index.ts 只在 package smoke 下隔离 userData，普通开发运行与正式版存在锁/数据冲突风险。
- config-paths.ts 集中管理多数数据，但 file-logger.ts 硬编码 .proma-mit。
- auto-updater.ts 手动检查仍可用；打包 Dev 需要同时拒绝初始化、检查、安装。
- bootstrap 自动启动 IM、Brief、Companion、Pilot reconcile、评测和 Workflow，Dev 需要默认停用。
- dev-kill.ts 有宽泛 pkill，不运行该脚本，不终止现有生产进程。
- 当前 .context/note.md 等有既有未提交改动，保持不动。
- 工作区级 .context 读取被路径边界阻止，不绕过。

## 进度
- [x] 现状探索
- [x] 身份、数据、更新、后台启动隔离（含模块初始化、邮件同步）
- [x] 双渠道构建与基础发布门禁；README/CLAUDE 与验收文档同步
- [x] 定向测试、全仓九包 typecheck、main/preload/renderer 构建
- [x] 独立审查及修正：邮件自动恢复漏项、Bun Electron 命名导入兼容；Stable 日志保留旧目录
- [x] 二次缺口复核：Dev Goal/Proactive/Monitor 模块导入恢复门禁、Brief/Companion 独立端口与退出清理、Dev 外部轮询阻断、Release 工作流契约测试
- [x] Dev/Stable arm64 .app 构建和 ASAR 渠道元数据核验
- [x] Dev 离线 package smoke（退出 0，sandbox/GPU 报错限制 UI 验证）
- [ ] 正常 bootstrap 真机并存、升级恢复与完整发布门禁；未部署、不发布

## 验证记录
- 渠道/参数/配置/无 mock 导入/解锁测试共 5 文件全部通过；另 migration-evalsystems 通过。
- Orchestrator Goal/projectdir、Monitor、Proactive 5 文件通过；skill-marketplace 六用例被现有硬编码 /tmp 写权限阻断，不视为代码回归或通过。
- 全仓 9 包 typecheck 通过。为解除既有阻断，在 agent-orchestrator 的 Codex compact 错误补 actions: []，未改变执行语义。
- docs:generate / docs:check 通过；定向 Biome 和 git diff --check 通过，未执行全量 lint/test。
- 本次收尾：渠道/发布/构建定向测试 13 项通过；Electron `tsc --noEmit` 通过；Biome 涉及文件 7 项通过；`git diff --check` 通过。未运行全量 lint/test。
- 修正项：Dev 服务端口传 0 由系统分配；Companion 设置变更仅 Stable 自动启停；Dev `POLL_START` 明确拒绝；退出时 Brief、Companion 与 Monitor 有停止钩子。
- Dev .app: apps/electron/out-dev/mac-arm64/Gravitas Dev.app（未签名）
- Stable 验收 .app: apps/electron/out-dev/stable-check/mac-arm64/Gravitas.app（独立输出，未签名）
- 两包 package.json gravitasChannel 分别 dev/stable，Dev CFBundleIdentifier=com.gravitas.app.dev。
- 当前 .app 不是已完成生产发布验收的版本；未生成 DMG、未安装到 /Applications、未退出当前宿主、未提交推送。
- build-mac-app.sh 已移除清理生产 out 的操作，Dev 输出路径同步为 out-dev。
- 文档：docs/dev-stable-release.md。原始目标仍差真实并存、升级恢复和完整生产发布验收。
