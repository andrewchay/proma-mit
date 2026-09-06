# Gravitas 诊断修复与验收

日期：2026-09-05。针对 [诊断基线](2026-09-05-gravitas-diagnosis.md) 的 D01–D10，在现有未提交工作区上修复。没有提交、推送、发布或替换已安装应用；原有 Workflow、Memory、Compaction 等改动保留。

## 修复结果

| 诊断项 | 已完成的改动 | 验收与边界 |
|---|---|---|
| D01 Context Store | 实际写盘、统一配置根、按工作区缓存并发打开；关闭先收尾，拒绝后续调用，失败抛出 | 重开召回、并发写入、关闭竞态、写失败保留旧文件通过 |
| D02 Executor | Linux bubblewrap 独立 namespace，固定目录 fd 绑定单工作区，环境清洗、无网络、PID/CPU/内存/时间/输出限制；HTTP 断开触发进程树终止 | 非 root、零 capabilities、受限 seccomp 容器内 8 pass / 1 skip；不支持沙箱时拒绝执行 |
| D03 默认工具 | default-tools 纳入安装包；26 个内置营销执行器编译进 main，修正 storyboard 路径；工具目录版本 6→7 | 实际 macOS 安装包空配置发现、执行、模板安装、旧版升级和用户更高版本保留通过 |
| D04 SQLite 交付 | Campaign/KOL 统一原生接口，Electron 使用 node:sqlite，Bun 使用 bun:sqlite；统一外键启用 | 实际 Electron Campaign/KOL 写入—关闭—重开、目录工具查询、外键拒绝通过；不再依赖缺失的 better-sqlite3 |
| D05 更新身份 | builder publish 与版本历史统一 andrewchay/proma-mit，README 下载入口同步 | 配置已统一；真实签名、发布元数据及已发布版本升级没有验收 |
| D06 配置审计 | 改为同步目录创建与追加，低频配置调用结束前完成写入，IO 错误向上传播 | 全量测试不再出现异步 teardown 后 ENOENT；不是多文件事务 |
| D07 质量门 | 逐文件进程隔离 mock/环境；替换过时私有 projectDir 测试；评测使用仓库 fixtures，真实 Provider 显式 opt-in；清理类型与 Hook 闭包问题 | 全仓测试、类型、Lint、docs 通过；完整 PR 质量 workflow 与包烟测门禁已写入，尚未在远程 CI 运行 |
| D08 数据可靠性 | sql.js 导出原子替换，文件 fsync 与非 Windows 父目录 fsync；业务数据和可重建索引职责明确 | 项目/营销/Context 的失败与重开回归通过；未做真实断电/磁盘写满验收 |
| D09 文档 | README、AGENTS、runtime matrix、生成事实与存储合同同步；保留历史真实 API 记录的日期边界 | docs:check 通过；代码存在不等于生产验收 |
| D10 复杂度与加载 | 重型工作模块、Workflow、Proactive 入口延迟加载；13 个组件修正 Hook 依赖和异步刷新 | 初始 index 4861.11→4511.41 KB，gzip 1426.34→1341.42 KB；没有据此宣称冷启动或首 token 延迟已改善 |

额外修复：目录工具按营销子域订阅过滤，避免只订阅达人却获得广告投放工具；钉钉通讯录调用补认证参数与响应契约，用合成 token 测试；错误文本去除 URL 查询参数，避免凭证进入错误日志。

## 本地最终验收

| 检查 | 结果 |
|---|---|
| 全仓 Bun 测试 | 1204 pass / 27 skip / 0 fail，226 个独立测试文件 |
| TypeScript | 8 个包全部通过 |
| Biome | 1124 文件，0 errors / 0 warnings |
| 文档事实 | docs:generate / docs:check 通过 |
| 构建 | Electron main / preload / renderer / 原生辅助模块、Web 全部通过 |
| macOS arm64 实际目录包 | unsigned 构建通过，离线 packageSmoke passed；26 工具、模板、SQLite、升级保留通过 |
| Linux 实际执行隔离 | 8 pass / 1 skip；网络、邻居工作区、环境变量、超时、取消、HTTP 断开后代终止 |
| 冻结锁文件与 diff | frozen-lockfile 校验、git diff --check 通过 |

27 项跳过包含真实 Provider、外部基础设施与平台条件；不是 27 项已通过，也不全是缺陷。Linux 容器的 1 skip 是“没有 bubblewrap 的平台应拒绝”分支；对应 macOS 分支在全仓测试中通过。

关键日志保留在本机 /tmp/gravitas-fix-tests-final.log、/tmp/gravitas-fix-typecheck-final.log、/tmp/gravitas-fix-lint-final.log、/tmp/gravitas-fix-executor-linux-6.log、/tmp/gravitas-fix-package-smoke-final.log。临时安装包为 /tmp/gravitas-fix-package-final/mac-arm64/Gravitas.app。

## 复验方式

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run lint
bun run docs:check
bun run electron:build
bun run --filter=@gravitas/web build

# 实际安装包烟测：必须传可执行文件，不是源码入口
bun scripts/package-smoke.ts /path/to/Gravitas.app/Contents/MacOS/Gravitas
```

Executor 构建与安全参数见 [SECURITY.md](../../apps/executor/SECURITY.md)。存储备份与恢复见 [storage-contract.md](../storage-contract.md)。内置营销目录依然允许用户更高版本保留，更新不会通过每次启动无条件覆盖来实现。

## 仍需独立验收的内容

- 真实 Provider 的 Pi / AI SDK 文本、工具、审批拒绝、取消、压缩与恢复矩阵；此次未调用真实模型或消耗其额度。
- 渠道切换后的额度刷新、流式队列发送、Workflow 停止/审批与节点切换等真实桌面交互；Hook 依赖检查不能替代 UI 验收。
- Windows/Linux 桌面真机、真实 Computer Use 权限；Linux Executor 容器通过不代表 Linux 桌面功能通过。
- 已签名版本升级、正式发布、生产 OIDC/KMS/数据库/Redis 与部署内核/LSM 策略。
- 冷启动、首 token、长历史渲染与后台恢复的真实指标，以及据此确定的大文件架构拆分；此次仅完成有明确边界的延迟加载。

主进程、preload 和默认工具代码改变后，需要重新构建并重启应用才能生效。本轮没有替用户重启或覆盖日常使用的安装包。

## 实现依据

- [Docker seccomp 官方说明](https://docs.docker.com/engine/security/seccomp/)与仓库随附 Moby 默认拒绝策略及许可；只增加创建内层沙箱所需的调用，没有使用 privileged 或 seccomp=unconfined。
- [Alpine 3.23 bubblewrap 包](https://pkgs.alpinelinux.org/package/v3.23/main/x86_64/bubblewrap)用于选定 0.12.0-r0；Bun 的 libstdc++ 运行依赖经过实际容器启动验证。
