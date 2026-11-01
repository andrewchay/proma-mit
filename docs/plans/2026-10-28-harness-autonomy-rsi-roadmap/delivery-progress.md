# 五路线切片实施进度

初始实施基线 `d2e1b209`；以下记录截至 2026-10-30 的 `main` 提交 `486abab2`。各切片独立提交并经 PR 合并；此记录区分实现、测试与真实验收，不把部分能力标为整条路线完成。

| 路线 | 已实施切片 | 仍需完成 |
|---|---|---|
| Harness | 调度开关、Goal 文件保护、网络响应限制与取消；Bash 写入范围收窄；预存跨边界硬链接在策略生成前溶解；新建仓库 hooks 在命令后收口；新建仓库 config 可执行载体在命令后清洗；Read/Write/Edit 打开前固定 inode 基准 | 跨文件事务、跨 Runtime 与打包验收 |
| 受控自主 | 多类工具入口复核权威会话；Bash 与 macOS MCP 受管进程组；外部动作派发前登记；AI SDK 工具集固定初始会话上下文 | 脱组后代及恢复对账、不可伪造身份、其他 Runtime 撤权和真实 Provider 验收 |
| RSI | 人工判断关联样本并区分来源；评测缺失不再生成虚假分数；迁移候选等待可追溯评测；两条评测的可比性判定、差值报告与成本/延迟门禁 | 多用户认证来源、影子流量采集、统计显著性、Provider 账单核对与真实人工验收 |
| OpenDesign | 静态成果预览、版本反馈、设计任务草稿；固定版本品牌说明与令牌可查看、引用和下载；Owner 工作区安装与受控注入（#95/#101） | 会话目录安装与另存冲突策略、资源审批、动态交互、打包应用内安装验收及真实 Provider 验收 |
| Enterprise | 身份与审计基础、工作区成员和共享成果；Web 分页下载、认证审计导出及 CSV 防护 | 真实 IdP/TLS、生产对象存储、集中授权、外部投递与客户环境验收 |

## 验证边界

- 固定提交 `ac819a62` 的全仓隔离测试：763 个文件，5311 pass、45 skip、0 fail；后续 `06cee18b` 的本机全仓隔离测试：786 个文件、0 fail。`486abab2` 的 PR #64 quality、executor 与三平台打包 smoke 均通过；不能把任一历史提交的本机测试结果等同于其他提交的本机测试结果。
- 独立临时 Postgres 验证了两个连接池的并发审计追加、事务回滚、跨用户法律保全及与清理的互斥；临时容器已清理。这不是生产集群或外部审计投递验收。
- Chromium 测试覆盖 HTML 静态预览隔离、宽度切换以及模拟 IPC 的调度回滚提示；已完成 macOS 测试包启动及 OpenDesign 资源存在性检查；打包交互和真实 Provider 仍未验收。沙箱内嵌套 seatbelt 不可用（`sandbox_apply` EPERM），Bash 沙箱用例须在非沙箱宿主执行。
- [沙箱局部证据](sandbox-slice-evidence.md)、[调度开关证据](harness-startup-evidence.md)、[RSI 采纳证据](rsi-adoption-evidence.md)和[设计上下文证据](design-context-evidence.md)记录具体边界。
- 测试不代表业务签收；原工作目录的既有修改未纳入已合并切片。

受控自主的详细缺口及顺序见 [受控自主推进说明](controlled-autonomy-next.md)。


## 后续切片进展

- Harness：Goal 索引损坏时保留原数据；旧 Goal 增加路径校验和单文件原子替换；网页抓取和搜索响应增加限制与取消。预存跨边界硬链接已在每次策略生成前溶解为私有副本（含 .git/config 与字面路径）；实验确认预拒写 hooks/config 会破坏 git init 兼容，改为命令后收口：新建仓库的非 sample hooks（含 core.hooksPath 间接）重命名停用；新建仓库 config 中 core.fsmonitor、core.pager、filter.*.clean、diff.external、credential.helper、include.path、以 ! 开头的别名等可执行载体在命令后清洗并另存副本（[证据](git-config-carrier-evidence.md)，真实 git 2.54 验证注入确实会执行、清洗后不再执行；三套件在非沙箱宿主零失败）；父目录替换竞态已由打开前 inode 基准关闭；跨文件事务仍未解决。
- 受控自主：多类工具入口重查权威会话；Bash 使用进程组终止并记录未确认状态。macOS MCP stdio 使用受管进程组，监督者存活时停止同组进程；脱组或未能证明后代退出时标 unknown（[证据](mcp-process-reaper-evidence.md)）。桌面、Web Bridge 和 MCP 动作在派发前登记，派发后异常保留未知并拦截同指纹重试（[证据](unknown-action-constraint-evidence.md)）。身份绑定、受管进程启动、跨进程协调、其他 Runtime 和真实环境验收仍待完成。
- RSI：缺失评测和失效评判不会生成有效分数；缺少可追溯评测的跨员工迁移候选暂时关闭。既有数据不作为人工验收的替代。
- OpenDesign：固定版本的 152 套设计说明和令牌可本地查看，用户可选中节选加入待发送草稿；Owner 工作区安装与受控注入已落地（详见 2026-11-01 节）。剩余：会话目录安装与另存冲突策略、资源审批、动态交互、打包应用内安装验收及真实 Provider 验收。
- Enterprise：成员可分页查看和下载共享成果；审计导出使用认证请求，CSV 公式文本增加防护。真实 IdP、对象存储和客户部署仍待验收。

