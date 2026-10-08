# Owner规划协议与计划审阅入口

发生/核验：2026-10-08 22:11 GMT+8用户go on，基于feat/ai-project-owner `7861246e`继续。本片源码Electron0.12.115/shared0.2.30；不是新安装版。

## 本片完成

1. `project-owner-planning-protocol.ts`提供无I/O请求builder与严格响应parser。冻结真实Goal/context源指纹，用JSON数据块描述目标、约束/标准、项目/目标任务元信息及岗位建议；系统指令明确仅规划、不执行、不机械追问、未检索不得伪造定位。响应二选一：`needs_clarification`（1–8个必要问题、原因、选项与建议）或`plan_proposal`（复用已有成果/标准/岗位白名单/DAG校验）。项目/任务/目标版本/来源指纹不匹配、未知授权字段、错误JSON、无原因/重复问题、依赖环/虚构岗位与超限拒绝。
2. 该协议不包含Provider/DB/任务/授权依赖，也没有付费生成endpoint。prompt约束不是保证模型遵守的机制，解析通过只说明结构/捕获来源一致；实际调用与保存仍须权威重读，不能用parser缓存当准入证据。
3. `ProjectOwnerPlanPanel`接项目与单任务目标入口，可看已有提案的摘要、成果、标准、角色建议、依赖、假设/风险、版本、来源及历史。没有计划只显示主动规划尚未接入，不创建示例、不假生成，也不将手工拆任务设默认主路径。
4. Jotai按subject隔离。未保存/冲突目标阻止计划写入；输入在加载、保存、确认晚到时保留，冲突必须加载最新并显式比较，不盲重试。stale不能原版确认，重新保存新版本；历史confirmed不能沿用。修订原因必填；表单和atom对齐服务长度/数组/依赖界限，依赖通过选择步骤标题而非手填内部key。确认只认可内容，不产生费用、执行授权或派发。
5. 当前数据origin仍manual，不能标成AI生成。本片没有接Owner身份、模型调用、生成回执或自动派工。

## 验证结果

- 协议BDD先RED（模块缺失）后8项/41断言通过。父追加UI长度回归先RED（6次必失败请求仍发送）后修复GREEN。
- 计划atoms16项/47断言、面板SSR3项/18断言、实际Chromium组件替身交互1项/19断言通过，原Goal/Task入口回归通过。浏览器替身不算真实Electron或DB。
- 全仓548测试文件独立进程、失败0；真实Provider及外部服务显式skip，不当作通过。全typecheck、lint1981文件、docs/diff与完整build通过，两个macOS原生helper构建成功，无新依赖。
- 固定Electron39.8.10/ABI140、实际产品preload、better-sqlite3 13.0.3/SQLite3.53.4/WAL：47次真实IPC。目标冲突/主体隔离、数据库重开及新renderer回读沿用回归，新增真实计划UI修改摘要/原因→revision3/planVersion2/proposed→人工确认revision4→四条历史。任务/员工/execution/Pilot/链表及任务内容不变，零HTTP，临时配置清理。
- 最终Native runId `1096e273-60f8-43a4-ba55-d39b25715968`；回执及构建源码hash、日志、截图在会话工作台`owner-plan-review-native-validation/`，父已核对。此前`owner-plan-native-validation/`历史回执未覆盖。
- 独立host，不是完整产品导航/安装包、完整进程重启/断电/多进程验收；没有真实模型调用或费用/底层进程停止证据。

## 真实模型接入的审查结论（待审，不是已实现）

推荐复用controlled准备/启动/费用确认、权威Task/AgentExecution与最终Provider门禁，加`owner_planning`目的与同库source-link；targetTaskId与planningTaskId分开，实际worker作为carrier，不改名冒充Owner。首版AI SDK、一请求、零工具/MCP/Skills/通用上下文/历史/压缩/重试/额外模型调用；可信Runtime回调先留不可覆盖Run/用量证据，再双CAS落proposed或必要澄清，不冒充manual/local-user产出。

已重新核验`packages/shared/src/types/agent.ts`：当前ai-sdk的supportsBudgetStopThreshold为true（PILOT-20260928-56），不是旧文档中一概不支持；但费用出口只在真实Pilot command/grant归属下生效，不能给普通Owner传参数就宣称有硬预算，更不能伪造Pilot绑定。当前controlled费用确认没有金额硬上限保证；规划费用须逐次确认、未知费用保持unknown。若要求硬金额控制，须另审现有预留/价格/unknown账本归属的通用化。

下一片待批准的增量契约包括Owner/carrier身份、资料范围、单次请求/输出限额、禁止隐藏注入/工具/重试、Run来源与重启unknown语义。实现审批不等于首笔收费许可。旧普通LLMCaller不直接用于Owner，不平行另造grant。

本片不push/merge/安装，不改README/AGENTS。AO-04与AO-05仅协议/审阅子片推进，主动模型规划与执行授权绑定仍未完成；AO-G0～G3不据此判为通过。
