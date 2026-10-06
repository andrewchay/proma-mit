# 文件任务委派与人工 Review 闭环实施方案

> 执行交接：使用当前工作区 `executing-plans` Skill，按阶段推进并在各门禁提交证据。本文件是待实施方案，不代表代码已经实现或获准执行外部操作。

**Goal：** 用户从文件或项目任务出发，把小范围代码／文本修改交给研发 AI 员工；在任务页查看真实差异与验证记录，提出返工意见，并在确认后将已审阅版本应用到原工作区。

**Architecture：** 复用 Task → AgentExecution → Session → Git worktree；复用 ProjectChain 的交付版本、人工验收和 DoD，不新建平行任务系统。新增文件委派入口、不可变交付快照、受限员工提交入口及本地应用服务；Git 与数据库之间使用可恢复操作记录，不声称跨系统原子事务。

**Tech Stack：** Electron／TypeScript／Bun／React／Jotai／现有 DiffView；项目 SQLite 保持权威，快照和证据使用会话目录 JSON／文本文件。不预设新增 npm 依赖。

**截至：** 2026-09-25 00:42 GMT+8；调研 HEAD `c3e3854f`。关联：[测试方案](test-plan.md) · [实施与验收台账](ledger.md)。

---

## 1. 产品范围与完成定义

### 1.1 首版覆盖

- 单机、单 Git 仓库、明确工作区、单个研发员工执行一个 Task。
- UTF-8 代码和文本文件，包括 Markdown；允许新增、修改、删除普通文本文件。删除必须在应用确认中逐项明确展示。
- 从文件菜单创建任务，或关联同项目已有且未运行的任务；保留原 taskId，不复制出第二个任务。
- 首次派发只接受干净仓库。未提交改动不自动 stash、提交、丢弃或复制。
- 一次完整流程包含至少一次返工，并保留原会话、原 worktree、全部交付版本。
- 先支持一个真实验证过的 Runtime＋渠道＋模型组合，其他组合标为未验收。
- Review 通过后，用户单独确认“应用到原工作区”；首版落为未提交改动，不创建 commit、不切分支、不 merge、不 push。

### 1.2 明确不做

- 非 Git 文档目录、Word／Excel／PDF 二进制对比和修订；跨仓库任务；多人远程身份认证。
- 自动依赖安装、共享 node_modules／凭据、自动解冲突、自动清理 worktree、自动外部发送或发布。
- 脏仓库快照派发、部分 hunk 接受、Git 子模块、LFS、符号链接及可执行位变更；遇到这些内容阻止应用，解释原因。
- 新的员工编队、自动学习体系、工作流引擎；不借此次重构既有普通员工。
- “任意任务都无需中途参与”的承诺；审批、预算、缺依赖和产品决策仍可阻塞。

### 1.3 用户验收标准

1. 从文件到派发，不手动复制绝对路径，不重复填写已知项目／工作区。
2. 在同一任务 Review 页看完变更文件、Diff、测试状态、风险与返工意见。
3. 退回后员工在原工作上继续；旧版本仍可读，旧的验收不能用于新版本。
4. 通过的是一个冻结内容版本，而非正在变化的工作目录。
5. 应用成功后，原工作区内容与已验收快照一致；任务完成仍通过现有 DoD 闸门。
6. 源目录已有改动、HEAD 漂移、员工越界修改、测试失败或证据缺失，均不能显示虚假成功。
7. 标准样例允许一次派发确认和最终 Review／应用确认；常规执行中若发生额外人工介入，必须计入台账，而不是从成功样本中隐去。

## 2. 已有能力与新增断点

