# AO-06执行侧门禁能力（休眠）

截至2026-10-09 16:10 GMT+8，Electron0.12.123/shared0.2.36。本片为未来Owner业务执行预建执行侧门禁能力，**全部休眠**：当前没有任何合法Owner业务session/execution，gate行无生产创建路径，所有现有路径行为不变；不发行、不派工、不调用模型。

## 资料工具fence

`project-owner-execution-gates.ts`实现purpose感知工具谓词`assertToolAllowedForSessionPurpose`，替换工具层断言（orchestrator canUseTool首行、ai-sdk tool.execute包装与canUseTool双断言、pi-agent-adapter canUseTool包装双断言；pi-tool-bridge委派options.canUseTool被上述覆盖）。语义：

- 无Owner业务证据→与原`assertNoOwnerBusinessSession`逐字节等价（不抛）。
- 有证据→仅`SearchKnowledge`/`ReadKnowledgeSource`可经fence；其余工具与MCP资源读取恒拒。谓词在canUseTool首行、先于Plan模式分派，PLAN_MODE_ALLOWED_TOOLS不构成旁路。
- fence权威链：session→运行中execution→task marker→step link→材料化→**v2 current重建**（复用重验证get语义）→policy v2引用精确+paused→gate session准入行。任一步失败fail-closed拒绝。
- 可读范围三层交集：实时`resolveRetrievableScope`∩v2冻结`knowledgeSources[].id`；session meta只能收窄不能放大。
- 内容界定：准入时对冻结集合内已索引文档计算快照指纹（sha256(sorted(sourceId,relativePath,contentHash))，上限2048文档）；每次工具授权前重验，失配→全拒要求重新准入（镜像v2 drift→stale）。`ReadKnowledgeSource`逐source白名单校验并写读审计行（source/kb/时间戳，**不存正文**）。metadataHash不冒充内容认证；快照只证准入时刻=校验时刻。
- `admitOwnerExecutionGateSession(executionId, sessionId)`：仅供未来claim链调用+测试；拒绝外层事务；重复准入同execution返回同gate，换execution拒绝。

## 逐请求来源核验钩子（休眠）

`reservePilotRequest`事务内在既有`assertNoOwnerExecutionPreparation`之后新增`assertOwnerExecutionRequestGate`：purpose='controlled_task'（默认）立即返回；purpose='owner_business_execution'要求有效gate session+v2 current+策略引用一致+预算期限未过+模型与v2冻结值一致，并写`provider_admitted_at`（COALESCE语义首次）。7个旧guard一行不改→该分支今天不可达；预留→verify→发送窗口如实保留非零。

## 预算purpose（additive，复用Pilot账本）

`pilot_runtime_grants`/`pilot_commands`各加`purpose TEXT NOT NULL DEFAULT 'controlled_task'`+`owner_source_id`/`owner_source_integrity_hash`；`pilot_request_reservations`经command join派生不加列。现有写路径默认值行为不变；purpose='owner_business_execution'的行本片无创建路径（未来发行片在显式审批+boundary idle+v2 current下创建）。grant expiresAt过期阻断新预留/新发行、不阻断未来对账结算。gate行revalidation绑定在公开谓词中逐次核验（id+integrityHash）。

## 其他

- R1防御：`pilotGrantMatchesPolicy`对仅v2引用的畸形policy返回false（正常路径v2⇒v1必在，纯防御）。
- gates对重验证/材料化/policy模块按需加载：无Owner证据会话的模块依赖图零影响（不把channel-manager/plan-service拉进只窄mock核心的旧测试图）。
- 新表：`project_owner_execution_gate_sessions`、`project_owner_execution_knowledge_reads`（additive）。

## 验证

gates模块12test23assert（行为等价/全拒fail-closed/准入/快照漂移/meta放大兜底/外层事务/purpose迁移/R1/休眠分支）；旧回归（用途11、材料化20、重验证10、pilot reservation/grant、orchestrator owner-planning、runtime boundary三文件）逐文件全过。全量580隔离文件0失败、typecheck/lint(2037)/docs/build通过。Native与独立审查见台账同日条目。

## 激活前置条件（未来发行片必须完成）

- Pi runtime `beforeToolCall` 工具入口保留无条件`assertNoOwnerBusinessSession`硬拒——Pi的fence今天不可达；切换需把它改为purpose感知（S2–S4同步）。
- purpose列无CHECK约束（仅DEFAULT）；迁移补CHECK或由发行片写入路径保证。
- Owner逐请求分支的boundary参数比对集（runtime/permission/cwd/baseUrl vs v2冻结值）与`redirect:'error'`尚未接线。
- 快照指纹跨环境排序稳定性需在激活前评估（当前失配方向为假漂移=fail-closed）。
- 已知记录：`project-memory-scope.ts`的`createRequire`在打包形态失效（先前存在，'project'模式资料scope生产解析为空，fence方向fail-closed）；快照漂移后同session+execution无重准入恢复路径（admit幂等返回旧gate行，恢复需未来片契约）。

## 边界

未来发行片（另审另批）才实现：新命令账本（含boundary idle扩展）、独立启动/claim（豁免收敛）、runner/回执、owner逐请求fetch工厂、stop/恢复扫描、四确认序列。本片gate行仅测试TEMP或admit测试产生；无真实Provider/费用/远端停止/断电多进程验收。
