# 五路线切片实施进度

初始实施基线 `d2e1b209`；以下已合并状态截至 2026-11-01 的 `main` 提交 `3fac75a2`。各切片独立提交并经 PR 合并；此记录区分实现、测试与真实验收，不把部分能力标为整条路线完成。

| 路线 | 已实施切片 | 仍需完成 |
|---|---|---|
| Harness | 调度/验证子系统、Goal 文件保护、网络响应限制与取消；Bash 写入范围收窄、硬链接溶解、新建仓库 hooks/config 命令后收口、Read/Write/Edit inode 复核；#93 修复隔离环境下的 Git 提交身份；#108 把 Bash Git 门禁改为词法切分（覆盖 eval/find-exec 间接执行），并为 Read/Write/Edit/Bash 之外 6 个工具入口补齐绑定身份校验 | 跨文件事务和原子隔离仍有边界；跨 Runtime/平台、打包后关键路径和更完整的真实验收 |
| 受控自主 | 多类工具入口复核权威会话；Bash 与 macOS MCP 受管进程组；外部动作派发前登记；#99 要求明确确认未知动作、#100 提供跨会话只读待核对清单；AI SDK/Pi 等身份与停止信号已有分段加固；#108 让 Proma/AI SDK/Pi/Claude 四条路径的权限判定都以运行时绑定为授权依据、给 Pi 桥接补统一撤权入口、崩溃后对账未知动作并标注「上次运行中断」 | 脱组后代与跨进程协调、不可伪造身份、真实 Provider 下的撤权一致性验收 |
| RSI | #85/#91 固化题目/规则与来源可比边界；#96 区分 Owner 判断和执行信号；#97 推广审批需审计理由；#98 增加历史噪声地板；缺失评测不生成虚假分数；#108 冻结案例素材/评判实现/运行配置三来源、加入影子对比显著性检验与样本来源审计报告 | 多用户认证来源、接入生产影子流量、Provider 账单核对与真实人工验收 |
| OpenDesign | 静态成果预览、版本反馈、设计任务草稿；固定版本品牌说明与令牌可查看/引用/下载；#95 工作区安装与受控注入；#101/#102/#103 修复打包资源及 Pi/Claude 上下文接线；#104 三平台打包应用安装服务烟测；#106 三平台打包 Owner UI 确认/冲突 smoke；#108 会话目录安装与同名另存（核心层，未接 IPC/UI）、打包链路验收「安装结果进入上下文组装」 | 安装入口接线（IPC/UI 传会话目录）、人工 Owner 验收、品牌资产审批、动态交互、真实 Provider 遵循与品牌验收 |
| Enterprise | 身份与审计基础、成员登记、已发布成果分页查看/下载/版本撤销；Web 界面与临时 PostgreSQL、MinIO/S3 兼容链路已有端到端证据；#108 集中授权判定模型、成员接口接入判定、共享访问开关启动校验 | 把判定接进工作区读写与 Runtime 启动、真实 IdP/TLS、生产对象存储与密钥配置、外部审计投递、客户环境/部署验收 |

## 验证边界

- `3fac75a2`（PR #106）的 quality、executor、macOS arm64/Windows x64/Linux x64 package smoke 五项 CI 全部通过。实际打包 Owner UI/IPC 烟测覆盖绑定目标预览、用户确认、资源读回和重复安装冲突保护；模拟渠道未发起 Provider 请求，不代表人工点击验收或真实 Provider 遵循。
- `5e181e59`（PR #104）的 quality、executor、macOS arm64/Windows x64/Linux x64 package smoke 五项 CI 全部通过。打包 smoke 在隔离 profile 内从实际安装包资源目录读取 OpenDesign 参考、安装到临时 Owner 工作区、读回并校验完整内容及重复安装冲突；它不是人工点击安装验收或真实 Provider 验收。
- 固定提交 `ac819a62` 的全仓隔离测试：763 个文件，5311 pass、45 skip、0 fail；后续 `06cee18b` 的本机全仓隔离测试：786 个文件、0 fail。`486abab2` 的 PR #64 quality、executor 与三平台打包 smoke 均通过；不能把历史提交的本机测试结果等同于当前提交的验证。
- 独立临时 Postgres 验证了两个连接池的并发审计追加、事务回滚、跨用户法律保全及与清理的互斥；临时容器已清理。这不是生产集群或外部审计投递验收。
- Chromium 测试覆盖 HTML 静态预览隔离、宽度切换以及模拟 IPC 的调度回滚提示；#104 已补充三平台实际打包 smoke 的安装服务链路。真实 Provider 行为、Owner 安装界面人工操作和品牌验收仍未完成。沙箱内嵌套 seatbelt 不可用（`sandbox_apply` EPERM），Bash 沙箱用例须在非沙箱宿主执行。
- [沙箱局部证据](sandbox-slice-evidence.md)、[调度开关证据](harness-startup-evidence.md)、[RSI 采纳证据](rsi-adoption-evidence.md)和[设计上下文证据](design-context-evidence.md)记录具体边界。
- 测试不代表业务签收；原工作目录的既有修改未纳入已合并切片。