| 内容 | 已核查入口 | 判断 |
|---|---|---|
| 文件菜单 | `apps/electron/src/renderer/components/file-browser/FileBrowser.tsx` | 有添加到聊天等操作，需增加任务委派回调 |
| 工作区文件宿主 | `apps/electron/src/renderer/components/agent/SidePanel.tsx` | 已能定位工作区／会话文件，必须区分仓库文件和会话产物 |
| 员工与任务创建 | `AgentTeamPanel.tsx`、`ProjectView.tsx` | 有研发模板、工作区选择和 AI 指派 |
| 执行与返工 | `apps/electron/src/main/lib/agent-employee-service.ts` | 会话、worktree、结果回写可复用 |
| 隔离与证据 | `agent-development-worktree.ts` | Git 基线／统计已有；测试明确标记为未核验 |
| Diff 展示 | `apps/electron/src/renderer/components/diff/DiffView.tsx` | 可复用 oldContent／newContent 组件，不重建渲染器 |
| 项目绑定 | `ProjectWorkspacesPanel.tsx`、`project-workspace-bindings.ts` | 仅知识检索授权，不是自动共享文件或执行授权 |
| 交付验收 | `project-chain.ts`、`project-chain-service.ts` | 具备版本、责任、DoD；存在员工提交身份衔接缺口 |
| 执行记录入口 | `TaskExecutionEvidence.tsx` | 当前以摘要、路径及会话跳转为主 |

**关键新增发现：** `updateProjectChain()` 固定以 `local-user` 操作，而 `applyChainCommand()` 要求保存／提交交付的 actor 等于负责人。AI 任务负责人为 `agent-<id>`，现有审批用户目录默认只有 `local-user`。不能直接用现有人工保存接口生成员工交付，也不能通过伪造客户端 actor 绕过。交付还必须关联真实决策；不能为了 UI 顺畅自动捏造“已批准”决策。

## 3. 关键设计决定

### D1：文件是任务定位信息，不是任意路径授权

Task 新增可选 `developmentScope`：`workspaceId`、`targetPaths`、`allowedPaths`、`reviewerId`、`decisionIds`、`verificationCommands`。前两组路径均为仓库相对路径，目标文件与可修改范围分开：例如目标是 `src/format.ts`，允许范围还应包含相邻测试和指定文档。

- 请求只传 ID 和相对路径；主进程从工作区与员工档案解析绝对目录，不信任 renderer 传入 cwd／repository／actor。
- 拒绝 `..`、绝对路径、NUL、Git 控制目录、目录外 symlink；使用 realpath 与逐级父目录核验。新文件也必须核验其最近存在父目录。
- 首版限定单工作区；遇多项目绑定需选择，不能按名称推断所属关系。
- 关联已有任务需检查项目、状态、负责人、工作区、版本；变更已有人类负责人的任务要明确告知并确认。
- 项目没有工作区知识绑定时可提示，但不默默创建授权；文件执行目标与知识绑定分别展示。
- 默认排除 `.env*`、密钥／凭据、`.git/**`、`AGENTS.md`、`.context/**`、锁文件等受保护项；确需修改则走另一次范围确认，不自动放宽。

### D2：受限员工提交，人工验收不被替代

复用项目交付链，新增仅主进程运行完成回调能调用的 `submitDevelopmentDelivery(executionId)`：

1. 从权威 execution 反查 task／employee／session／workspace；检查执行已完成、员工仍启用且仍是任务负责人，停止／失败／改派的运行不能提交。
2. 验证冻结快照、关联决策、显式人类 reviewer 和完整 DoD。缺决策时在派发前让用户选择已有决策，或确认一条真实的低风险任务决策；不得自动批准关键 DACI 决策。
3. 扩展链路服务的内部身份校验：员工 principal 仅来源于真实员工档案且仅能保存、提交该次运行的交付。继续保存 `ownerId=agent-<id>`，reviewer／recipient 为已启用的人类身份。
4. 不把员工自动写入审批用户目录，不授予 accept／handoff 权限，不开放客户端 actor 参数。公共人工入口仍固定 `local-user`。
5. 新的受限提交路径强制停在 `submitted`，即使项目配置了确定性自动验收也不自动 accept；原有非研发交付行为不变。
6. 对同一 execution 重复回调必须幂等。返工使用同一 deliverableId 的新版本，保存原因并冻结本轮 executionId；不覆盖旧版本。

这是有边界的身份规则扩展，必须先通过恶意请求与旧链路兼容测试，再做 UI。

### D3：审阅不可变快照，不审阅活目录

新增 `DevelopmentSnapshot`：`id / taskId / executionId / workspaceId / baseCommit / contentHash / files / validationRefs / createdAt`。每个文件包含相对路径、变更类型、旧新内容 hash 及只读内容引用。