- Enterprise：临时 Postgres 与 Chromium 已验证成员发布、下载与版本撤销闭环；本地 MinIO 验证对象流和取消。真实身份服务、生产存储和客户环境仍待验证。

- P1：AI SDK 适配器将活动会话对象绑定到会话 ID 与工作目录；工具集固定上下文并在等待及调度后复核身份和敏感标记。进程内信任、其他 Runtime 与子 Agent 身份保证仍待推进（[证据](session-binding-evidence.md)）。

- P0 验证基线：`d48e8fc6` 的全仓隔离测试 784 个文件、5524 pass、47 skip、0 fail；同一提交的 quality、executor 和三平台打包 smoke CI 通过。后续 P1 提交需各自验证，真实第三方 MCP 和业务验收仍未完成。

## 2026-11-01 分支内进展（codex/p1-web-change-observation-ledger，未合并）

- Owner 外网扫描一期 S1–S7 已在本分支落地（`089f2ec1`→`5c053165`）：结构化观察账本（幂等身份 + 内容哈希复核 + 500 条/90 天保留）、可信/不可信分区判断提示词与两级字段白名单解析、snippetDigest 账本内去重、扫描服务接入（失败降级 insufficient_evidence、流水 90 次轮转、额度已满跳过）、web_change_observation 对话投递（仅 attention/decision_required）、三态用户反馈与通知收敛、面板观察质量汇总（近 7 天五态分布/重复率/证据不足率）。
- `5c053165` 修复观察账本裁剪 O(n²) 导致的 CI 超时：预检 COUNT/MIN 后才执行 DELETE，本地 1844ms→421ms。
- 未闭环：扫描费用未入 Owner 委托账本；判断模型取第一个启用渠道（缺项目级访问器）；观察卡片无浏览器用例；same_event 仍由模型判断；S8 真实 7 次观察需真实 Provider 与费用授权，执行手册在 `.context/plan/web-observation-s8-runbook.md`。

## 2026-11-01 已合并的切片（主线 fe0d0b9c）

- OpenDesign：PR #95 落地 Owner 工作区安装与受控注入——预览绑定工作区与参考版本，用户二次确认后仅在共享目录安装 DESIGN.md 与 tokens.css；冲突（同名文件/安装目录/符号链接）拒绝覆盖；安装记录保存 OpenDesign 版本、项目/工作区绑定、确认身份与文件 SHA-256，读取时重新校验，损坏不注入；确认同时绑定 Owner 工作区修订、工作区 ID 与参考版本，任一变化要求重新预览。仅声明 od.design_system.requires 的 Skill 获取共享安装上下文，本地已有设计文件时保留本地优先级。PR #101 补齐打包资源路径：目录索引与四个参考 JSON 随包复制到 Contents/Resources/opendesign/，安装服务优先读取该目录并保留开发回退；未签名 arm64 产物已核实六个文件齐全。未验证：打包应用内安装 UI 手动操作、真实 Provider 遵循、品牌授权审核、签名发布验收。
- 受控自主：PR #99 未知动作必须显式确认（AskUserBanner 状态机与 ask-user 服务收紧）；PR #100 在 OperationAuditSettings 展示 pending 未知动作并提供处理入口。
- RSI：PR #96 区分 Owner 判断与执行信号（capability ledger 与 project-chain-judgment 字段拆分）；PR #97 能力批准必须填写可审计理由（approval-service、ApprovalsTab）；PR #98 增加历史 Owner 信号噪声下限（agent-employee-noise-floor）。

## 2026-10-30 已合并的 P1 切片

- 受控自主：PR #61 在 Pi 会话初始化失败时处置已创建会话并释放 MCP；自动化覆盖失败、释放及重试，不代表真实第三方 MCP 或 Provider 验收。
- RSI：PR #62 拒绝空样本和无效对比阈值；PR #63 核对两侧与基准案例清单；PR #64 保留同一 Agent 版本的多次基线评测。历史评测没有可靠的基准及评分规则版本来源，不能用当前配置回填为历史事实。对比函数尚无生产调用方，真实影子流量、Provider 账单与人工验收未完成。
- PR #64 的五项 CI 均成功：quality、executor、macOS arm64、Windows x64、Linux x64 打包 smoke。打包 smoke 与真实用户验收不同。
