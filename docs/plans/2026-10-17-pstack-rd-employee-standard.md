# pstack 到 Gravitas 研发员工规范映射

> 状态：方案草稿，尚未实施
> 日期：2026-10-17
> 上游：`backnotprop/pstack`，固定 revision `6f131f137de64fdaf928278c0fd9ecec520ccbee`
> 范围：把 pstack 的工程实践转成 Gravitas 可版本化、可评测的研发员工工作规范。

## 决策建议

以**研发员工标准**作为主要承载方式。pstack 是规范和流程的来源，不把 54 个 Skill 全量拼进 Runtime 的基础 system prompt，也不把约束只放进一个员工的 `systemPrompt`。

需要区分两种职责：

- **代码负责强制边界**：Runtime 能力、权限、研发 worktree、启动门禁、工作区约束和可采集的交付证据由代码控制。提示词不能代替权限检查或运行时验证。
- **员工规范负责工作方法**：如何调查、拆分变更、修复、验证和报告，作为有版本的研发角色能力，在研发员工任务执行时加载。
- **任务流程和 Skills 负责按需展开**：只有遇到相应任务时才加载调试、架构、性能、审查等详细流程和参考材料。

## Gravitas 当前已有的承载点

| 当前能力 | 代码位置 | 对本方案的作用 |
| --- | --- | --- |
| 研发员工执行配置 | `AgentEmployee.executionProfile: 'development'`，`project-types.ts` | 把研发员工与普通员工、`controlled` 受控流程区分开。首轮只作用于 `development`。 |
| 研发任务提示词 | `agent-employee-service.ts:buildAgentTaskPrompt()` | 已包含角色、任务、权限说明、项目 DoD 和交付说明，可拼入规范版本。 |
| 执行时冻结角色能力 | `agent-employee-service.ts:enqueueAgentTask()` | 已加载员工与工作区范围的活动能力版本，记录 `capabilityVersionIds` 和内容 hash，并把内容冻结进执行 prompt。 |
| 能力评测、灰度与回滚 | `agent-employee-capability-*`、`agent-runtime/eval/` | 可让新规范版本先成为候选，经过评测/灰度后采纳；失败率、返工率和回滚有现成概念。 |
| 研发隔离与证据 | `agent-development-worktree.ts` | 代码创建独立 Git worktree，捕获基线、HEAD、分支和验证记录；这类保障不应改成提示词约定。 |
| 项目级完成条件 | `agent-development-context.ts`、Project Chain | 将项目与任务 DoD 注入研发执行，作为规范之外的项目验收条件。 |
| AI 员工岗位模板 | `apps/electron/resources/employee-role-templates.json`、`agent-employee-form.ts`、`AgentTeamPanel.tsx` | 现有模板应用时统一设为 `controlled`；研发员工入口则单独硬编码名称、描述与 `development` 配置。不能直接把当前岗位模板当成研发标准入口。 |
| 能力版本操作 UI | `AgentTeamPanel.tsx`、`work-module-ipc-handlers.ts` | 当前可查看、评测和回滚能力版本，但没有一个面向用户的“创建任意研发标准版本”入口。该系统按员工保存能力版本，不能直接充当跨员工的标准库。 |

**重要边界：**目前角色能力版本是按员工保存的，不是一个天然共享的全局规范对象。首轮可选一个研发员工建立并验证角色版本；若要让所有研发员工共享同一权威版本，再增加可复用的“研发标准版本”引用，避免复制粘贴到每个员工后无法统一升级。

## pstack 内容映射