- 冻结范围覆盖 baseCommit 到当前工作目录的最终内容：已提交、暂存、未暂存及允许的未跟踪文件，不能只读 unstaged diff。
- 使用隔离临时 Git index／对象树或等价实现生成精确补丁；不得修改员工或用户的真实 index。实现阶段先用新增／删除／已提交改动的契约测试确定算法。
- 只采集允许范围的普通 UTF-8 文件；首版建议上限单文件 1 MiB、总计 10 MiB、100 个文件，超限明确阻塞，不以截断内容供验收。上限集中配置并测边界。
- 未授权文件出现在 diff 中则阻止提交，不能悄悄过滤后声称整个任务通过。
- 工具审批不是 OS 沙箱；这些检查保障交付和应用边界，不宣称员工进程无法访问其他目录。
- 交付版本引用 snapshotId＋contentHash。Review 页面读取冻结内容；worktree 后续变化不能改变已审阅证据。

### D4：验证证据和模型自述分开

`DevelopmentValidation` 保存 command、cwd、开始结束时间、exitCode、timeout／cancel 状态、输出摘要及完整日志引用、被验证内容 hash。

- 模型回复里的“测试通过”只能标为 reported，不得转换为 verified。
- 用户派发时确认验证命令；仅对已授权的命令通过现有审批／受控命令执行链路采集真实退出码。执行项目脚本可能运行任意代码，不能伪装成无副作用读取。
- 验证前后内容 hash 不一致，结果作废为 stale，需重新冻结／验证。
- failed、cancelled、not-run、skipped、stale、reported 明确分开；本次配置为必需的验证非 passed 时禁止接受。
- 无需运行程序的文档任务，可由用户在派发时选择人工文本核对标准；不能把 N/A 当作测试通过。
- 缺依赖显示具体卡点，不自动安装。后续授权安装仍须先查依赖版本且禁止复制凭据。

### D5：先确认应用，不做自动合并

服务接口建议为 `prepareApply(deliveryId, version)` 与 `confirmApply(operationId)`；不接受任意 shell 命令、分支名或仓库路径。

1. prepare：检查当前交付已被人类验收、内容 hash 和权限范围有效、任务未改派；目标仓库身份、当前分支和 HEAD 必须与派发时基线一致，工作区及 index 干净。
2. 返回本次精确文件集合、删除项、目的工作区、contentHash 和有效期。确认按钮明确“写入这些文件，保留为未提交改动”；确认由 UI 发起，不作为员工工具暴露。
3. confirm：重新读取以上所有事实，并获取应用级仓库互斥锁；确认上下文发生变化则拒绝。不能只依赖旧 preview 的检查。
4. 对冻结补丁做 `git apply --check`，通过后再应用。不对 live worktree 打补丁；不运行 Git hooks、不自动 commit。应用前持久化操作意图及预期前后 hash。
5. 操作状态为 `prepared → applying → applied / blocked / recovery_required`，这是文件应用记录，不替代交付验收状态。
6. 应用后逐文件核对 hash、删除状态与 index 未变化，再标 applied。应用中断后重开按实际内容判断：全旧可重试、全新补记成功、混合态进入 recovery_required；不自动 reset／覆盖恢复。
7. 应用级锁无法阻止外部编辑器写文件，因此后验 hash 和恢复态不可省略。安全承诺是检测并停止，不是文件系统原子性。
8. applied 不等于 git committed／merged。随后走现有任务完成／DoD 闸门；失败则显示“文件已应用，任务未完成”，保留可重试状态，绝不重复应用。

### D6：存储与升级

- Task 的 scope 通过项目 SQLite 增量列保存，旧记录缺省为空；不迁移 JSONL 消息或替换现有权威数据。
- ProjectChain 继续保存交付状态与版本；只增加 snapshot 引用及员工提交的来源字段。
- 应用操作记录保存在项目 SQLite，快照／验证日志保存在现有会话私有目录。建议唯一约束 `(deliveryId, version, snapshotId)` 与幂等操作键。
- 先原子写入并校验快照文件，再事务写入引用；失败遗留的孤立文件保留待清理，不形成“已提交”假记录。
- 启动时核对未结束的应用记录；记录指向缺失文件则阻塞。备份需要同时包含项目数据库及被引用的会话证据目录。
- 旧交付、普通员工、Workflow 路径不自动升级或重新执行。

