# V02 第二批：完整Git内容变化集与验证记录回读

> 截至：2026-10-08 22:37 GMT+8。
> 基线：`0f150de3`；分支：`feat/harness-reliability-upgrade`。
> 状态：**V02部分完成**。已修复现有研发验证并新增严格回读；没有创建AgentGoal/runId的可信V01回执，没有接V03完成门禁。

## 1. 具体实现

### 1.1 共用只读采集

`development-snapshot-service.ts`的冻结与匹配共用`captureDevelopmentState()`：

- 基于冻结baseCommit枚举已提交/暂存/未暂存的Git差异和非忽略未跟踪文件。
- 重采路径集合、add/modify/delete类型、旧/新内容hash，比较整体指纹，而不是仅比对原快照文件。
- 新增文件、原本未改变的基线文件后来变化、删除文件恢复、范围外变化都不再漏检。
- 不跟随目标或父目录的符号链接；dangling链接也拒绝；读取失败、超限、范围外或Git错误均返回不匹配。
- 保留范围/受保护路径/二进制/数量/体量限制；基线严格40/64位hex；实际读取字节数再次核验单文件上限。
- 原内容/新内容各读取一次，冻结存储的字节与计算hash使用同一Buffer，避免原实现的重复读取不一致。
- 匹配不生成新snapshotId，不覆写快照文件，不更改index/stash。只读副作用测试已覆盖。

这不是文件系统原子快照，也不声称检测任意瞬时修改。Git忽略文件、权限/文件mode元数据和完整目录树不在现有内容指纹契约内；后续若验证依赖这些内容，必须冻结额外输入或明确unsupported，不能以本检查宣称全环境一致。

### 1.2 生产验证流程收紧

`runDevelopmentValidation()`继续使用原白名单command和原验证记录路径：

1. 从权威task/execution/session/workspace派生目录，校验同项目、task实体和scope workspace。
2. 读取已有冻结快照，校验execution/workspace身份及时间。
3. 规范化target/allowed路径并派生scopeHash；commands/reviewer/decision IDs与scopeHash共同派生verificationConfigHash。
4. 在执行前比对完整Git内容变化集；不匹配直接拒绝，不启动验证进程。
5. 执行后重新回读权威任务/指定执行、快照和配置，重新比对完整变化集；配置撤销/变化、快照变化或文件漂移均stale。
6. 持久化新增可选binding到原`development-validation-<id>.json`，不新增另一套数据库或内容存储。

撤销配置会使结果stale，不代表运行中的进程已被停止；真实取消/停止保证不在此批新增范围。

## 2. 记录与回读契约

### 2.1 Shared兼容扩展

`DevelopmentValidationBinding`包含：version=1、projectId/workspaceId/sessionId、snapshotId/baseCommit、scopeHash、verificationConfigHash。

`DevelopmentValidationResult.binding`可选，兼容旧记录。`DevelopmentValidationEvidence`独立表达历史result和当前freshness：

- **fresh**：记录绑定与当前权威对象、配置和Git内容变化集一致。历史result可能仍是failed/timeout；fresh不等于passed。
- **stale**：身份/配置/快照或当前Git内容变化集变化；保留原历史结果，不覆写原JSON。
- **legacy**：旧记录没有binding。可展示，不补造可信新鲜度。

### 2.2 严格结构读取

`development-validation-record.ts`校验JSON结构、文件ID对应、task/execution身份、时间顺序/未来时间、退出码/timeout状态一致性、输出尾长度、hash与binding版本。未知版本/额外字段/坏binding不能静默降级legacy。

`readDevelopmentValidationEvidence(taskId, executionId, validationId)`不接受模型DTO或任意本地路径，只从主进程权威身份派生私有文件位置。路径穿越、记录symlink、非普通文件、超限或不合法记录拒绝。当前命令授权、快照捕获时间和配置也必须匹配。

历史列表同样严格解码，损坏条目排除但原件不删；显式回读会报错。未新增UI或IPC暴露。

## 3. 信任和发布边界

- 这仍是基于**本机受信私有存储**的结构/一致性检查，不是加密签名或独立不可伪造的执行来源证明。具有该目录写权限的本地参与者仍可能一致地修改记录和绑定。
- scope/config hash证明内容绑定，不证明配置审批或真实进程调用；模型文字不能成为回执来源。
- 现有runner只采命令退出，没有可信测试收集计数；不能把exit0自动映射为V01的test passed。
- 尚未解决每次AgentGoal调用的runId、criteria/verifier配置版本、真实toolCallId与不可覆盖执行来源关联，**因此不生成假V01回执**。
- V03、用户验收、交付交接、自动续跑、TCC、ACP和Provider实验均未接入/开启。
- 旧JSON不迁移不改写；备份/恢复仍随原会话私有目录与业务权威身份记录整体进行。新binding不是另一个真相源。
- 新读取器读取能力，不意味着首次完整V02安全门禁通过；G0/G1整体保持未通过。

## 4. 测试证据

- 新鲜度red：6个新case失败，原有7个通过。修复后13个通过。
- 回读red：API/绑定尚未存在，7个新case失败，原13个通过。
- 最终5个定向文件共53 pass、0 fail：验证服务22、快照服务11、记录parser5，以及既有delivery/apply回归。
- 全仓隔离测试：542文件，3595 pass、0 fail、27 skip。skip不作为真实Provider成功。
- 九包typecheck、全仓lint（1970文件）、docs:check、diff检查通过。
- 全仓测试前后真实`~/.gravitas/agent-workspaces/`清单一致：36个目录，新增0。只核验目录清单，不读真实文件内容。
- 私有日志：`harness-v02-red.log`、`harness-v02-reader-red.log`、`harness-v02-targeted-final.log`、`harness-v02-full-tests.log`、`harness-v02-typecheck.log`，位于本会话工作台。
- 测试使用临时Git/worktree和临时配置，真实本地验证子进程；Provider/channel为无效fixture，不调用真实模型。未做Electron打包或原生进程强杀验收。

## 5. 简化审查与回滚

- 共用一个采集函数，无第二份快照内容；纯record decoder与IO/权威世界解析分层。
- 类型保持optional binding，历史状态与新鲜度分离；无any、新依赖、运行feature flag或新表。
- Worktree依赖仅做本地链接层，@gravitas包指向本分支，防止测试误用主工作树的旧shared源码；没有安装或改动原node_modules。
- 当前无可用code-simplifier Skill，本批进行了人工等价审查。
- 回滚代码时新字段可被老读取器忽略，保留验证文件；不要删除stale、legacy或失败记录。旧实现会重新漏掉新增/删除重现，不能把回滚当安全保证不变。
- 版本：shared 0.2.30→0.2.31，electron 0.12.113→0.12.114；生成事实摘要同步。README/AGENTS未修改。

## 6. 下一切片

先补每次Goal调用与验证来源的权威关联、verifier/criteria配置和非零测试收集的可信采集；解决可写私有证据来源的信任边界后，才把read结果接V01/V03。H02完整存储/策略及H03观测仍待补，不能因本批全仓回归通过就默认启用新的完成门禁。