| 处理层 | pstack 来源 | Gravitas 的承载方式 | 加载时机 |
| --- | --- | --- | --- |
| 研发规范基线 | `principle-boundary-discipline`、`principle-fix-root-causes`、`principle-model-the-domain`、`principle-outcome-oriented-execution`、`principle-prove-it-works`、`principle-sequence-verifiable-units`、`principle-test-behavior-not-implementation`、`principle-type-system-discipline`、`principle-minimize-reader-load` | 提炼为短小、可执行的研发员工角色能力版本。保留要求和证据边界，不照搬口号或要求 Agent 在最终回答逐项背诵原则名称。 | 所有 `development` 员工任务。 |
| 调查与根因流程 | `why`、`how`、`interrogate`、`figure-it-out` | 任务流程或按需 Skill：先收集可复核事实，再区分行为、原因、假设与未知。 | 故障调查、未知代码路径或范围较大的工作。 |
| 变更设计 | `architect`、`arena`、`principle-exhaust-the-design-space`、`principle-redesign-from-first-principles`、`principle-model-the-domain` | 设计流程模板；要求先明确数据形状、边界和验收，再决定是否需要方案比较。 | 新功能、跨模块改动、架构选择。 |
| 调试与回归 | `tdd`、`principle-fix-root-causes`、`principle-test-behavior-not-implementation` | 可复用流程，测试策略根据真实可复现路径选择，不把“必须新增测试”作为每个任务的硬指标。 | 可复现缺陷或有明确、低成本行为断言的改动。 |
| 影响与兼容性审查 | `blast-radius`、`principle-boundary-discipline`、`principle-separate-before-serializing-shared-state`、`principle-migrate-callers-then-delete-legacy-apis` | 变更检查单，与代码 diff、调用方和真实行为核验结合。 | 共享协议、数据格式、并发状态、适配器或迁移改动。 |
| 性能工作 | `benchmark-checklist`、`automate-me`、`principle-explain-the-number` | 有基线、测量口径、重复性和原始结果的性能流程。 | 用户要求性能优化或需要报告性能数字时。 |
| 交付证据 | `show-me-your-work`、`principle-prove-it-works`、`principle-sequence-verifiable-units` | 执行记录引用真实 diff、命令/运行记录和结果；模型自述不能替代 Runtime 采集证据。 | 多阶段、无人值守或需要复核的研发执行。 |
| 文档与沟通 | `technical-writing`、`unslop`、`in-your-own-words`、`principle-minimize-reader-load` | 写作 Skill 或文档流程；不要给所有代码任务增加文风规则。 | 文档、注释、发布说明和面向人的交付说明。 |
| 可选专项能力 | 其余 Skill，包括 `make-bot-ui`、`typescript-best-practices`、`create-verification-skill`、`maintain-verification-skill`、`recall`、`teach`、`correct`、`ketchup`、`bro`、`sharpen` 等 | 保留在 Skill 市集中，按用户请求、员工配置或任务上下文显式选择；维持上游独立 Skill 的完整内容和配套文件。 | 只有任务确实需要时。 |
| 不默认执行的控制型 Skill | `poteto-mode`、`setup-pstack`、`swarm`、`reflect`、`poteto-help` | 作为可选入口或人工触发能力。评估其对特定模型、子 Agent、GitHub 工作流和成本的假设后再集成。 | 用户明确选择，或经评估确认当前 Runtime 支持时。 |

上表只定义“放在哪一层”，不是声称这些原则已经由 Gravitas 代码保证。特别是“验证后再报告”需要结合 Runtime 证据；单靠提示词不能证明命令确实执行、文件确实写入或交付达到临床/业务验收。

## 修改规划

实施原则：先建立一个受 `executionProfile='development'` 控制的共享规范，再用一名研发员工做试点。规范本身由 Runtime 统一注入；员工角色描述、角色能力版本和项目 DoD 继续分层提供。不要把 pstack 的全量 Skill 集合塞到员工提示词或底层 system prompt。

### 阶段与交付

