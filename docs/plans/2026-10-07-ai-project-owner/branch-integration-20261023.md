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
