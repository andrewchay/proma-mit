# Gravitas 完整工程诊断

> 这是修复前的历史基线；后续结果见 [修复与验收报告](2026-09-05-gravitas-repairs.md)。

诊断日期：2026-09-05
对象：当前工作区（HEAD `d00eed57` + 未提交改动），不是仅 HEAD，也不是已安装应用。
物理路径：`/Users/chaihao/.proma/agent-workspaces/proma-mit/project`
环境：macOS arm64、Bun 1.3.14；Electron 包 0.11.45。

## 结论

Gravitas 已具备实质性的 Agent 工作台基础：多 runtime、工作区、权限、Workflow、主动任务、Memory 审批、浏览器控制和服务端基础设施都有实现与测试。当前主要矛盾是功能扩展速度超过了持久化、隔离、发布和回归验证的收敛速度。

**当前工作区不满足稳定发布验收条件；当前共享 Executor 配置不宜作为不互信租户的执行边界。** 这是基于本地复现和实际安装包检查的工程判断，不是线上事故结论。

本次覆盖整个 monorepo 的质量检查，并深入追踪关键链路。没有逐行审查所有源码；没有做真实用户数据审计、生产渗透测试、真实 Provider 扣费调用、完整桌面交互验收、Windows/Linux 真机验收、生产 OIDC/KMS/SIEM 联通验收。因此“完整诊断”指范围覆盖与证据分级完整，不代表所有功能已逐项生产验收。

## 1. 实测基线

| 检查 | 结果 | 解释 |
|---|---|---|
| 全仓类型检查 | 8 个包通过 | shared/core/ui/context-store/electron/server/web/executor |
| 全量测试 | 1184 pass / 21 skip / 4 fail，61 errors | 1209 tests across 221 files；4 fail 不等于 4 个已确认产品 bug |
| Lint | 108 errors / 30 warnings / 1 info | 检查 1112 文件；未自动修复 |
| 文档事实检查 | 失败 | repository-facts.md 与当前代码不一致 |
| Electron 构建 | 通过 | main/preload/renderer/原生辅助模块均完成 |
| Web 构建 | 通过 | Vite 构建成功 |
| macOS arm64 目录打包 | 通过 | 临时 unsigned app；未发布、未替换用户应用 |
| 实际安装包内容检查 | 发现缺项 | 缺 default-tools、better-sqlite3；sql.js WASM、Claude arm64、Pi、playwright-core 存在 |
| Chromium/CDP E2E | 1 pass | 覆盖元素、shadow DOM、iframe、输入、截图、断开后保留浏览器 |
| Memory/Approval 单独验证 | 22 pass | 审批闭环、治理信号等；不等于下一次真实定时执行已验收 |
| Workflow 确定性执行器单独验证 | 5 pass | 全量运行中的加载错误没有在单独运行中出现 |
| Context Compaction Audit 单独验证 | 1 pass | 审计聚合测试独立通过 |
| projectDir 旧契约测试单独验证 | 0 pass / 2 fail | 失败稳定，但测试绕过类型调用私有方法，需修复测试契约 |
| Context Store 写入—重开 | 复现丢失 | 内存可查，磁盘文件未生成，重开查不到 |
| Executor 工作区隔离探针 | 复现越界读取 | 合成工作区 A 的 bun 命令读到合成工作区 B 文件 |

## 2. 优先处理的问题

### D01：Context Store 没有真正持久化——高，已复现

位置：
- [store.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/packages/context-store/src/store.ts:61)
- [context-store-service.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/context-store-service.ts:43)

`persist()` 只返回 `database.export()` 的字节；没有写文件。服务在索引消息、索引工具结果和 shutdown 中调用它，但丢弃返回值。关闭方法再次调用 persist 也不写盘。

临时目录复现输出：

```text
before close true export bytes 57344
file exists false after reopen false
```

