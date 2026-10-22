# AI Project Owner 文档与分支理解

核对时间：2026-10-13。只读查看文档、Git历史与关键源码；没有重跑测试或访问Provider。

## 产品目标
人给目标、必要约束、关键授权与验收；AI负责澄清、计划、角色组织、依赖推进、技术评审/有限返工和问题升级。不以手填全部任务/文件/员工为默认流程。

## 文档权威与读取方式
- goals-and-roadmap.md：产品目标与N0～N4路线。
- ledger.md：AO-00～12实施、AO-A01～12场景、AO-G0～3产品门禁及历史证据。
- capability-audit.md：源码能力和上下文来源边界。
- 专项文档：Goal/Plan、binding、planning A–D、准备、材料化、重验证、资料门禁、grant/command。
- ledger是产品验收台账，不等于SQLite运行/费用账本。历史条目保留原结论，必须看后续追补及对应分支。目录中ledger的“当前结论”和“下一步”仍有10月9日旧口径；后续已落地Stage B与自主Scheduler。

## 分支快照
仓库worktrees根：/Users/chaihao/.proma/agent-workspaces/proma-mit/558ff235-1520-4467-9a8b-bfe89f7bd507/worktrees
- ai-project-owner：feat/ai-project-owner，HEAD c56c182b。当前远端跟踪指向21c5bab7；未fetch，不能推断服务器最新状态。
- owner-a02-a05-context-role：feat/owner-a02-a05-context-role，HEAD 7b6d76b9。17个已跟踪文件存在未提交改动，275 insertions/35 deletions；carrier稳定配置指纹、来源/候选隔离、代表样例与文档，源码版本0.13.6/shared0.2.53。
- owner-a07-background-review：feat/owner-a07-background-review，HEAD c45811ae（2026-10-13 17:41），工作树干净；继承7b6d76b9，但没有自动包含另一worktree未提交来源修复。
- main：db72434d。Owner后续切片不能当成已合入main或已安装版本。

## 关键提交
- 8b214b1f / ab570725 / a40830bc：计划版本、规划协议/审阅、Owner载体绑定。
- 60f067c4 / 048f3962 / b29abd2c：单请求零工具规划、Run证据、逐次费用确认启动。
- 4b1be3b6 / d72bc942 / c509a28a / a54df706：暂停准备、权威Task/step材料化、真实任务来源重验证、执行资料/请求门禁。
- a43c9cc7 / a4abc9eb / 4f6dd71d / adbb4360：grant账本、命令链、安全与session/receipt绑定修复。
- d14622a6 / 00133869：生产dispatcher与有界自主Scheduler。
- c3e1e8d1 / c56c182b：发行前审核价格证据、AI SDK输出和usage结算修复。
- a444822e：roleKey→roleTemplateId→真实员工链、过期unknown归档、fetch前拒绝人工对账。
- 7b6d76b9：N1状态引导、澄清答案进入未保存Goal草案；保存后需新准备及再次费用确认。
- c45811ae：AO-07技术评审、有限返工、预算控制、Owner Home和恢复/晚到幂等证据。

## 执行架构
Goal revision → proposed/confirmed Plan → paused preparation → paused权威Task/step links → v2 revalidation → execution grant → command/queue/claim/handoff → session/受控请求出口 → usage settlement。
内容确认、规划费用确认、业务执行授权相互分离；来源或员工配置漂移时拒绝。unknown保留占额，不自动重试或伪装成功。
AO-06 Scheduler在主进程监听权威事件，不依赖页面mount；每Task Executor→Reviewer；仅权威Task完成或handoff接受才解锁依赖。
AO-07加入严格技术评审回执及reworkOrdinal：changes_requested才允许授权内下一轮，approved不代替业务验收。

## 最新状态与限制
- AO-00/01：文档/原型方向完成。
- AO-02～05：工程子片已有较多证据，整体产品验收未关闭。
- AO-06：自主调度实现切片完成，完整用户/真实Provider验收未关闭。
- AO-07：在独立分支有实现与fake-only Native成功返工链；最新恢复/晚到幂等验证是两个Bun测试进程共用隔离SQLite，不是Electron崩溃/断电保证。
- AO-08～12及AO-G0～3：不能按上述切片自动通过。
- 规划上下文没有仓库正文，AO-A02真实代码自动定位仍阻塞。
- 通用多源冲突、审批通知/答复续跑、通用成果Review、变更/副作用确认和完整异常闭环仍未完整验收。
- 来源契约只对唯一显式项目workspace和唯一稳定roleTemplateId作推荐；carrier不自动推荐为执行人，但允许显式选择后服务端重验；channel/model/runtime不回退全局/最近值。
- context-role ledger记录643测试文件、lint2155、typecheck/docs/build通过；AO07早期记录645测试文件完整门禁，最新Stage B 50项281断言、解析4项8断言与定向门禁。均为文档历史证据，本轮未重跑。

## 台账注意事项
- context-role ledger标AO07待开始，与AO07分支的工程状态不同，不应混读。
- owner-execution-grant.md依赖Native run引用19617a5e，与ledger较新引用97382472不同；需追原run证据才能判断关系，不能直接宣布无效。
- 大量历史HEAD/未提交/未安装文字只描述当时。当前Git状态优先判断提交事实，产品状态仍须依据验收证据。