| 阶段 | 工作项 | 修改范围 | 完成条件 |
| --- | --- | --- | --- |
| P0 规范定稿 | 明确研发标准 v1 的条文、冲突优先级、版本规则；固定基线任务与独立验收口径。 | 本方案；新增评测任务清单和验收 rubric。 | 规范不超过一页核心规则；每条规则有可观察行为或证据；评测任务与通过阈值在看结果前冻结。 |
| P1 标准资源 | 建立有 `id`、`version`、内容 hash、来源 revision 的研发标准资源。核心规则从 pstack 改写，保留溯源，不直接复制 54 个 Skill。 | `apps/electron/resources/development-employee-standard.json`（暂定）；资源校验和版本读取模块。 | 包内资源可读取；缺失、hash 不符或版本不支持时 fail closed，不静默以旧版冒充新版。 |
| P2 Runtime 注入 | 在通用的研发员工任务提示词构建中，仅对 `development` profile 注入标准。明确代码授权 > 项目/工作区限制 > 研发标准 > 员工角色补充 > 任务正文/引用数据的优先级；较低层不能放宽较高层约束。 | `agent-employee-service.ts:buildAgentTaskPrompt()`；独立标准装配函数及其 BDD 测试。 | `general`、`controlled` 不受影响；四类 Runtime 收到相同规范内容；项目 DoD、员工角色及权限提示仍保留。 |
| P3 执行留痕 | 将标准 `id/version/hash` 写入排队时冻结的执行记录，并在交付/执行详情显示；保留完整 prompt 快照以支持重放核对。 | `project-types.ts`、`packages/shared/src/types/work-module.ts`、`project-sqlite-store.ts` schema/migration、`AgentTeamPanel.tsx`、`TaskExecutionEvidence.tsx`。 | 任一执行都能查出使用的标准版本和 hash；旧记录显示“未记录”，不推断其使用了当前版本。 |
| P4 试点评测 | 选定一名安全研发员工，在固定 Runtime、模型、权限和仓库下跑冻结任务集；由不知版本的验收人评审交付。 | 评测用例、执行记录、盲评表；复用当前 capability health 作辅助，不把按员工的 canary 冒充共享标准 canary。 | 主指标、样本量、阈值和停止规则预先确定；报告逐任务证据、拒收原因、返工和未验证项。 |
| P5 发布门 | 先仅在开发构建或一个明确试点员工启用；达标后才对全部 development 员工开放。提供标准版本回滚方式。 | 研发 profile 的标准启用策略；版本变更记录与发布说明。 | 试点验收签字；回滚后新执行使用前一版且记录准确；旧执行仍保留原始快照。 |
| P6 按需流程 | 只把高价值流程做成任务路由：缺陷调查、功能/重构、性能任务。其余 54 个 Skill 保持市集可选。 | `agent-development-context.ts` 或独立任务分类器；后续评估再决定是否加 UI。 | 路由错误可见、可覆盖；无关任务不加载长流程；实际运行证明该流程被执行后才标为完成。 |

### 计划中的研发标准 v1 内容

首版控制在以下 7 条，不承诺自动遵守的底层安全能力：

1. 开工前识别目标、交付物、范围和可检查的完成条件；缺少会改变方案的事实时指出阻塞。
2. 先检查仓库规则、现有实现和相关调用路径；修复缺陷时优先建立可复现证据，再定位根因。
3. 选择满足目标的最小完整改动，保留无关变更；不为使用新架构而扩大范围。
4. 验证选择遵循用户与仓库要求。测试新增或运行需符合明确授权；测试不适用时用最接近的直接证据，并说明限制。
5. 报告区分实际运行的检查、静态检查、代码推断和未验证项；模型自述不作验证证据。
6. 交付说明包含改动路径、结果、验证证据、遗留风险；不声称代码已合并、发布或业务验收。
7. 不得从提示词推导出文件写入、网络访问、命令执行、权限升级、提交、合并或发布授权；这些由现有门禁和用户授权决定。

标准 v1 的用户可见性应说明：它由 `development` profile 自动应用；员工角色与项目规则可补充更具体要求，但不能解除第 7 条或 Runtime 门禁。现有研发员工的 `systemPrompt` 不应被静默覆盖。

### 评测设计

- 任务集至少覆盖缺陷修复、局部功能和不应修改代码的调查任务；加入权限冲突和“模型可能声称验证但实际未执行”的负例。
- 对照组与候选组使用同一员工、Runtime、模型、权限、基线 commit、任务输入和验证环境；只改变研发标准版本。
- 主要结果：独立验收结论与返工；辅助结果：失败/取消、证据完整度、执行耗时和成本。成本或耗时不替代正确性。
- 验收人在不知道组别的情况下按同一 rubric 评审 diff、实际运行证据与完成说明。样本量和通过阈值由产品负责人在开跑前填写台账；样本不足只记“证据不足”。
- 立即停止条件：绕过权限或项目规则、伪报执行证据、污染主仓库、跨越任务范围做不可逆操作。停止后保存证据并恢复旧标准。

## 实施台账

状态说明：`完成` 只表示该台账项已完成；`待办` 表示尚未开始；`待决` 需要产品负责人作出选择。日期和实际负责人未确认前不虚填。