受控自主的详细缺口及顺序见 [受控自主推进说明](controlled-autonomy-next.md)。


## 后续切片进展

- Harness：Goal 索引损坏时保留原数据；旧 Goal 增加路径校验和单文件原子替换；网页抓取和搜索响应增加限制与取消。预存跨边界硬链接已在每次策略生成前溶解为私有副本（含 .git/config 与字面路径）；实验确认预拒写 hooks/config 会破坏 git init 兼容，改为命令后收口：新建仓库的非 sample hooks（含 core.hooksPath 间接）重命名停用；新建仓库 config 中 core.fsmonitor、core.pager、filter.*.clean、diff.external、credential.helper、include.path、以 ! 开头的别名等可执行载体在命令后清洗并另存副本（[证据](git-config-carrier-evidence.md)，真实 git 2.54 验证注入确实会执行、清洗后不再执行；三套件在非沙箱宿主零失败）；父目录替换竞态已由打开前 inode 基准关闭；跨文件事务仍未解决。
- 受控自主：多类工具入口重查权威会话；Bash 使用进程组终止并记录未确认状态。macOS MCP stdio 使用受管进程组，监督者存活时停止同组进程；脱组或未能证明后代退出时标 unknown（[证据](mcp-process-reaper-evidence.md)）。桌面、Web Bridge 和 MCP 动作在派发前登记，派发后异常保留未知并拦截同指纹重试（[证据](unknown-action-constraint-evidence.md)）。身份绑定、受管进程启动、跨进程协调、其他 Runtime 和真实环境验收仍待完成。
- RSI：缺失评测和失效评判不会生成有效分数；缺少可追溯评测的跨员工迁移候选暂时关闭。既有数据不作为人工验收的替代。
- OpenDesign：固定版本的 152 套设计说明和令牌可本地查看，用户可选中节选加入待发送草稿；Owner 工作区安装与受控注入已落地。#106 已通过三平台打包 Owner UI/IPC 确认及冲突烟测；剩余：人工 Owner 操作验收、品牌资源审批、动态交互与真实 Provider 遵循验收。
- Enterprise：成员可分页查看和下载共享成果；审计导出使用认证请求，CSV 公式文本增加防护。真实 IdP、对象存储和客户部署仍待验收。

- Enterprise：临时 Postgres 与 Chromium 已验证成员发布、下载与版本撤销闭环；本地 MinIO 验证对象流和取消。真实身份服务、生产存储和客户环境仍待验证。

- P1：AI SDK 适配器将活动会话对象绑定到会话 ID 与工作目录；工具集固定上下文并在等待及调度后复核身份和敏感标记。进程内信任、其他 Runtime 与子 Agent 身份保证仍待推进（[证据](session-binding-evidence.md)）。

- P0 验证基线：`d48e8fc6` 的全仓隔离测试 784 个文件、5524 pass、47 skip、0 fail；同一提交的 quality、executor 和三平台打包 smoke CI 通过。后续 P1 提交需各自验证，真实第三方 MCP 和业务验收仍未完成。

## 2026-11-01 P2 收尾（RSI 审计入面板 / 文件对账账本 / 共享工作区只读）

- **RSI · 样本审计接进界面**：`getBenchmarkDetail` 返回 `audit`（`auditScoreboard` 结果），EvalPanel 新增
  「样本来源审计」块：结论句 + 记录数/来源齐备/历史遗留/可对比对/评判身份记录数/每 Case 运行分布；
  单次运行与摘要缺失单独标黄，列出主要缺口。只读、不回填；旧主进程不返回 `audit` 时按缺省处理。
