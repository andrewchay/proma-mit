# AO-06暂停权威Task与精确步骤关联

截至2026-10-09 GMT+8，Electron0.12.121/shared0.2.34，暂停材料化首片已完成本地实施与隔离验收。AO06总体仍进行中，本片不是实际许可或自主派工。

## 契约

四个typed入口：getOwnerTaskMaterialization、listOwnerTaskMaterializationHistory、previewOwnerTaskMaterialization、materializeOwnerTasks。actor固定local-user；输入只主体、请求ID、材料化/准备/策略版本及准备/预览摘要，没有客户端Task IDs、任意patch、员工替代值、Model、grant、预算或active字段。

从当前已应用AO05准备读取精确confirmed计划revision/planVersion、Goal/context/plan fingerprints、选择闭包、明确不同真实Executor/技术Reviewer、工作区/Runtime/渠道/配置/资料元数据。岗位模板仅建议，实际人员沿用已明确选择的一对，不宣称全角色智能匹配。技术Reviewer员工不是人类业务验收人；标准随步骤/关联/任务说明冻结，不补造交付、Review Task或自动DoD。

项目目标每个所选步骤创建一个新的顶层权威Task；首次INSERT paused+owner_step_link_id，controlledPreparationId为空。依赖为准确的finish_to_start、taskId下游/dependsOnTaskId上游，不按标题复用旧Task或假称同项目即白名单。

单任务首片仅一步、无步骤依赖绑定既有target，不能默认拆children、合并多步骤或改成projectGoal。只接管无旧执行/受控/规划/交付/层级/依赖证据的普通pending/paused目标。preview显示人员、旧canonical成员键、工作区、状态及研发范围影响；confirm只更新已批准项并清旧成员键，保title/description/priority/parent/日期。合法patch使原AO05 whole目标hash自然stale，原准备不改、不伪current；材料化结果恒为paused_materialized_needs_revalidation。

## 同库与幂等

复用tasks/task_dependencies/project_activities，仅加附属材料化history、exact links、不可普通清除marker和已观察session负向限制。不是平行任务、许可或预算系统。

policy快照锁内二次CAS，SQLite一个事务落全部Task/link/dependency/activity，**不修改Pilot JSON、不发TaskChange/外部同步**。外层wrapper/raw BEGIN/SAVEPOINT拒绝；ABORT全部rollback。内部builder仅本次未提交staging同步作用域且单次消费；历史committed link不是恢复capability，不能复活取消目标、补造Task/edge。

project级requestId+完整输入幂等；同请求返回已提交历史，current drift另读显示，不再次生成Task/dep/activity。另一request或新planFingerprint不能悄悄迁移旧mapping。双向校验header/indexed links/marker，缺坏原件拒绝重建或降none。Task/link/计划/资料漂移不自动修复，不释放unknown预算。

## 负向能力边界

marker非NULL（包括空坏值）、indexed links/history、限制表Task/execution/session/project归属任一残余限制能力；沿有界真实parent祖先检查已有异常child，不按whole-project扩封无关Task。全部session executions而非LIMIT1；queued空session不是共享身份，不能圈其他普通队列。

覆盖普通/controlled派发、IfIdle清队列前、enqueue、tryStart/heartbeat/Workflow、claim、headless session/worktree/Runner交接、费用preview/ack/幂等existing-return、development现有任务/范围/返工与直接交付、普通规格/状态、草稿确认、WBS/独立subTask、状态group及裸SQL迁移、依赖两端/级联删除。允许暂停/取消/保全；无合法business Run，异常完成不生成学习、业务验收或DoD。

Orchestrator和四Runtime query/queued/permission/steering/title/子代理入口按真实身份拒绝；AI SDK/Pi每payload/fetch、异步hook后再读；直接Proma主请求与manual/auto/overflow/tool压缩共用always-on负向fetch，工具权限回调后再读。Claude仅query前拒绝，不宣称已有SDK内部每HTTP预算出口。没有身份的公开标题服务不能凭正文/同项目猜Owner用途；Owner内部标题携带session身份并拒绝。

旧AO05/Pilot SourceGate额外识别材料化header/link/marker/已观察限制归属残余：原准备row或可选policy目的字段丢失也不能退legacy。关联落完不放开旧issuer、预算、请求或资料工具能力。

## 界面

在原准备面板旁嵌入暂停Task关联面板，显示准确版本/指纹/step/实际人员/目标before-after/Task/edge及缺口；唯一动作“落为暂停任务”，历史只读。Jotai按subject隔离，源/计划/准备变化使preview失效；晚到保输入、冲突显式比较、双击禁用。成功只重拉权威Task并用专用signal刷新ProjectView局部列表/看板/依赖/活动，不能触发TaskChange或派工。刷新失败不声称已提交事务回滚。

## 当前验证及限制

- 后台材料化20项68断言、用途/变更11项33断言、四IPC3项25断言通过；独立首次4P1/3P2已真正RED→GREEN。续轮发现空session误圈及旧SourceGate残余缺口，均整改并增加反向用例。
- Runtime专属26项、员工门禁21项以及Jotai/UI16项在各自报告记录；新增直接Proma与严格身份库fixture复跑。全工程575个隔离测试文件失败0、全包typecheck通过。完整lint2027、docs、diff和build（renderer/preload/resources/两原生helper）通过；已审范围复核无剩余可复现P0/P1/P2。最终Native 438e18d3-fcfb-4a6d-bd6d-e2b1427324fc通过45checks，8截图、342源码SHA由父核对无差异，sourceSHA为cae4ea5f65e670d9eefb6856230befc6556b826f045563cc22bbf352ad1168dd；原36/44报告保留。共享受限session的direct交付另补RED→GREEN9/34，快照、chain不变。一次完整复跑的未改微信AES-CBC篡改单测随机失败原日志保留，原文件及下一完整575复跑通过；不声称无关随机断言已修复。
- 首轮Native ff137321-201f-4d94-a6e4-0926f1571125、36 checks，实际Electron39.8.10/ABI140/native WAL、生产preload/4IPC/sourcePanel，0业务启动/SDK/ModelHTTP/费用请求/TaskChange，TEMP清理/旧203文件SHA保留；**后续源码/版本变更须另开run，不把旧SHA当当前验收**。sourcePanel不是完整生产main导航。
- 原始报告/探针/RED/GREEN/Native run保留在会话workbench，不改写历史成功或问题记录。本地SHA是损坏检测，不认证任意SQL写者。
- 早期Runtime子测试的首版Claude RED harness未先装SDK tripwire，触及真实SDK query入口，仅有`.next()` resolve记录，无Provider回执/费用记录，不能证明当次绝对零模型网络，也不推断费用为零。该次不计严格离线验收；其后重录RED与全部最终SDK测试在运行前装tripwire/内存transport。没有授权真实Provider验收，后续不得再以先触及SDK观察结果代替前置隔离。

实际执行许可、完整Task/link版本重冻结、资料工具fence、逐请求预算、角色调度/依赖推进、技术返工/审批续跑、业务Review/恢复和真实Provider仍需后续单独批准。没有push/merge/安装/生产修改；旧AO-G0～G3及历史G4/W09/W10/R02/R03/R04不因本片通过。
