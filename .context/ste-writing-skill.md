---
name: ste-writing
group: 写作风格
description: >-
  ASD-STE100 简化写作与反 AI 腔改写工具。基于 ASD-STE100 Simplified Technical
  English（Issue 9, 2025-01-15）核心写作规则 + 12 条反 AI 腔病灶清单，提供三种模式：
  改写（把任意文本重写为简洁版本，信息零丢失）、写作（按简化风格直接产出报告/文档/发布说明）、
  体检（逐条诊断文本的 AI 腔病灶并定位）。当用户要求"简化""去掉 AI 味""直接一点""别啰嗦"
  "改写成 STE 风格""精简这段"，或需要撰写面向人的说明文字、报告、README、发布说明时，
  使用本 skill——即使用户没有明确提到 STE 或简化风格，也应主动应用。
metadata:
  skill-author: Andrew Chai
  version: "0.2"
  source: ASD-STE100 Simplified Technical English, Issue 9 (ASD-STEMG, 2025-01-15)
  source-pdf: workspace-files/ASD-STE100_ISSUE9.pdf（官方版，已逐项核对）
---

# STE 简化写作工具（STE + 反 AI 腔）

## Overview

让所有面向人的输出直接可读：短句、直说、零废话。规则来源 = ASD-STE100 Issue 9 核心写作规则（做适配裁剪）+ AI 写作高频病灶清单。中英文通用。
官方规格供对照：Part 1 共 9 节 53 条规则；Part 2 词典 875 个批准词 + 1274 个非批准词。

| 模式 | 输入 | 输出 |
|------|------|------|
| **改写 rewrite** | 任意文本/文件 | 简化版全文 + 命中规则摘要 |
| **写作 write** | 主题/要求 | 按本规则创作的内容 |
| **体检 audit** | 任意文本/文件 | 病灶报告（规则 ID + 原句 + 建议），不改写 |

## Workflow

### 改写模式
1. 通读原文，先列出**信息点清单**（每个事实、数字、操作步骤都要在列）
2. 按 A → B → C 的顺序应用规则重写
3. 拿改写稿对照信息点清单逐项核对，**信息零丢失**后才算完成
4. 输出改写结果，附一行式"命中规则"说明（如 `命中：C1 C6 A3`），便于用户校准尺度

### 写作模式
1. 先定结构：**结论 → 关键细节 → 下一步（如有）**，第一句就是答案（BLUF）
2. 起草时直接按 A、B 节规则写
3. 完稿后，超过 200 词（中文 300 字）的输出对照 C 清单自检一遍，删掉命中的部分

### 体检模式
逐条扫描 C 清单与 A、B 规则，输出表格：`位置 | 原句 | 命中规则 | 修改建议`。
只报告不改写；用户确认后再进改写模式。

## 规则库

### A. 句子规则

- **A1 一句一个意思。** 英文 ≤ 25 词，中文 ≤ 40 字，超了就拆句。
- **A2 主动语态。** 动作者在前：写"我们修复了 bug"，不写"bug 被修复了"。
- **A3 指令用祈使句，一步一个动作。**
  - ✗ 你可以通过点击设置图标来对通知偏好进行相应的配置
  - ✓ 点击 Settings → Notifications，选择偏好
- **A4 段落只讲一个主题，主题句放第一句，段落 ≤ 6 行。**
- **A5 用强动词，删动词名词化：**
  - ✗ perform an analysis of / make a decision / 对…进行分析、做出决定
  - ✓ analyze / decide / 分析、决定
- **A6 代词必须有明确指代。** 连续两个 it/this/他们 指向不同事物时，改用名词。
- **A7 数字和单位写清楚。** 写"快了 3 倍""2 秒内完成"，不写"显著加快"。
- **A8 禁分号。** 两句就拆两句（STE 规则 8.1：英文禁用分号；中文输出同理少用）。

### B. 用词规则

- **B1 选最常见的词：**
  - utilize / leverage → use；facilitate → help；commence → start；terminate → stop
  - endeavor → try；in order to → to；prior to → before；subsequent to → after
  - 赋能 → 让…能做到；抓手 → 方法；颗粒度 → 粒度；痛点 → 问题
- **B2 一词一义。** 同一概念全篇用同一个词；不同概念不用同一个词。
- **B3 禁比喻、行话、网络梗、幽默修饰**（用户明确要求除外）。
- **B4 删冗余修饰：** very / really / absolutely / extremely；非常、十分、极大地——多数可直接删。
- **B5 缩写首次出现给全称：** IPC (Inter-Process Communication)。

### C. 反 AI 腔清单

