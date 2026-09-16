# 学术研究插件 M0–M7 任务台账

方案：`academic-research-workbench-v1.md`（会话计划目录 v1，2026-09-16 批准）  
分支：`feat/academic-research-m0`  
状态图例：`[ ]` 未开始 · `[~]` 部分完成 · `[x]` 完成（附提交号）

> **跟踪规则**：每个批次收尾时更新本文件——勾选条目并附提交号；新缺口以
> `G<n>` 编号登记到 §9 缺口表，不在正文里散落描述。评审（review）记录追加
> 到 §10。台账与代码同仓库提交，跨会话可追溯。

## 1. M0 基线修复（约 1 人周）

| 状态 | 任务 | 提交/证据 |
|---|---|---|
| [x] | 报告版本化落盘（§3.2-1/3）：`recordIntegrityReport` + 历史副本 | `86ef98fa` |
| [x] | Markdown 章节解析（§3.2-2）：`parsePaperSections` | `86ef98fa` |
| [x] | finalize 显式完成（§3.2-5） | `86ef98fa` |
| [x] | 损坏索引保护（§3.2-6）：保留原件拒绝读写 | `86ef98fa` |
| [x] | 隔离测试 4 个 + 插件门禁 12 个回归 | `86ef98fa` |
| [x] | 版本递增 0.12.4 → 0.12.5 | `86ef98fa` |

## 2. M1 研究项目与通用 UI（约 1–2 人周）

| 状态 | 任务 | 提交/证据 |
|---|---|---|
| [x] | shared 类型：ResearchProject/Brief、事件信封、错误码 | `4398c427` |
| [x] | core 状态机 research-rules（含回流、archived 终态） | `4398c427` |
| [x] | research-store：JSONL 权威 + 快照、commandId 幂等、revision 并发 | `4398c427` |
| [x] | research-service：CRUD/Brief 留痕/状态迁移/归档 | `4398c427` |
| [x] | IPC（7 通道）+ preload 桥 + academic-atoms | `ee577086` |
| [x] | ResearchWorkspace UI + 侧边栏核心模块入口 | `ee577086` |
| [x] | 迁移 dry-run（只读预检，损坏转 warning） | `ee577086` |
| [x] | research-profiles（七领域方法配置） | `M2.6`（G1 关闭） |
| [~] | 服务层授权校验（§3.2-7） | **顺延 → G3** |

## 3. M2 文献与证据闭环（约 2–3 人周）

| 状态 | 任务 | 提交/证据 |
|---|---|---|
| [x] | Source/SourceVersion/Screening/SearchRun 类型与事件 | `0d5bd01c` |
| [x] | source-identity：DOI/arXiv 规范化 + 两级去重候选 | `0d5bd01c` |
| [x] | RIS/BibTeX 导入解析（括号平衡扫描） | `0d5bd01c` |
| [x] | OpenAlex adapter（反转摘要重建、截断/错误可见） | `0d5bd01c` |
| [x] | arXiv adapter（Atom 解析、强制 preprint） | `0d5bd01c` |
| [x] | source-service：检索日志/去重/筛选落事件流 | `0d5bd01c` |
| [x] | 文献库 IPC（7 通道）+ preload | `0d5bd01c` |
| [x] | 证据模型 + evidence-policy + evidence-service | `f17b6fea` |
| [x] | SourceLibraryPanel UI（检索/导入/筛选/去重/证据台账） | `f17b6fea` |
| [x] | PubMed adapter（esearch+esummary，metadata-only 不冒充） | `M2.5` |
| [x] | EuropePMC adapter（resultType=core，剥离 HTML） | `M2.5` |
| [x] | Zotero 只读 adapter（本地/Web API 同实现，不碰 sqlite） | `M2.5` |
| [x] | 真实 API smoke：openalex/arxiv/pubmed/europepmc 四源全通过 | `scripts/academic-adapter-smoke.ts` |
| [~] | 证据矩阵视图（支持/矛盾并排） | **后移至 M5 → G5** |
| [x] | 检索日志（query/库/截断/错误） | `0d5bd01c` |
| [ ] | 检索日志补排序与分页位置 | 未开始 |

## 3.1 M2.5 补齐批次（G2 + G4）

| 状态 | 任务 | 提交/证据 |
|---|---|---|
| [x] | PubMed adapter（E-utilities 两步、PMID/DOI 归一化） | `M2.5` |
| [x] | EuropePMC adapter（pmcid 命名空间、open access 标注） | `M2.5` |
| [x] | Zotero 只读 adapter（不直写 zotero.sqlite，key 由调用方传入） | `M2.5` |
| [x] | 9 个离线契约测试（含 PubMed 无结果不请求 esummary） | `M2.5` |
| [x] | 真实端点 smoke 脚本（4 源全 PASS，含全库命中数与截断） | `scripts/academic-adapter-smoke.ts` |
| [x] | shared 增加 `pmcid` 命名空间 | `M2.5` |
| [x] | Zotero 接入 UI/服务（库配置 + 一键导入） | `M2.6`（G2 完全关闭） |

