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
| [~] | research-profiles（七领域方法配置） | **缺失 → G1** |
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
| [~] | PubMed adapter | **缺失 → G2** |
| [~] | EuropePMC adapter | **缺失 → G2** |
| [~] | Zotero 只读 adapter | **缺失 → G2** |
| [~] | 真实 API smoke（OpenAlex/arXiv 实端点各一次） | **未执行 → G4** |
| [~] | 证据矩阵视图（支持/矛盾并排） | **后移至 M5 → G5** |
| [x] | 检索日志（query/库/截断/错误） | `0d5bd01c` |
| [ ] | 检索日志补排序与分页位置 | 未开始 |

## 4. M3 选题、协议与领域方法（约 2 人周）— 未开始

- [ ] protocol-service：ProtocolVersion 版本化 + 批准记录 + 变更理由
- [ ] research-profiles 落地（依赖 G1）：七领域字段/检查项/方法路径模板
- [ ] 选题：gap 矩阵、反例、查新范围（不设统一总分）
- [ ] 批准门禁：伦理状态缺失不能启动人体数据采集；质性研究无假设不阻断
- [ ] 顺带修复 G3（服务层授权校验，方案硬门禁）
- [ ] protocol-rules.test + research-profiles.test + 七方向 fixture

## 5. M4 原生研究执行与分析（约 2–3 人周）— 未开始

- [ ] run-service + adapter-registry（绑定已验证持久化路径）
- [ ] 本地受限任务：合成数据 Python/R
- [ ] 取消/重试/超时 + 预算；失败结果保留
- [ ] 数据/环境 manifest（hash 校验）
- [ ] 手工观察与质性编码记录
- [ ] 本体验证任务（RDF/OWL/SHACL 工具接入前先核许可）
- [ ] 重开恢复、幂等提交、取消传播测试

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
| G1 | research-profiles.ts 缺失：七领域只有枚举与标签，无方法字段/检查项 | 2026-09-16 review | 高 | M3 首任务 | 开放 |
| G2 | PubMed / EuropePMC / Zotero adapter 缺失，听力学依赖 PubMed | 2026-09-16 review | 高 | M2.5 小批次 | 开放 |
| G3 | 服务层授权校验缺失（§3.2-7）：IPC 无条件注册，模型可伪造 projectId | 2026-09-16 review | 高 | M3 批准门禁一并落地 | 开放 |
| G4 | 真实 API smoke 未跑：fixture 未覆盖实端点字段形态 | 2026-09-16 review | 中 | M2.5 | 开放 |
| G5 | 证据矩阵视图超出 M2 数据层语义，实为 M5 主张层需求 | 2026-09-16 review | 中 | 正式移入 M5 | 已裁决 |

## 10. 评审记录

- **2026-09-16 完成度 review**：M0 100% / M1 约 90% / M2 约 65%。骨架原则（可追溯、检索日志、不静默合并、不虚报全文、agent 建议需人工确认）已落到代码与测试；广度缺口见 §9。typecheck 0 错误，学术模块 203 测试全绿，全量仅剩 main 基线失败（agent-blocker-detect，与本工作无关）。

## 11. 质量门禁（每批次必过）

```bash
bun test ./apps/electron/src/main/lib/academic/ ./packages/core/src/services/academic/
bun run typecheck && bun run test && bun run lint
```

- 测试用 `PROMA_TEST_CONFIG_DIR` 隔离，不写真实 `~/.gravitas/`
- 提交递增受影响包 patch；Skill 修改递增其 version
- skipped/未验证的外部集成不得记为通过
