# AO-06材料化后重新验证（v2准备来源）

截至2026-10-09 12:40 GMT+8，Electron0.12.122/shared0.2.35。本片是AO-06首片"needs_revalidation"状态的正式出口：按真实权威任务重新冻结执行准备来源，仍暂停、不发行、不派工。

## 契约

四个typed入口（get/listHistory/preview/saveOwnerExecutionRevalidation）。输入只主体、requestId、v2 revision CAS、材料化三元组（id/revision/integrityHash）与policy revision、changeReason。v2来源冻结：真实paused Task清单（stepKey/linkId/linkKind/taskSpecificationHash/assignee/workspace/研发范围）、真实依赖edge、真实人员/工作区/渠道/模型/Runtime/能力/技能/资料元数据摘要、binding provenance，及上游双三元组（materialization + 原AO05准备）。planFingerprint/contextFingerprint必须等于v1冻结值；budget（maxCostMicros/maxRuns/maxRework/expiresAt）从v1原样携带，**期限与预算不因重验证顺延**；v1 expiresAt过期即拒绝预览。

构建方式：实时重放`buildOwnerExecutionSource`（plan仍须确认且revision未变）+ 权威Task/dep核验（marker/规格hash/edge hash与材料化记录精确一致）。因此任何真实事实漂移都使重建hash与冻结值不一致→stale+具体blocker，v2记录逐字节不动。current唯一含义：实时重建全等+policy v2引用精确指向+上游反查通过。再验证走新requestId/revision+1链式；requestId幂等返回原件（需policy引用仍一致应用）。

## 持久化与policy

新表`project_owner_execution_revalidations`（additive，UNIQUE(project,revision)/(project,request_id)）。v2行绝不入旧表——AO05 parser对schemaVersion/stage硬抛，混入会冻结全项目v1读取。`PilotPolicy`新增可选`ownerExecutionRevalidation`引用（含materializationId/materializationIntegrityHash），`ownerExecutionPreparation`逐字节保留；两者均非授权。`saveOwnerRevalidationPolicy`仅在withPolicyLock内由service组合调用（mkdir锁不可重入），替换v2引用时校验v1引用与state逐字节不变。**v2存在时`saveOwnerPreparationPolicy`前置拒绝**——v1重存不能静默丢弃v2引用。

## 共存闭环

- v2存在→v1准备view短路非current（stale，"已被v2重新验证替代"）；联动使v1材料化入口（currentPreview要求v1 current）自动关闭。
- 材料化view在v2下保持needs_revalidation+显式v2 blocker，经分支(b)核验v2引用与本记录匹配、v2行存在且originalPreparation与冻结v1记录一致；悬空→显式stale不伪装。
- 证据谓词纳入v2表：原AO05 row丢失但v2/材料化/marker残余存在时，旧SourceGate（发行/预算/启动/claim/请求占额/草案）全部继续拒绝，不降legacy；发行确认指纹把v2引用纳入，v2出现后旧确认失效。
- view状态机：none/current/stale/unapplied。unapplied=DB已提交但policy未一致应用（如JSON部分失败）——重放显式拒绝，与v1同构，证据保留待核查；policy引用悬空→stale+悬空blocker。

## View三态锁定与负向边界

材料化get永不返回current；v1在v2下永不current；同项目无关任务/planning carrier不被v2误封（v2不改business谓词——v2不引入新任务身份）；`deleteProject`保护v2表；v2不产生Task/execution/session/grant/JSON之外的任何副作用，不开放资料工具/预算purpose/claim/Runner。

## 验证

- 后台v2模块10test38assert；UI/IPC/preload 17test；旧回归（材料化61、pilot四文件46、file-failure等）全过；独立审查2P1+5P2整改后复核收束（v1重存拒、幂等引用校验、deleteProject、悬空stale、unapplied显式化），无新repro问题；仅v2/材料化残余的显式SourceGate负向用例通过。全量579隔离文件0失败、typecheck/lint/docs/build通过。
- Native两轮：6ca90c0a（12/12）与delta 5ccf97ba（12/12、346源SHA与当前树0差异、tripwire全零、8截图各轮）；首 Rounded发现F1/F2已修复（面板changeReason输入+保存后历史自动重读），F3留待后续。见台账同日条目；本片不宣称完整生产导航、真实Provider、硬金额封顶、断电/多进程或安装验收。

实际许可发行、资料fence、逐请求Owner来源门禁、预算purpose、AO-06白名单调度/依赖推进、singleTask多step拆分与supersedes mapping、真实Provider仍需另审。