影响：Context Store 索引在进程内看似正常，关闭后新增内容无法恢复。该缺陷涉及上下文索引，不应扩大为“JSONL 聊天记录或 Proma Memory 全部丢失”。

附带问题：默认路径仍是 `~/.proma/workspaces/{slug}/context-store.db`，而应用身份是 `.gravitas`。路径策略与主应用脱节，迁移、备份和测试隔离容易遗漏。

验收门槛：用正式 ContextStoreService 写入，进程退出后重开仍能召回；磁盘失败应明确反馈；采用原子写或明确存储事务；统一配置根目录。不能只增加内存 CRUD 测试。

### D02：共享 Executor 没有每任务/租户文件隔离——高；多租户上线阻断项，已复现

位置：
- [executor.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/executor/src/executor.ts:28)
- [index.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/executor/src/index.ts:1)
- [docker-compose.production.yml](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/docker-compose.production.yml:1)

执行器只确认 cwd 位于公共 workspaceRoot，随后执行白名单命令。生产 Compose 把整个 workspaces 卷挂到同一个 executor，默认白名单包含 `bun`。因此 cwd 不是文件访问边界；bun 可以读共享卷的其他路径。

复现使用两个临时合成目录，不含真实秘密：

```text
workspaceDir = <temporary>/tenant-a
command = bun
args = ["-e", "读取 <temporary>/tenant-b/probe.txt"]
stdout = SYNTHETIC-TENANT-B-DATA
exitCode = 0
```

这是执行层隔离缺口，不代表鉴权 API 已被绕过，也没有证明容器逃逸。执行器接口的 taskId 本身没有建立租户文件能力边界。

另有静态风险：子进程未显式清洗环境，超时只 kill 直接子进程；请求取消在 HTTP 客户端中止 fetch，执行端没有对应取消协议。不能据此保证凭证隔离或整棵进程树终止。

验收门槛：任务仅挂载授权 workspace；不共享可读的其他租户目录；清洗子进程环境；进程树取消；CPU/内存/时间/网络限制。用双租户恶意代码、父子进程取消和敏感环境变量探针验证，而不是只测 cwd 的字符串前缀。

### D03：发布包遗漏 default-tools，默认营销工具/模板无法按启动逻辑安装——高，实包确认

位置：
- [electron-builder.yml](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/electron-builder.yml:1)
- [config-paths.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/config-paths.ts:1118)
- [模板种子入口](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/config-paths.ts:1189)

打包模式从 `process.resourcesPath/default-tools` 安装工具和 Workflow 模板。实际生成的 app.asar 与 Resources 外部均没有 default-tools。

```text
default-tools: 0 matches in app.asar
external default-tools: false
```

工具种子缺目录时仅日志后跳过，模板种子直接返回，因此构建、打包都绿，干净安装却拿不到这套内置资产。老用户已有目录可能掩盖问题。

验收门槛：打包包含版本化工具及模板；空配置目录启动后通过产品服务验证 discovery、安装和执行；再验证老版本升级与用户高版本保留。只检查源码目录存在不够。

### D04：Campaign/KOL 的 Electron SQLite 驱动未形成交付闭包——高，代码与实包确认

位置：
- [campaign-manager.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/campaign-manager.ts:28)
- [kol-data-service.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/marketing/ma-tools/kol-data-service.ts:31)
- [electron/package.json](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/package.json:1)

两处运行时适配在 Bun 下加载 bun:sqlite，在 Electron/Node 下 require better-sqlite3。当前 Electron manifest 未声明该包，实际 app.asar 中也没有它。Bun 测试走内置 SQLite，不能验证 Electron 路径。

影响是触发这些数据功能时的驱动加载风险，不是已经证明整个主窗口启动失败。当前包内 sql.js WASM 存在，不能把所有数据库统一归因成 WASM 漏打包。

验收门槛：明确采用的存储方案并闭合依赖交付；在已打包的 Electron 中实际运行 Campaign/KOL 数据读写。补 default-tools 后还需检查 execute.ts 的加载及代码 fallback，不能以 Bun 测试代替。