- **Harness · 文件变更账本（跨文件操作可对账）**：新增 `file-mutation-journal`：Write/Edit 在真正截断前记
  写入意图（路径、工具、会话、写入前 SHA-256），成功后记结算（写入后摘要），失败记原因。崩溃/强杀后
  「有意图无结算」的变更进入 `listUnsettledFileMutations()`；`reconcileFileMutation()` 用当前磁盘内容给出
  applied / not_applied / changed_by_others / missing 结论并落盘。范围明确：不做跨文件原子性、不自动回滚、
  只记摘要不记内容；账本不可写时不阻断业务写入但打印警告（该次写入无法事后对账）。
  测试：账本 10 例 + Write/Edit 接线 3 例。
- **Enterprise · 共享工作区元数据只读**：集中授权第一个真实读路径。新增
  `GET /agent/shared-workspaces/{ownerUserId}/{slug}`：先判存在性（404），再走
  `decideWorkspaceAccess(read_workspace)`；开关默认关闭时成员得到 403 `shared_workspace_disabled`，
  非成员 403 `not_a_member`；返回字段白名单只有 owner/slug/角色，SQL 层不选 cwd 与 mcpServers。
  配套窄接口：成员存储 `getMemberRole`、工作区存储 `getOwnedWorkspaceMetadata`。测试 10 例。
- 验证边界：`apps/electron`、`apps/server`、`@gravitas/shared` tsc 通过；agent-runtime 133 个测试文件
  904 例通过（剩余 3 个失败文件为嵌套 seatbelt 不可用）；apps/server 52 个文件仅 `workspace-tools`
  因 `/private/tmp` 不可写失败。未覆盖：完整工作区读写与 Runtime 判定（S3/S4）、跨文件原子性设计、
  真实 IdP/生产存储/客户验收。

## 2026-11-01 本 PR 五方向切片（#108）

- **Harness · Bash Git 门禁词法化**：先切分 shell 区段与 token，只在命令位检查 Git；引号文本、转义、
  here-doc 正文、注释、`2>&1` 重定向与子命令参数按数据处理；`$(...)`、`sh -c` 脚本体递归分析；
  追加覆盖 `eval "…"` 与 `find -exec/-execdir git …`。保留组合执行、`GIT_DIR=`/`GIT_CONFIG_*` 覆盖、
  `-c`/`--config-env` 与间接布局的拦截。测试 11 例（原拦截用例全保留 + 4 例误拒回归）。改动要重建应用才生效。
- **Harness · 工具入口身份门禁**：盘点后发现 6 个工具只做用途门禁、未校验绑定身份（Grep、Agent 委派、
  成员互调、RecallMemory/AddMemory、WebFetch、WebSearch）。新增 `assertOwnerToolGate` 统一「先比对绑定身份、
  再判 Owner 用途」，替换这 6 个工具的全部 13 处门禁点（含网络请求前的二次复核）。
- **受控自主 · 四条路径绑定身份与统一撤权**：新增 `requireBoundSessionId`；Proma 权限门禁前置校验、
  AI SDK 权限回调前校验、Claude 路径新增 `claude-sdk` 身份并在判定前与放行前各比对一次、
  Pi 桥接新增 `assertToolSession` 覆盖普通工具与两条绕过权限回调的早退路径（AskUserQuestion/GoalCheckpoint）。
- **受控自主 · 崩溃恢复对账**：派发前登记写入本进程 `bootId` 与 `phase=dispatched`；加载时把
  「bootId 不同且从未结算」的记录标为 `interrupted` 并补一条可审计中断事件（幂等），保留 pending
  继续拦截重试；设置面板与 `ListUnknownActions` 显示「上次运行中断」。测试 32 例（新增 8 例）。
- **RSI · 三来源冻结 + 显著性 + 样本审计**：记录冻结案例素材、评判实现与运行配置摘要；对比不再无条件
  判不可比，缺项或差异逐项写明原因；新增双侧精确符号检验；新增 `scoreboard-audit` 输出来源齐备性、
  可对比对数、run 数分布与阻塞原因，历史缺口明确不回填。
- **OpenDesign · 会话目录安装与包内链路**：新增会话目录安装（同名另存 `<brand>-design.md`/`-tokens.css`，
  manifest 记实际文件名与摘要，只写不改、失败回滚）；注入优先级改为「本地文件 → 会话 manifest → 工作区共享安装」；
  打包 smoke 追加「安装 → 上下文组装」与未声明/本地优先/缺项三个边界断言。
- **Enterprise · 集中授权**：`decideWorkspaceAccess` 判定模型 + 成员接口接入 + 共享访问开关启动校验
  （开关打开但判定未接入口时拒绝启动）。设计说明见
  [集中授权说明](enterprise-central-authorization.md)。

