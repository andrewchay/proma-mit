# 五路线切片实施进度

基线 `d2e1b209`；切片位于独立工作树，按功能独立提交。此记录区分实现、测试与真实验收，不把部分能力标为整条路线完成。

| 路线 | 已实施切片 | 仍需完成 |
|---|---|---|
| Harness | 调度开关、Goal 文件保护、网络响应限制与取消；Bash 写入范围收窄；预存跨边界硬链接在策略生成前溶解；新建仓库 hooks 在命令后收口；新建仓库 config 可执行载体在命令后清洗；Read/Write/Edit 打开前固定 inode 基准 | 跨文件事务、跨 Runtime 与打包验收 |
| 受控自主 | 多类工具入口复核权威会话；Bash 与 macOS MCP 受管进程组；外部动作派发前登记；AI SDK 工具集固定初始会话上下文 | 脱组后代及恢复对账、不可伪造身份、其他 Runtime 撤权和真实 Provider 验收 |
| RSI | 人工判断关联样本并区分来源；评测缺失不再生成虚假分数；迁移候选等待可追溯评测；两条评测的可比性判定、差值报告与成本/延迟门禁 | 多用户认证来源、影子流量采集、统计显著性、Provider 账单核对与真实人工验收 |
| OpenDesign | 静态成果预览、版本反馈、设计任务草稿；固定版本品牌说明与令牌可查看、引用和下载 | 完整规范注入、资源审批、动态交互、打包应用及真实 Provider 验收 |
| Enterprise | 身份与审计基础、工作区成员和共享成果；Web 分页下载、认证审计导出及 CSV 防护 | 真实 IdP/TLS、生产对象存储、集中授权、外部投递与客户环境验收 |

## 验证边界

- 固定提交 `ac819a62` 的全仓隔离测试：763 个文件，5311 pass、45 skip、0 fail。后续切片分别经过定向测试和类型检查，尚未对最新 HEAD 完成全仓回归。
- 独立临时 Postgres 验证了两个连接池的并发审计追加、事务回滚、跨用户法律保全及与清理的互斥；临时容器已清理。这不是生产集群或外部审计投递验收。
- Chromium 测试覆盖 HTML 静态预览隔离、宽度切换以及模拟 IPC 的调度回滚提示；已完成 macOS 测试包启动及 OpenDesign 资源存在性检查；打包交互和真实 Provider 仍未验收。沙箱内嵌套 seatbelt 不可用（`sandbox_apply` EPERM），Bash 沙箱用例须在非沙箱宿主执行。
- [沙箱局部证据](sandbox-slice-evidence.md)、[调度开关证据](harness-startup-evidence.md)、[RSI 采纳证据](rsi-adoption-evidence.md)和[设计上下文证据](design-context-evidence.md)记录具体边界。
- 测试不代表业务签收。提交已推送到远端分支，尚未合并；原工作目录的既有修改未纳入这些提交。

受控自主的详细缺口及顺序见 [受控自主推进说明](controlled-autonomy-next.md)。


## 后续切片进展

- Harness：Goal 索引损坏时保留原数据；旧 Goal 增加路径校验和单文件原子替换；网页抓取和搜索响应增加限制与取消。预存跨边界硬链接已在每次策略生成前溶解为私有副本（含 .git/config 与字面路径）；实验确认预拒写 hooks/config 会破坏 git init 兼容，改为命令后收口：新建仓库的非 sample hooks（含 core.hooksPath 间接）重命名停用；新建仓库 config 中 core.fsmonitor、core.pager、filter.*.clean、diff.external、credential.helper、include.path、以 ! 开头的别名等可执行载体在命令后清洗并另存副本（[证据](git-config-carrier-evidence.md)，真实 git 2.54 验证注入确实会执行、清洗后不再执行；三套件在非沙箱宿主零失败）；父目录替换竞态已由打开前 inode 基准关闭；跨文件事务仍未解决。
- 受控自主：多类工具入口重查权威会话；Bash 使用进程组终止并记录未确认状态。macOS MCP stdio 使用受管进程组，监督者存活时停止同组进程；脱组或未能证明后代退出时标 unknown（[证据](mcp-process-reaper-evidence.md)）。桌面、Web Bridge 和 MCP 动作在派发前登记，派发后异常保留未知并拦截同指纹重试（[证据](unknown-action-constraint-evidence.md)）。身份绑定、受管进程启动、跨进程协调、其他 Runtime 和真实环境验收仍待完成。
- RSI：缺失评测和失效评判不会生成有效分数；缺少可追溯评测的跨员工迁移候选暂时关闭。既有数据不作为人工验收的替代。
- OpenDesign：固定版本的 152 套设计说明和令牌可本地查看，用户可选中节选加入待发送草稿。完整资源注入、审批及真实 Provider 验收仍未完成。
- Enterprise：成员可分页查看和下载共享成果；审计导出使用认证请求，CSV 公式文本增加防护。真实 IdP、对象存储和客户部署仍待验收。

- Enterprise：临时 Postgres 与 Chromium 已验证成员发布、下载与版本撤销闭环；本地 MinIO 验证对象流和取消。真实身份服务、生产存储和客户环境仍待验证。

- P1：AI SDK 工具集固定初始会话和工作目录，并在等待及调度后复核敏感标记；这只是状态漂移防护，完整身份保证仍待推进（[证据](session-binding-evidence.md)）。

- P0 验证基线：`d48e8fc6` 的全仓隔离测试 784 个文件、5524 pass、47 skip、0 fail；同一提交的 quality、executor 和三平台打包 smoke CI 通过。后续 P1 提交需各自验证，真实第三方 MCP 和业务验收仍未完成。