### D05：更新/发行身份没有完全切换到 Gravitas——高，配置确认

位置：
- [electron-builder.yml](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/electron-builder.yml:1)
- [auto-updater.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/updater/auto-updater.ts:79)
- [github-release-service.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/github-release-service.ts:15)

应用身份是 com.gravitas.app / Gravitas；builder 的 publish 仍是 ErlichLiu/Proma，版本历史服务却指向 andrewchay/proma-mit。README 下载入口也仍指向上游。

自动定时检查已停用，所以不能说应用现在持续自动拉上游更新；但手动检查后 autoDownload 与 autoInstallOnAppQuit 均为 true。存在错误更新来源、版本历史不一致和发行上传目标错误的风险，是否可安装还受版本与签名限制。

本次 `pack --publish never` 没有生成 app-update.yml，未伪造真实发布元数据，也未触发在线更新。结论依据发布配置与运行代码。

验收门槛：应用身份、发布仓库、手动更新、版本历史、下载说明统一；使用实际发布配置生成元数据，核对来源与签名，再测试升级。

### D06：异步配置审计没有收尾/错误处理，破坏测试稳定性与失败可观测性——高，测试复现

位置：
- [config-audit-service.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/config-audit-service.ts:11)
- [agent-workspace-manager.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/agent-workspace-manager.ts:218)
- [channel-manager.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/channel-manager.ts:191)

调用方使用 `void appendConfigAudit(...)`，审计函数异步 mkdir/appendFile，调用方没有等待或捕获。全量测试 teardown 删除临时目录后，审计继续写入，出现大量 ENOENT 未处理错误。

测试中的具体触发器是目录清理与异步写入竞争；线上相似 IO 失败会导致未处理 rejection 或审计缺失，但本次没有制造线上磁盘故障。

验收门槛：明确审计成功/失败策略、可等待 flush 与 shutdown；测试等待审计完成再移除目录；保留原错误信息，不能简单吞掉全部异常来换绿。

### D07：全量质量门仍红；两项测试与正式 API 契约脱节——高，实测

位置：
- [projectdir test](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/agent-orchestrator.projectdir.test.ts:70)
- [runtime 私有入口](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/agent-orchestrator.ts:596)
- [正式调用路径](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/agent-orchestrator.ts:2018)
- [release.yml](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/.github/workflows/release.yml:16)

两项 projectDir 测试把 orchestrator 强制转换成接受 unknown 的接口，向私有方法传入未定义的 projectDir 字段。实际函数按 workspaceId 解析 cwd。它们单独运行仍失败，属于必须澄清的旧测试契约，不能直接证明用户从 UI 打开本地项目会失效。

另外全量测试出现 `Cannot call describe()/afterAll() after the test run has completed`，涉及 Workflow 确定性测试和 Context Compaction Audit。两者单独运行分别 5/1 通过；全量加载/生命周期边界仍需查清。

release 的 tag quality-gate 已检查 typecheck/test/lint/docs，当前本地结果无法满足该门槛。常规 PR 主要跑包构建，完整门禁没有同等覆盖；新增的上下文 CI 文件本身尚未提交。

验收门槛：真实 public API 行为测试替换过时私有调用；稳定的全仓无未处理异常测试；完整门禁前移到 PR。必须保留 21 skip 的真实 Provider/基础设施验收边界。

### D08：本地数据库写入与“不使用数据库”的项目规则冲突；部分写入不可可靠反馈——中高，静态确认

位置：
- [project-sqlite-store.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/project-sqlite-store.ts:126)
- [marketing-sqlite-store.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/marketing/marketing-sqlite-store.ts:145)
- [safe-file.ts](/Users/chaihao/.proma/agent-workspaces/proma-mit/project/apps/electron/src/main/lib/safe-file.ts:12)