## 3.2 M2.6 批次（G1 + Zotero UI）

| 状态 | 任务 | 提交/证据 |
|---|---|---|
| [x] | research-profiles：七领域 × 四方法路径（字段/检查项/默认路径） | `M2.6` |
| [x] | profile 测试 10 个：完整性、路径约束、质性不强制假设、检查项过滤 | `M2.6` |
| [x] | zotero-config：配置落盘（**不含 apiKey**）、基址校验、本地/Web 默认值 | `M2.6` |
| [x] | Zotero 只读导入服务 + UI 配置/导入区块 | `M2.6` |
| [x] | Zotero 测试 5 个：未配置拒绝、导入落库、403 错误可见 | `M2.6` |
| [x] | 创建表单按领域过滤方法路径（非法组合不可选） | `M2.6` |

## 4. M3 选题、协议与领域方法（约 2 人周）— **已完成**

| 状态 | 任务 | 提交/证据 |
|---|---|---|
| [x] | protocol-rules：草稿校验、批准门禁、修订规则、版本递增 | `M3.1` |
| [x] | 条件必填设计：`requiredForMethodPaths`（伦理依据仅对涉及人类路径必填） | `M3.1` |
| [x] | access-guard（**G3 关闭**）：actor 由主进程确定、projectId 统一 NOT_FOUND | `M3.1` |
| [x] | protocol-service：创建/批准/修订/列举（旧批准不沿用） | `M3.1` |
| [x] | ProtocolPanel UI + getDomainProfile 只读暴露 | `M3.1` |
| [x] | 协议测试 12 个 + 规则测试 12 个 + profile 测试 11 个 | `M3.1` |
| [x] | topic-rules：gap 类型、查新完整性、证据归属；**不设总分** | `M3.2` |
| [x] | 门禁分级修正：反证/反例降为非阻断提示（避免诱导编造） | `M3.2` |
| [x] | proposal-service：创建/列举/选定（actor 主进程确定）/否决 | `M3.2` |
| [x] | ProposalPanel UI（gap/查新/证据关联/选定与否决） | `M3.2` |
| [x] | **七方向端到端 fixture**：协议批准→检索→证据→选题选定全通过 | `M3.2` |
| [x] | 新增 topic_rejected 事件（否决语义不再复用 proposed） | `M3.2` |

## 5. M4 原生研究执行与分析（约 2–3 人周）— 进行中

| 状态 | 任务 | 提交/证据 |
|---|---|---|
| [x] | run-rules：解释器白名单、脚本路径安全、预算边界、状态机 | `M4.1` |
| [x] | run-executor：**无 shell** spawn、cwd 限定、超时、输出上限、最小环境 | `M4.1` |
| [x] | run-service：失败/超时/取消语义、输入清单冻结 digest | `M4.1` |
| [x] | 手工观察登记（仅非计算运行）与产物登记（本地 sha256=verified / 外部=unverified） | `M4.1` |
| [x] | 真实执行器测试：shell 元字符作为参数原样传入（验证未过 shell） | `M4.1` |
| [x] | IPC + preload（7 通道，含允许解释器只读查询） | `M4.1` |
| [ ] | StudyRuns UI 面板（运行列表/日志查看/取消） | 未开始 |
| [ ] | 本体验证任务（RDF/OWL 工具接入，需先核许可） | 未开始 |
| [ ] | 重开恢复与中断运行的显式标记 | 未开始 |

## 6. M5 主张、写作与审查闭环（约 2–3 人周）— 未开始

- [ ] Claim / EvidenceLink + 失效传播（源变化 → stale）
- [ ] Markdown 稿件版本 + 章节/图表/引文绑定
- [ ] 证据矩阵视图（从 M2 后移，见 G5）
- [ ] LLM 审查与规则 lint 区分展示
- [ ] 修订回复 + 版本 diff
- [ ] 导出预检与 manifest（不含受限全文）

## 7. M6 外部执行器（约 2–4 人周，可拆）— 未开始

- [ ] OpenResearch adapter（CLI 探测、run 映射、日志回收）
- [ ] DVC adapter（数据引用，不重造）
- [ ] RD-Agent（隔离执行，预算循环）
- [ ] Biomni（仅生医计算任务）
- [ ] Zotero 云端写回（独立授权，冲突不覆盖）
- [ ] 每项独立 feature flag + 契约测试 + 真机 smoke