| ID | 事项 | 交付 / 涉及文件 | 负责人 | 依赖 | 验收 / 关闭条件 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| RDS-00 | 核对现有研发员工、能力版本、执行快照和 pstack 来源 | 本文件“承载点”和“内容映射” | Codex | 无 | 明确区分 `development` 与 `controlled`；确认 54 个 Skill 不全量注入 | 完成 |
| RDS-01 | 冻结标准 v1 条文与优先级 | 本文件“研发标准 v1 内容”定稿 | 产品负责人 | RDS-00 | 每条规则都能由任务结果或 Runtime 证据判断；人工确认规范与项目规则冲突原则 | 待决 |
| RDS-02 | 选择试点员工、项目、Runtime、模型和任务集 | 本地 Git 项目；至少三类任务及负例 | 产品负责人 + 研发验收人 | RDS-01 | 记录 employeeId、workspaceId、Runtime/model、基线 commit、任务输入 hash、独立验收人 | 待决 |
| RDS-03 | 实现版本化标准资源与验证器 | `apps/electron/resources/development-employee-standard.json`；标准读取模块 | Gravitas 实施者 | RDS-01 | 有固定版本/hash；无效或缺失时有显式错误；不读任意员工/项目文件覆盖标准 | 待办 |
| RDS-04 | 接入研发 prompt，并保留当前角色与 DoD | `agent-employee-service.ts`；`agent-development-context.ts` | Gravitas 实施者 | RDS-03 | 仅 `development` 应用；项目 DoD 与员工自定义 prompt 不丢失；其他 profile 行为不变 | 待办 |
| RDS-05 | 冻结标准版本到执行记录并展示 | types、SQLite migration/store、`TaskExecutionEvidence.tsx` | Gravitas 实施者 | RDS-03 | 新执行保存标准 id/version/hash；旧执行兼容且标记来源未知 | 待办 |
| RDS-06 | 补充行为和兼容测试 | 新增 `agent-employee-development-standard.test.ts`、schema migration / UI tests | Gravitas 实施者 | RDS-04、RDS-05 | 覆盖 profile 选择、冲突顺序、旧记录、版本快照；断言外部可观察行为 | 待办 |
| RDS-07 | 冻结基线并执行盲评 | 评测任务包、评分表、执行证据 | 研发验收人 | RDS-02、RDS-06 | 阈值先冻结；逐例留结论与证据；区分模型声明和实际执行 | 待办 |
| RDS-08 | 审查试点结论并决定发布或回滚 | 决策记录；标准版本启用记录 | 产品负责人 | RDS-07 | 达标才扩大；未达标则回滚或修订并重跑；样本不足不推广 | 待办 |
| RDS-09 | 评估按需流程路由和跨员工标准管理 | 单独后续方案 | 产品负责人 + Gravitas 实施者 | RDS-08 | 证明共享版本/自动路由解决真实维护问题后才立项 | 暂缓 |

## 下一步顺序

1. 先由产品负责人确认 `RDS-01` 的标准内容、冲突优先级和停止条件。
2. 选一名现有 `development` 员工和有本地 Git 根目录的试点项目，填写 `RDS-02`；不选择 `controlled` 员工或活动 Pilot 项目。
3. 再按 `RDS-03` 到 `RDS-06` 实施最小 Runtime 接入，并在实现阶段遵循仓库自身的测试授权要求。
4. 收齐盲评证据后填写 `RDS-07`，由负责人在 `RDS-08` 选择发布、回滚或证据不足。
5. 暂不做 54 个 Skill 的自动路由，也暂不做跨员工可编辑规范管理；这两项等首轮试点证明需求后再决定。

## 不纳入首期

- 不将全部 54 个 Skill 内容拼进基础 system prompt。
- 不要求每个研发任务都跑完整 TDD、架构比较、性能基准或子 Agent 协作流程。
- 不以“员工都安装了 pstack Skill”作为遵循规范的证据。
- 不修改 Runtime 权限、Git worktree、提交授权、Pilot 预算或现有隔离策略来实现提示词行为。
- 不把模型最后的“测试通过”文字直接记成已验证证据。

## 验收问题

进入实现前，应能回答：

- 规范的权威版本由谁维护、如何升级和回滚？
- 每次执行能否查到确切的规范版本和项目级 DoD？
- 运行结果如何区分模型声明与 Runtime 采集证据？
- 试点评估用哪些真实任务、独立验收和预先设定的通过标准？
- 若规范与项目规则冲突，如何报告冲突并停止，而不是让 Agent 自行覆盖？