## 4. 实施任务与代码落点

每项统一采用：①新增一个失败 BDD 用例；②单文件运行确认 FAIL；③最小实现；④复跑至 PASS；⑤补异常边界；⑥记录证据并评审 diff。表内新文件均为拟新增，不是现有能力。

### M0／W00：隔离样例与基线（0.5–1 工程日）

- 新增 `scripts/task-review-smoke.ts`：仅接受显式临时配置根和临时测试仓库，拒绝真实 `~/.gravitas/`；准备一个纯函数 Bug 和一个 Markdown 任务。
- 新增 `apps/electron/src/main/lib/development-review-fixture.test.ts`，验证 fixture 可重建、清理不触及真实目录。
- 复跑现有三个研发测试文件，并保留原始日志、HEAD 和隔离目录检查结果。
- 执行代码前先确认当前用户未提交改动的处理方式，不能自行提交或清空。另建 worktree 后须先绑定会话；当前 HEAD 不包含用户未提交修改。
- 退出门禁 G0：现有链路基线明确，fixture 与预算／渠道选择已准备。

### M1／W01–W03：任务范围、快照和员工交付（2–3 工程日）

修改：
- `packages/shared/src/types/work-module.ts`、`packages/shared/src/types/project-chain.ts`；新增 `packages/shared/src/types/development-review.ts` 并从 `types/index.ts` 导出。
- `apps/electron/src/main/lib/project-types.ts`、`project-sqlite-store.ts`、`agent-development-context.ts`。
- `project-chain.ts`、`project-chain-service.ts`、`agent-employee-service.ts`。

新增：
- `development-task-service.ts`：scope／任务关联／预检，不复制员工调度器。
- `development-snapshot-service.ts`：冻结变更、范围校验与内容读取。
- `development-delivery-service.ts`：受限提交、版本关联和幂等。
- 对应 `.test.ts`，并扩展 `project-chain-service.test.ts`。

先跑 T01–T09、T13、T17–T19，再实现。必须证明员工可以提交但不能自验收，客户端伪造 actor／路径失败。依赖 W01 范围契约 → W02 快照 → W03 提交。

### M2／W04–W06：文件入口、Review 与返工（2–3 工程日）

修改：
- `packages/shared/src/types/work-module.ts` 的 IPC 常量；`apps/electron/src/main/lib/work-module-ipc-handlers.ts`；`apps/electron/src/preload/index.ts` 的类型与桥接，两处一起更新。
- `FileBrowser.tsx` 增加可选委派回调，`SidePanel.tsx` 传入真实工作区上下文，不让通用文件树直接操作项目数据库。
- `ProjectView.tsx`、`projects/kanban/TaskDetailDialog.tsx`、`TaskExecutionEvidence.tsx` 加入同一个 Review 入口。

新增：
- `renderer/components/projects/DelegateFileTaskDialog.tsx`。
- `renderer/components/projects/TaskReviewPanel.tsx`：摘要、文件列表、现有 DiffView、验证状态、版本历史和操作按钮。
- `renderer/atoms/development-review-atoms.ts` 与纯状态测试；任务主数据继续使用既有 project atoms。
- `main/lib/development-review-service.ts`：Review 查询、人工接受／退回；返工原子记录意见＋幂等派发请求，再复用既有调度函数。

UI 为单一任务页：`准备／运行／等待审批／待 Review／返工中／已验收待应用／已应用待完成／完成／恢复待处理` 是权威状态派生展示，不增加另一套 Task 状态字符串。DoD 有逐条勾选与验收依据，不做空白“一键通过”。

先跑 T10–T12、T14–T16、T25–T26。重开应用、切换任务后不能丢失权威状态；禁用重复点击和跨任务残留。

### M3／W07–W08：验证证据与确认应用（2.5–4 工程日）