## 8. M7 领域验收与发布加固（约 1–2 人周）— 未开始

- [ ] 七场景端到端盲测
- [ ] 迁移回滚 + 崩溃注入 + 性能压测（§13.3 指标）
- [ ] 打包 smoke + 文档（README/storage-contract 更新需单独授权）
- [ ] 100 条跨领域标注样例的 precision/recall

## 9. 缺口登记（G1–G5）

| ID | 描述 | 来源 | 优先级 | 计划归属 | 状态 |
|---|---|---|---|---|---|
| G1 | research-profiles.ts 缺失 | 2026-09-16 review | 高 | M2.6 | **已修复** |
| G2 | PubMed / EuropePMC / Zotero adapter 缺失 | 2026-09-16 review | 高 | M2.5 + M2.6 | **已修复**（含 Zotero UI 入口） |
| G3 | 服务层授权校验缺失（§3.2-7） | 2026-09-16 review | 高 | M3.1 | **已修复**（access-guard；远端多人身份仍属未实现边界） |
| G4 | 真实 API smoke 未跑 | 2026-09-16 review | 中 | M2.5 | **已修复**：4 源全 PASS |
| G5 | 证据矩阵视图超出 M2 数据层语义，实为 M5 主张层需求 | 2026-09-16 review | 中 | 正式移入 M5 | 已裁决 |

## 10. 评审记录

- **2026-09-17 M4.1 批次**：研究运行与受限本地执行落地。安全边界按方案 §11.3 实现：**不经 shell**（`spawn(interpreter, [script, ...args])`，参数数组传递）、cwd 限定项目根（两侧 realpath 校验符号链接）、解释器白名单、超时杀进程、输出上限截断、子进程环境最小化（不注入应用密钥）。失败原因只记录归一化说明，原始 stderr 留在日志而不进事件流。产物分本地文件（sha256=verified）与外部引用（unverified）。测试包含一个真实执行器用例：把 `; echo pwned` 作为参数传入，断言日志中原样出现而非被执行，直接验证了「未过 shell」。
- **2026-09-16 M3.2 批次**：M3 完结。选题候选含 gap 类型（六类，非笼统新颖性）、查新范围（词/库/时间/最接近工作/局限）、支持与反证证据关联、反例；**不设总分**（方案 §13.3）。修正了一处过严门禁：反证与反例从硬缺口降为非阻断提示——检索后确实无相反证据是合法结果，强制非空会诱导编造。七方向端到端 fixture 全通过（建项目→协议批准→检索→证据→选题选定）。
- **2026-09-16 M3.1 批次**：关闭 G3（access-guard：actor 由主进程确定、渲染层无法自我批准、非法/不存在 projectId 统一 NOT_FOUND 不泄露存在性）。协议版本化与批准门禁落地：必填字段 + 全部检查项确认 + 涉及人类参与者需伦理依据；修订产生新版本且旧批准不沿用。设计改进：把「伦理依据」从协议顶层字段改为 profile 条件必填（`requiredForMethodPaths`），消除双真源。
- **2026-09-16 M2.6 批次**：关闭 G1（七领域方法 profile：协议字段/检查项/方法路径约束，质性领域不强制假设与种子）与 G2 余项（Zotero 配置 + 一键只读导入 UI，apiKey 不落盘）。至此 M2 广度缺口全部补齐。
- **2026-09-16 M2.5 批次**：补齐 G2 三库 adapter（PubMed/EuropePMC/Zotero）与 G4 真实 smoke；四源实端点全部通过，返回听力学相关真实文献，获取等级与 API 能力一致（PubMed=metadata-only）。Zotero 目前为 adapter 层就绪，UI 库配置入口留待 M2.6。
- **2026-09-16 完成度 review**：M0 100% / M1 约 90% / M2 约 65%。骨架原则（可追溯、检索日志、不静默合并、不虚报全文、agent 建议需人工确认）已落到代码与测试；广度缺口见 §9。typecheck 0 错误，学术模块 203 测试全绿，全量仅剩 main 基线失败（agent-blocker-detect，与本工作无关）。

## 11. 质量门禁（每批次必过）

```bash
bun test ./apps/electron/src/main/lib/academic/ ./packages/core/src/services/academic/
bun run typecheck && bun run test && bun run lint
```

- 测试用 `PROMA_TEST_CONFIG_DIR` 隔离，不写真实 `~/.gravitas/`
- 提交递增受影响包 patch；Skill 修改递增其 version
- skipped/未验证的外部集成不得记为通过