项目管理、营销、Campaign、Context Store 已使用多种 SQLite 路径。这与 AGENTS/README 的 JSON/JSONL、无本地数据库表述不一致。

ProjectStore 导出整个内存数据库后直接 writeFileSync，失败只记录日志，不向调用者报告；营销 store 也直接覆盖写。崩溃/磁盘失败下存在文件损坏或 UI 成功与实际未持久化不一致的风险。本次没有做磁盘写满或断电破坏试验，故不把它列为已发生事故。

仓库已有 safe-file 的临时写入+rename+备份模式，可作为一致性参考。是否保留 SQLite 需要产品/架构决策，不能在本次诊断中擅自大迁移。

验收门槛：统一权威存储、索引可重建性、备份和恢复策略；持久化失败能反馈；断写恢复测试；经用户允许后同步 AGENTS/README。

### D09：文档与产品入口信息已不能充当可靠能力清单——中，实测与静态确认

README 保留 @proma/server 命令，实际包名为 @gravitas/server；配置目录说明是 ~/.proma，而实际身份为 ~/.gravitas；部分段落说 OIDC 尚未实现，仓库已有 jwt-auth/auth startup policy 及测试。Provider matrix 把 Pi 定位为验证 runtime，README 则推荐 Pi 为默认。

需要从代码、自动测试和真实验收分别生成状态，不应把旧 TODO 全部解释成当前未完成，也不应把源码模块存在解释成已生产通过。docs:check 已直接报 repository-facts.md 过期。

本次没有修改 AGENTS.md 和 README.md，遵守“先允许再修改”的仓库规则。

### D10：核心文件和初始 bundle 的复杂度较高——中，量化风险，未测实际卡顿

本次枚举的 apps/electron/src、packages、apps/server/src 范围有 1012 个 TS/TSX 文件，包含测试。典型大文件：

| 文件 | 行数 |
|---|---:|
| main/ipc.ts | 4340 |
| preload/index.ts | 3622 |
| agent-orchestrator.ts | 3494 |
| ProjectView.tsx | 3020 |
| campaign-manager.ts | 3004 |
| LeftSidebar.tsx | 2535 |
| AgentView.tsx | 2490 |

Electron main bundle 29.0 MB；renderer 主 index chunk 4861.11 KB，gzip 1426.34 KB。构建有大 chunk 警告，但这不是测得的启动延迟或内存泄漏。

建议按稳定业务边界拆分 IPC、运行会话生命周期、项目看板和导航；重型工作模块按入口延迟加载。先采集冷启动、首轮 token、长历史渲染和后台任务恢复指标，再决定性能重构；避免只按行数拆成大量薄文件。

## 3. 各产品链路的判断

| 链路 | 已有依据 | 当前主要缺口 |
|---|---|---|
| Chat / Agent | 多 runtime、类型合同、工具和权限链路；构建通过 | 真实 Provider 本轮未调用；public API 行为矩阵需收敛 |
| 本地项目 / 工作区 | rootPath/workspaceId 解析、全局 IPC/Jotai 链路 | 旧 projectDir 测试失真；不能以其失败代替 UI 验收 |
| Workflow | Definition/Run、快照、确定性节点、审批、子流程；独立测试通过 | 发布包模板缺失；全量加载稳定性；真实工具执行与中断恢复仍需端到端门槛 |
| Proactive / Proma Memory | safe 默认调度、候选→审批→Memory 的测试通过 | 不等于日常无人值守运行已真实验收；需跨重启和失败重试场景 |
| Context / Compaction | ContextPacket/压缩审计与测试基础 | Context Store 实际落盘缺陷；Provider 压缩质量本轮未在线验证 |
| Skills / MCP / 营销 | 目录工具、订阅边界、MCP 服务和版本同步入口 | default-tools 包资源及数据库驱动闭包 |
| Web Bridge | Chromium/CDP 真测试 1 pass；窗口隔离配置 | 未覆盖全部 UI 上传下载、用户接管和所有浏览器版本 |
| Computer Use | sandbox/contextIsolation、macOS helper 编译完成 | 没有进行真实屏幕控制；Win/Linux 真机仍未验证 |
| Server / Web | OIDC、审计、交互、费用、租户 store 模块；类型和 Web 构建通过 | 共享 Executor 隔离；真实数据库/Redis/OIDC/KMS 验收未跑 |
| 发行 / 更新 | macOS 目录包可生成，SDK/Playwright/sql.js 资源存在 | 默认工具遗漏、更新源错位、全仓门禁红 |
| UI / 产品组织 | Chat/Agent/Workflow/工作模块具备实现 | 功能入口多、前后端体验不等价；未做全流程可用性测试 |