- 新增 `main/lib/development-validation-service.ts` 及测试。实现前确认实际 Runtime／命令执行适配器的退出码来源；没有可靠来源就显示未验证，不解析模型文本假充结果。
- 新增 `main/lib/development-apply-service.ts`、`development-apply-service.test.ts`；扩展项目 SQLite 应用记录及恢复查询。
- 扩展既有 IPC／preload／Review atoms，不增加员工可调用的接受／应用工具。
- 使用临时真实 Git 仓库覆盖 T20–T24、T27–T30，特别是 HEAD 漂移、应用后数据库失败、应用半途退出。
- G3：未验收不能应用；已验收内容与实际应用逐字节一致；无自动提交／push；DoD 不被绕过。

### M4／W09–W10：真实样例与发布门禁（1–2 工程日，不含未知缺陷返修）

- 扩展 `scripts/task-review-smoke.ts`，默认确定性测试；真实模型必须显式确认渠道、模型、费用上限和允许的命令。
- 新增 `tests/e2e/task-review-loop.spec.ts` 前先核对项目 Playwright／Electron harness，复用现有配置，不把网页 E2E 等同桌面验证。
- 执行测试文档 R01–R04。首个支持组合建议使用当前已有的 Pi Runtime，但具体模型／渠道由试跑前确认，不硬编码供应商。
- 完整 PR 门禁：typecheck、逐文件全量 test、lint、docs:check；构建及打包烟测另记。
- 更新 `docs/development-employee.md`、`docs/storage-contract.md` 的新行为和备份边界。README 与两份 AGENTS.md 只提出候选，获用户允许后再改。
- 提交时递增实际受影响包 patch；不得覆盖并行修改中的 package.json 版本，不预先固定版本号。

## 5. 验证命令与预期

以下是执行阶段命令；本次规划不运行尚不存在的文件。

```bash
# 基线：每个文件独立进程，不裸跑全量 bun test
bun test apps/electron/src/main/lib/agent-development-context.test.ts
bun test apps/electron/src/main/lib/agent-development-worktree.test.ts
bun test apps/electron/src/main/lib/agent-development-execution.test.ts

# 新实现完成后的定向验证（文件拟新增）
bun test apps/electron/src/main/lib/development-task-service.test.ts
bun test apps/electron/src/main/lib/development-snapshot-service.test.ts
bun test apps/electron/src/main/lib/development-delivery-service.test.ts
bun test apps/electron/src/main/lib/development-review-service.test.ts
bun test apps/electron/src/main/lib/development-validation-service.test.ts
bun test apps/electron/src/main/lib/development-apply-service.test.ts
bun test apps/electron/src/renderer/atoms/development-review-atoms.test.ts

# 仓库门禁
bun run typecheck
bun run test
bun run lint
bun run docs:check
bun run electron:build
```

预期：每条 exitCode=0；无失败测试。skip 必须独立列出原因。首次 TDD 红灯须由预期缺失行为导致，依赖缺失／导入失败不能冒充有效红灯。完整构建／打包命令按项目 AGENTS.md，打包前执行完整构建，不覆盖当前安装进行冒险自测。

## 6. 排期、顺序与停止条件

- 粗估合计 **8–13 个工程日**，单名熟悉仓库的工程师＋用户验收；并非承诺日期，也不是模型运行时间预测。
- 第一轮评审在 M1 后：身份与快照如果无法保持兼容，停止扩 UI，先修契约。
- 第二轮评审在 M2 后：可以看真实 Diff、完成一次返工；此时仍不能宣称最终闭环完成。
- 第三轮评审在 M3 后：确定性闭环通过，才申请真实模型试跑。
- 真实试跑必须同时记录人工介入次数和费用；任一越权写入、主目录污染、虚假完成或证据版本错配均停止放开。
- 当前已发现的仓库用户修改：`apps/electron/package.json`、`KnowledgeModuleView.tsx`、`NoteMarkdownView.tsx`。本方案不修改这些内容；执行时重新核查状态。

## 7. 最终交付清单

- 一个文件委派入口，一个统一 Review 页面，一条明确的受限员工提交链路。
- 可读取的每轮 diff／验证／返工记录，以及确认应用与崩溃恢复机制。
- 测试矩阵逐项结果、真实样例证据和未支持能力列表。
- 用户亲自完成 R01、R02 的最终 Review；无人值守能力只按实际记录描述。
- 不以“27 项已有测试通过”、实现提交或打包成功代替以上验收。
