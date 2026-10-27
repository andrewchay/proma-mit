# AO-G0 新增安全契约代码审查

日期：2026-10-17。审查对象为当前 `feat/owner-a02-a05-context-role` 工作树中的 AI Project Owner 新增/加固安全路径，重点核对模型输出不可信、来源与授权绑定、逐动作人工审批、未知费用和停止恢复、结果验收隔离。本文是代码与隔离测试审查记录，不是产品安全认证、第三方渗透测试或用户批准。

## 审查结论

在下列边界内，未发现可由当前代码直接证明的高危越权路径：模型不能自行创建有效执行授权；Owner Runtime 必须由专用 dispatcher 上下文启动并重新核验当前命令、execution、session、grant、冻结来源与员工配置；非只读 Owner 工具需要逐次人工审批，审批拒绝、来源失效、审计失败和会话中止均不执行；未知费用与待对账状态保留占额，不能自动重试或复活；技术评审和模型回报不直接完成业务 Task。

用户已于2026-10-17明确确认AO-G0产品/安全基线；Ledger中的AO-G0基线确认门禁据此通过。该确认不等于第三方安全审计或对真实Provider、实际用户审批点击、外部副作用、真实费用/停止行为的验收；固定构建导航与真实执行证据仍属于AO-G2/G3未完成项。

## 核对的强制边界与证据

| 契约 | 源码核对 | 负向/恢复证据 | 审查判断 |
|---|---|---|---|
| 规划不是授权 | `project-owner-planning-protocol.ts` 将交付差异声明为建议；计划确认、Goal保存与执行准备仍走不同服务；来源快照使用当前目标/计划/准备修订 | `project-owner-plan-service.test.ts`、`project-owner-planning-protocol.test.ts`、`project-owner-execution-preparation.test.ts`覆盖无授权状态不建 command/execution/request、错误/伪造交付标准拒绝 | 无发现。不能从schema通过推导用户已授权或内容已实施 |
| 源码上下文须显式开放且绑定工作区 | `project-owner-code-locator.ts`只对绑定工作区做受限检索；Goal上的`codeSourceAccess`由用户显式选择；协议校验来源候选和引用 | Owner code locator、plan service及protocol BDD覆盖未授权、无命中、越界/伪造引用和来源漂移 | 无发现。检索/脱敏属于有限词项规则，不是通用秘密扫描；源码片段会进入用户明确授权的规划请求 |
| 执行使用冻结身份与版本 | `project-owner-execution-start.ts`重验grant状态/期限/policy、revalidation/materialization指纹、Task/link/dependencies、员工配置与command绑定；`assertOwnerCommandRuntimeContext`另外绑定execution/session/start-attempt/gate | Stage B覆盖来源篡改、过期/撤权、并发claim、旧ack和无执行确认拒绝 | 无发现可证明的跨项目或过期授权绕过 |
| Owner敏感工具逐次审批 | `agent-orchestrator.ts`只从Owner dispatcher context注入审批身份；`agent-permission-service.ts`对Owner非只读工具绕过普通safe/whitelist/auto放行，拒绝“始终允许”；`project-owner-action-approval.ts`在SQLite事务核验command/execution/session/active未过期grant及参数指纹 | AgentPermissionService、AI SDK Runtime、Stage B账本与Renderer BDD覆盖拒绝零副作用、逐次允许/拒绝、拒绝白名单、无动作正文落库、来源变化失效；恢复扫描将pending记录置为invalidated | 无发现绕过路径。代码/隔离测试不能证明完整产品渲染、人工点击与真实外部接收方行为 |
| unknown/停止/崩溃 fail-closed | `project-owner-execution-stop.ts`重启后原子暂停grant、置stale、标记pending审批失效并以unknown结算；晚到回调需继续服从execution状态 | Stage B独立子进程晚回调BDD；`project-owner-native-recovery.test.ts`用Node及Electron run-as-node/better-sqlite3 WAL覆盖恢复事务提交前后强杀、重启复核和空结果重扫，共32断言 | 已有原生数据库/进程恢复证据；仍不是完整Electron GUI重启或Provider停止证据 |
| 执行结果与业务验收隔离 | Owner交付面板区分执行回报、结构化Reviewer结果与人类业务验收；计划差异评估只作为后续提案 | Stage B及Renderer测试覆盖命令错配隐藏回报、技术批准不改Task业务状态、结构化反馈绑定来源 | 无发现自动把模型自述提升为验证/验收的路径 |
| 研发交付写回拒绝 | `development-apply-service.ts`预检操作有独立拒绝终态；Owner Runtime 写文件仍由逐动作权限流控制 | Development apply BDD核对拒绝前后目标文件、HEAD和Git状态一致；Owner工具拒绝用例断言执行器调用数为0 | 本地路径拒绝证据充分；没有真实业务仓库写回验收 |

## 尚未由本审查证明

- 真实Provider费用、供应商账单、实时停止和远端副作用；相关测试使用隔离数据库、fake transport或原生本地SQLite。
- 固定构建里的主窗口导航、渲染进程真实审批点击、应用崩溃重启及操作回执呈现。AO-A02 UI走查按用户决定暂留待验收。
- 广泛的文件系统/Provider/多进程竞态渗透测试、依赖供应链审计和第三方独立复审。
- 代码检索的通用凭据识别；当前遮盖规则是有限模式，不能承诺发现任意秘密格式。
- 所有新计划版本、全部多进程组合与Windows/Linux原生Runtime的故障矩阵。

## 可复核测试入口

- `apps/electron/src/main/lib/project-owner-plan-service.test.ts`
- `apps/electron/src/main/lib/project-owner-planning-protocol.test.ts`
- `apps/electron/src/main/lib/project-owner-execution-preparation.test.ts`
- `apps/electron/src/main/lib/project-owner-execution-stage-b.test.ts`
- `apps/electron/src/main/lib/agent-permission-service.test.ts`
- `apps/electron/src/main/lib/agent-runtime/ai-sdk-runtime-core.test.ts`
- `apps/electron/src/main/lib/project-owner-native-recovery.test.ts`
- `apps/electron/src/main/lib/development-apply-service.test.ts`

审查针对当前未提交工作树；本审查没有执行真实Provider、费用操作、用户仓库写入或外发。

## 后续补充：审批审计写入失败

复核审批入口时发现，Owner敏感动作的`onRequest`账本写入若失败，会使权限回调直接reject。虽然该路径不会返回allow，但错误形态不如普通权限结果明确。现已捕获该异常并显式返回deny；不向Renderer发送未审计请求、不建立pending权限项、不调用动作工具。定向BDD覆盖SQLite不可用时的明确拒绝，AgentPermissionService 23项/83断言通过；全workspace typecheck、完整`bun run build`通过，构建仍有既有警告。该补充只加强隔离权限回调的fail-closed可读性；固定构建真实审批点击、真实外部接收方与Provider费用/停止仍未验收，原审查结论边界不变。