### 项目管理治理能力复核（2026-09-09 更新）

下表按当前代码、行为测试、真实服务 UI 交互和打包启动结果更新。这里的“已实现”指本地项目管理闭环已经形成可执行约束，不等同于远端多人身份、外部交付真实性或生产协作已经通过验收。

| 能力 | 当前状态 | 已实现依据 | 当前主要缺口 |
|---|---|---|---|
| DACI + 执行责任人 | 已实现（本地） | 关键决策具有独立的推进人、唯一拍板人、贡献者、知会者、决策期限和直接影响任务清单；拍板人与记录人分离，由拍板人执行正式审批。任务负责人、验收人、接收人及 Agent Run 归属在主进程校验 | 当前身份目录和操作 actor 仍是本地模型，尚未接入远端多人认证、委托和离职转交机制 |
| DoD + 任务验收 | 已实现（本地） | 支持项目通用 DoD、任务 DoD、交付版本冻结、逐项检查结果、验收意见与依据；任务写入 `completed` 前再次执行完成门禁。管理员可为低风险任务把每条 DoD 唯一映射到“成果引用存在”或“权威执行已完成”验证器；全部通过后自动验收并追加系统检查记录，任一失败则保持待验收 | 当前内置验证器只证明结构化事实存在，不读取成果内容或证明外部结果质量；更高风险和语义质量验收仍必须人工完成 |
| 依赖升级为交接 | 已实现（本地） | 交接契约绑定真实依赖边、上游任务、下游任务、双方负责人、承诺时间和逐项接收标准；支持 planned、offered、accepted、returned，只有下游接收后才解除该依赖阻塞 | 尚未发送真实协作消息，也未覆盖跨项目、跨组织依赖及超期自动升级 |
| ADR 式决策记录 | 已实现（本地） | 已有候选→拍板审批→正式决定→被替代生命周期；保存理由、证据、候选方案、取舍、假设、版本、变更原因、影响任务和显式 `supersedes`／`supersededBy` 关系。原文引用结构化保存来源类型、权威来源 ID、来源内定位符及可选校验值；关键决策缺少结构化定位时禁止创建或拍板 | 旧字符串引用以 `legacy` 只读兼容，必须修订为结构化定位后才能继续关键决策审批；校验值和外部证据真实性尚不自动对账 |
| Kanban 流动指标 | 已实现（本地） | 基于权威任务时间戳计算在制品、等待数量、30 天吞吐量、平均周期时间、最老工作项年龄，并按可配置服务水平预期统计超期项 | 尚无历史趋势、累计流图、分位数 SLE、跨项目聚合和 Proactive 自动告警 |
| 决策链 + 协作链 | 已贯通（本地） | 双链总览只使用显式任务、决策版本、执行、Session、交付物和交接 ID。决策可追到影响任务及交付验证，协作可追到责任主体、Run、交付物和验收／交接状态；行为测试与真实服务 UI 交互已验证 | 尚未形成跨项目图谱；外部系统动作、远端多人身份及交付物内容真实性仍需独立对账和生产验收 |

