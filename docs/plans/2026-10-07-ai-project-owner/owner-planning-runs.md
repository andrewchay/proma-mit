# Owner规划C：可信Run、待审提案与受控准备界面

日期：2026-10-09 GMT+8。实现契约沿用已批准的Owner规划A–D方案；本片源码版本Electron0.12.118/shared0.2.32。只在本地开发，不安装、推送、合并或真实调用Provider。A阶段的模型启动禁令仍保留，不能将界面完成解释成已获调用许可。

## 行为与授权边界

目标保存、版本化Owner职责与既有载体绑定、暂停准备、审阅和确认计划内容分别是独立动作。配置不创建或激活员工，不修改Runtime或权限。用户选择既有enabled/controlled/ai-sdk员工与双方明确授权的项目工作区；Owner名称不是执行身份，也不因此获得载体权限。

项目与单任务复用同一流程。准备冻结Goal/Plan/context/配置版本与原始指令，创建单独、可见、paused的规划承载任务；目标业务任务不变。四项严格typed IPC只提供绑定读取/保存、暂停准备及Run读取，不提供自由Caller、客户端写回执或替代start入口。未保存目标、计划编辑、版本冲突或来源损坏时禁准备；首次没有Plan也能加载规划来源，不要求先手工拆任务。

既有controlled费用预检包含Owner用途、全部版本、实际员工/渠道/模型/工作区、冻结system/user指令及JSON来源、唯一请求与4096输出上限。费用提示明确没有金额硬封顶保证，未知不是零元，停止不证明远端终止或费用结清。safe不是沙箱或无工具权限；Owner实际零工具约束仍由B的专用Runtime路径落实。C允许只读预检，启动仍拒绝，不能把勾选确认或fake测试占位当成已开放生产调用。

## Run与生成证据

可信server callback先保全原始证据，再解析生成。`project_owner_planning_run_receipts`不可覆盖，保存冻结主体/载体/模型/Run身份、原始响应、hash、终态、nullable Owner用量和Runtime报告USD或unknown。不同晚到回调追加回执，相同捕获幂等复用；每execution的第一个处理outcome固定，后续费用证据不重启任务、覆盖结论或生成新版本。hash用于本地完整性核查，不是签名或Provider直接回执。

生成要求真实关联的admission、匹配session与AI SDK终态、success/stop、运行中的execution、严格JSON协议及当前Goal/Plan/配置/source双CAS。可信提案标记`origin:generated`与`system:owner-planner`，绑定原始Run/receipt/responseHash，不接受客户端origin或模型自报来源。人工确认只改变内容认可状态和本机actor，不授权派工。`needs_clarification`只显示必要问题；用户须修改并保存目标、重新准备、重新确认费用，不自动续问或补发。

规划完成只终结承载Run并将承载任务paused，不走普通DoD、员工绩效、学习、Review或外部通知路径，不完成目标业务任务。

## 停止、失联与损坏

用户停止先将意图写入`project_owner_planning_stop_requests`，再向原execution的Runtime generation请求abort。只有stopper核验结果才决定是否逻辑取消；只接受请求且`NOT_VERIFIED`时不伪称进程已终止。晚到success可以保存原文及费用，但停止意图阻止生成。用途检测只收紧能力，不作发送或生成许可；冻结资料损坏也不能阻止已知execution的目标abort。

心跳发现Owner失联保守stale/unknown，保留admission，不自动补发，也不进入普通任务学习或通知。严格来源解析失败时，`project_owner_planning_callback_evidence`先保存server原始回调，再由Worker隔离为stale；隔离记录不是完整可信Run或结清证明，修复来源后晚到也不自动生成。当前UI对损坏来源明确报错，不静默显示“没有Run”；没有专门的隔离回调查看入口。

带Owner关联的项目、规划承载任务及目标业务任务禁止普通物理删除，避免执行和晚到收费证据丢失。首版没有tombstone/归档流程，不假装删除成功；应暂停并一致保留数据。

## 验证分层

- Run服务18项/69断言覆盖不可覆盖证据、重复/晚到、生成来源、无效协议、CAS、费用unknown、停止意图、删除拒绝、坏来源原始回调隔离。
- 真实Worker与显式fake授权/认领/Runner6项/62断言覆盖完成与重复回调、不走普通学习/绩效、失联、generation停止、坏来源隔离与修复后晚到。这不证明实际费用start或SDK出站全链。
- Runtime IPC2项/11断言，Jotai5项/16断言；首次无Plan来源、目标/计划并发保护、费用界面与普通controlled/development回归另有隔离测试。
- 本次原生验收runId **6422d725-0233-4401-ba3d-13a654da35bd**：实际Electron39.8.10/ABI140、better-sqlite3、SQLite3.53.4/WAL，实际产品preload及源Goal/Runtime/Plan组件，30次Owner IPC。覆盖A/B/C表创建、旧A无source_snapshot迁移与重开、界面保存目标/职责绑定/首次暂停准备、费用预检与A禁启动（零execution/HTTP）、显式fake admission/callback生成提案和人工确认、必要澄清、generation事务ABORT后receipt保留而Plan/outcome无半写、再次重开及360px无横向溢出。
- 原生harness明确替换host的getMainWindow及agent-service：没有完整产品main入口，Runtime调用抛出禁止错误。所有配置在一次性临时目录，结束清理；无真实或fake Provider HTTP。这是原生存储与组件/IPC证据，不是D的真实start→Worker→Orchestrator→SDK最终body链路、生产导航、打包、真实费用、进程终止或断电/多进程验收。

独立审查的删除证据丢失P1与来源诊断被吞P2已修复；新增停止/损坏隔离逻辑仍须复审。最新完整门禁和提交以台账记录为准，不将运行中或旧树的结果当最终验收。AO-02/03/04及AO-G0–G3不因本片自动全部完成。下一步D补完整受控启动与假Provider全链、恢复边界和安全收敛；真实模型仍需独立明确费用许可。

### 本片收束

最新静态树完整559个逐文件测试失败0、全包typecheck、lint2000、docs:check/diff及完整build通过。独立复审已收敛，原删除/诊断问题关闭；复审新增残余用途识别P2已另行RED→GREEN，stop/callback/receipt/outcome/admission任一execution证据均阻止普通路径、删除及未受控来源解析。Worker新增五种损坏组合覆盖error/completion/heartbeat，内部生成还独立检查停止意图，不能误复用旧valid回执。当前完成C准备/回执/提案切片，不宣称D闭环或实际模型费用验收；closed保留。