验证：`apps/electron`、`apps/server` tsc 通过；相关测试文件全绿（eval 26 个、tool-impls 26 个、
pi-tool-bridge 15 例、未知动作 32 例、设计上下文 32 例、workspace-access-policy 14 例）。
环境限制：嵌套 seatbelt 不可用与 `/private/tmp` 不可写的用例需在非沙箱宿主执行；打包 smoke 需打包环境。

## 2026-11-01 Owner 外网观察（PR #94，已合并至 `7fd4f8e2`）

- Owner 外网扫描一期 S1–S7 已合并：结构化观察账本（幂等身份 + 内容哈希复核 + 500 条/90 天保留）、可信/不可信分区判断提示词与两级字段白名单解析、snippetDigest 账本内去重、扫描服务接入（失败降级 insufficient_evidence、流水 90 次轮转、额度已满跳过）、web_change_observation 对话投递（仅 attention/decision_required）、三态用户反馈与通知收敛、面板观察质量汇总（近 7 天五态分布/重复率/证据不足率）。
- `5c053165` 修复观察账本裁剪 O(n²) 导致的 CI 超时：预检 COUNT/MIN 后才执行 DELETE，本地 1844ms→421ms。
- 未闭环：扫描费用未入 Owner 委托账本；判断模型取第一个启用渠道（缺项目级访问器）；观察卡片无浏览器用例；same_event 仍由模型判断；S8 真实 7 次观察需真实 Provider 与费用授权，执行手册在 `.context/plan/web-observation-s8-runbook.md`。

## 2026-11-01 已合并的代码切片（状态截至主线 3fac75a2）

- OpenDesign：PR #95 落地 Owner 工作区安装与受控注入——预览绑定工作区与参考版本，用户二次确认后仅在共享目录安装 DESIGN.md 与 tokens.css；冲突（同名文件/安装目录/符号链接）拒绝覆盖；安装记录保存 OpenDesign 版本、项目/工作区绑定、确认身份与文件 SHA-256，读取时重新校验，损坏不注入；确认同时绑定 Owner 工作区修订、工作区 ID 与参考版本，任一变化要求重新预览。仅声明 od.design_system.requires 的 Skill 获取共享安装上下文，本地已有设计文件时保留本地优先级。PR #101 补齐打包资源路径；#102/#103 分别验证 Pi 与 Claude SDK 的已安装上下文接线；#104 验证三平台打包安装服务；#106 验证三平台打包 Owner UI/IPC 确认与冲突保护。尚未验证：真实人工操作、真实 Provider 遵循、品牌授权审核、签名发布验收。
- 受控自主：PR #99 未知动作必须显式确认（AskUserBanner 状态机与 ask-user 服务收紧）；PR #100 在 OperationAuditSettings 展示 pending 未知动作并提供处理入口。
- RSI：PR #96 区分 Owner 判断与执行信号（capability ledger 与 project-chain-judgment 字段拆分）；PR #97 能力批准必须填写可审计理由（approval-service、ApprovalsTab）；PR #98 增加历史 Owner 信号噪声下限（agent-employee-noise-floor）。

## 2026-11-01 OpenDesign Owner 界面烟测（PR #106）

- 在真实打包渲染器中准备隔离项目、Owner 工作区绑定和不调用的模拟渠道；从 Owner 设计任务卡选择 Stripe 后，经 IPC 预览实际目标、显示明确确认卡片、点击确认安装，再从同一工作区读回打包参考并校验内容。重复安装显示冲突且不再提供确认入口，已安装内容保持不变。
- PR #106 的 quality、executor、macOS arm64/Windows x64/Linux x64 package smoke 五项 CI 均通过。package-smoke 只在 `GRAVITAS_PACKAGE_SMOKE=1` 和临时 `PROMA_TEST_CONFIG_DIR` 下启动；此烟测不连接 Provider，也不代表用户手动验收。

## 2026-10-30 已合并的 P1 切片

- 受控自主：PR #61 在 Pi 会话初始化失败时处置已创建会话并释放 MCP；自动化覆盖失败、释放及重试，不代表真实第三方 MCP 或 Provider 验收。
- RSI：PR #62 拒绝空样本和无效对比阈值；PR #63 核对两侧与基准案例清单；PR #64 保留同一 Agent 版本的多次基线评测。历史评测没有可靠的基准及评分规则版本来源，不能用当前配置回填为历史事实。对比函数尚无生产调用方，真实影子流量、Provider 账单与人工验收未完成。
- PR #64 的五项 CI 均成功：quality、executor、macOS arm64、Windows x64、Linux x64 打包 smoke。打包 smoke 与真实用户验收不同。