产品判断：已有功能广度足够支撑下一阶段验证，优先投入“能持久保存、出错可恢复、打包后仍能执行、权限边界一致”。后续是否增加企业垂直包，应以一个真实用户任务从配置、执行、审批到重启恢复的成功率为准。这里是依据实现与质量基线给出的建议，未进行市场竞争研究或用户访谈。

## 4. 建议的处理顺序与验收门

1. **数据与隔离**：修 D01；在完成 D02 前限制共享 Executor 面向不互信租户的使用。分别建立磁盘重开、双租户隔离测试。
2. **发行闭包**：修 D03/D04/D05。用空配置运行真实安装包，验证工具发现、模板安装、数据库调用与更新元数据。
3. **质量基线**：修 D06/D07。全仓测试无未处理错误，lint/docs 全绿；把完整质量门前移到 PR。
4. **数据合同与文档**：处理 D08/D09，明确文件/数据库各自职责和迁移；得到许可后更新 README/AGENTS。
5. **体验和性能**：针对 D10 测量后优化；补齐默认 Pi 与 AI SDK 的文本、工具、审批、取消、压缩、恢复矩阵。

建议每个修复批次只处理一个功能域，避免把现有未提交的 Workflow、Memory、评测和 Marketplace 工作混在一起。当前 57 个已跟踪文件改动、1605 行新增/157 行删除，还另有未跟踪实现；这些是开始诊断时已有状态，本次不归因于某一个提交。

## 5. 验证产物与复现方式

所有检查基于本地工作区，没有请求修复、合并或发布，本次未修改功能源码。构建重生成了 dist/原生构建产物；报告是新增文件。未更新 AGENTS/README，未安装新依赖，未启动或替换用户当前 Gravitas 应用。

主要命令：

```bash
bun run typecheck
PROMA_TEST_CONFIG_DIR=<temporary-directory> bun run test
bun run lint
bun run docs:check
bun run electron:build
bun run --filter='@gravitas/web' build
bun run test:web-bridge-e2e
CSC_IDENTITY_AUTO_DISCOVERY=false bun run --filter='@gravitas/electron' pack --publish never --config.directories.output=/tmp/gravitas-diagnosis-package
```

测试仓库内部还有自行设置/删除 PROMA_TEST_CONFIG_DIR、mock homedir 的行为，所以一个外部环境变量不能替代逐测试的隔离设计。

原始日志（临时文件，系统可能清理）：

- [全量测试](/tmp/gravitas-diagnosis-tests.log)
- [类型检查](/tmp/gravitas-diagnosis-typecheck.log)
- [Lint](/tmp/gravitas-diagnosis-lint.log)
- [文档检查](/tmp/gravitas-diagnosis-docs.log)
- [Electron 构建](/tmp/gravitas-diagnosis-build.log)
- [Web 构建](/tmp/gravitas-diagnosis-web-build.log)
- [打包](/tmp/gravitas-diagnosis-pack.log)
- [包内资源检查](/tmp/gravitas-diagnosis-package-contents.log)
- [持久化复现](/tmp/gravitas-diagnosis-persistence.log)
- [Executor 隔离复现](/tmp/gravitas-diagnosis-executor.log)
- [CDP E2E](/tmp/gravitas-diagnosis-browser.log)
- [projectDir 独立失败](/tmp/gravitas-diagnosis-projectdir.log)
- [Memory 审批](/tmp/gravitas-diagnosis-memory.log)
- [Workflow 独立验证](/tmp/gravitas-diagnosis-wf.log)
- [上下文审计独立验证](/tmp/gravitas-diagnosis-compaction-audit.log)

安装包临时位置：`/tmp/gravitas-diagnosis-package/mac-arm64/Gravitas.app`。包内容检查日志末尾的 ENOENT 是探针读取未生成的 app-update.yml，并非打包命令失败；发布配置结论已与该事实区分。

历史记忆仅用于找到物理 checkout、识别 Proma Memory 与 Gravitas Proactive Center 边界、提醒实包验证；本报告的缺陷和检查结果均来自本次重新读取或执行。