- **C1 删空洞开场和收尾。**
  - ✗ In today's fast-paced world… / It's worth noting that… / 在当今…时代、总而言之、综上所述
  - ✓ 直接从答案或结论开始
- **C2 答案先行（BLUF）。** 第一句给结论。不写"铺垫—展开—升华"三段式。
- **C3 过渡词节制。** Moreover / Furthermore / 此外、另外——一段最多一个，多数可删。
- **C4 禁三连排比。** "clear, concise, and compelling" → 只留一个最准的。
- **C5 禁空泛强词。** significantly / dramatically / revolutionary / game-changing；颠覆性、革命性——有数据才写。
- **C6 禁 AI 高频词。** delve, landscape, realm, unlock, empower, seamless, robust, crucial, pivotal, harness, foster, showcase；闭环、护城河、底层逻辑（确指技术架构时除外）。
- **C7 列表纪律：** 只列真正并列的项；最多 2 层嵌套；能用一句话说清的不拆列表；每项格式一致。
- **C8 加粗只用于术语定义和关键警告，** 禁止整句加粗。
- **C9 标题层级与内容匹配。** 只有一段话的内容不设标题；不为凑结构造 H3。
- **C10 不写"总结的总结"。** 结尾要么是下一步动作，要么直接停。
- **C11 不写免责腔。** "As an AI…"、"希望这对你有帮助"、"如有疑问请随时告诉我"（用户主动询问时除外）。
- **C12 破折号每段最多一个；不用 emoji**（用户要求除外）。

### D. 执行方式

- **D1** 写作前定结构：结论 → 关键细节 → 下一步。
- **D2** 长输出完稿后自检 C 清单。
- **D3** 代码、命令、配置、报错原文不改造，保持原样。
- **D4** 用户要求更丰满/更营销的文风时，用户优先。

## 标杆示例

### 英文

❌ 改写前（90 词）：

> In today's rapidly evolving AI landscape, effectively managing your agent sessions is absolutely essential for maximizing productivity. Our new Session Grouping feature empowers users to seamlessly organize their workflows, leveraging intelligent auto-categorization to dramatically reduce the cognitive load associated with context switching. Furthermore, by utilizing smart pinning, users can effortlessly prioritize their most important conversations, which not only enhances discoverability but also facilitates a more streamlined experience. In conclusion, Session Grouping represents a significant leap forward in our ongoing endeavor to unlock the full potential of collaborative AI.

✅ 改写后（38 词，命中 C1 C2 C4 C5 C6 B4 A3）：

> Session grouping organizes agent sessions into folders.
> - Auto-categorization sorts new sessions by project.
> - Pinned sessions stay at the top of the sidebar.
> To group sessions: select them in the sidebar, right-click, and select "Add to group".

### 中文

❌ 改写前：

> 在当今快速发展的 AI 时代，高效管理 Agent 会话对提升生产力而言至关重要。全新的会话分组功能通过智能自动分类，赋能用户从容掌控工作流，大幅降低了上下文切换带来的认知负担。此外，智能置顶能力不仅增强了会话的可发现性，更助力打造更加流畅高效的使用体验。总而言之，会话分组标志着我们在释放协作 AI 全部潜力的道路上迈出了重要一步。

✅ 改写后（命中 C1 C3 C6 C10 A2）：

> 会话分组把 Agent 会话整理进文件夹。
> - 新会话按项目自动归类。
> - 置顶会话固定在侧栏顶部。
> 分组方法：在侧栏选中会话，右键，选择「加入分组」。

## 快速自检清单（长输出完稿后过一遍）

1. 第一句是不是答案/结论？（C2）
2. 有没有空洞开场或升华收尾？（C1、C10）
3. 有没有三连排比和空泛强词？（C4、C5）
4. 有没有 AI 高频词？（C6）
5. 有没有一个词拆成短语的动词？（A5）
6. 每句 ≤ 25 词 / 40 字？（A1）
7. 列表是不是真并列、无滥用？（C7）
8. 加粗、标题、破折号有没有泛滥？（C8、C9、C12）
9. 关键结论有没有数字支撑？（A7）
10. 信息点和原文逐项对齐了吗？（改写模式）

## 边界与例外

- 代码、命令、配置、报错原文**不改造**，保持原样。
- 用户明确要求文学、营销、丰满文风时，**用户优先**（D4）。
- 代码注释遵循仓库规范（本项目约定：中文注释）。
- 专业术语保留原文，不做生硬直译（如 workspace、channel、context）。
- STE 原版规则只约束英文技术文档；本 skill 是面向日常输出的适配版，不声称符合 ASD-STE100 官方合规检查。
