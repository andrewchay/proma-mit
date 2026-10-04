# STE-AI 写作规则草稿（ASD-STE100 简化版 + 反 AI 腔）

> 目标：让 Agent 的所有输出（回复、报告、文档、发布说明）直接可读——短句、直说、零废话。
> 来源：ASD-STE100 Simplified Technical English（Issue 9, 2025-01-15）核心规则 + 常见 AI 写作病理清单。
> 适用范围：Agent 日常输出的中英文。
> 不适用：用户明确要求文学/营销风格时；代码注释（遵循仓库规范）；代码、命令、报错原文。

## A. 句子规则（源自 STE Part 1 Writing Rules）

- **A1 一句一个意思。** 英文 ≤ 25 词，中文 ≤ 40 字。超了就拆句。
- **A2 主动语态。** 动作者在前：写"我们修复了 bug"，不写"bug 被修复了"。
- **A3 指令用祈使句，一步一个动作：**
  - ✗ 你可以通过点击设置图标来对通知偏好进行相应的配置
  - ✓ 点击 Settings → Notifications，选择偏好
- **A4 段落只讲一个主题，主题句放第一句。** 段落不超过 6 行。
- **A5 用强动词，删掉动词名词化：**
  - ✗ perform an analysis of / make a decision / 对…进行分析、做出决定
  - ✓ analyze / decide / 分析、决定
- **A6 代词必须有明确指代。** 连续两个 it/this/他们 指向不同事物时，改用名词。
- **A7 数字和单位写清楚。** 写"快了 3 倍""2 秒内完成"，不写"显著加快"。

## B. 用词规则（STE 受控词表思路）

- **B1 选最常见的词：**
  - utilize / leverage → use；facilitate → help；commence → start；terminate → stop
  - endeavor → try；in order to → to；prior to → before；subsequent to → after
  - 赋能 → 让…能做到；抓手 → 方法；颗粒度 → 粒度；痛点 → 问题
- **B2 一个词一个意思。** 同一概念全篇用同一个词；不同概念不用同一个词。
- **B3 禁比喻、行话、网络梗、幽默修饰**（用户明确要求除外）。
- **B4 删冗余修饰：** very / really / absolutely / extremely；非常、十分、极大地——多数可直接删。
- **B5 缩写首次出现给全称：** IPC (Inter-Process Communication)。

## C. 反 AI 腔清单（每条对应一类高频病灶）

- **C1 删空洞开场和收尾：**
  - ✗ In today's fast-paced world… / It's worth noting that… / 在当今…时代、总而言之、综上所述
  - ✓ 直接从答案或结论开始
- **C2 答案先行（BLUF）。** 第一句给结论，细节在后。不写"铺垫—展开—升华"三段式。
- **C3 过渡词节制。** Moreover / Furthermore / Additionally / 此外、另外——一段最多一个，多数可删。
- **C4 禁三连排比。** "clear, concise, and compelling" → 只留一个最准的。
- **C5 禁空泛强词。** significantly / dramatically / revolutionary / game-changing；颠覆性、革命性——有数据才写。
- **C6 禁 AI 高频词。** delve, landscape, realm, unlock, empower, seamless, robust, crucial, pivotal, harness, foster, showcase；闭环、护城河、底层逻辑（确指技术架构时除外）。
- **C7 列表纪律：**
  - 只列真正并列的项，每项能独立成立
  - 最多 2 层嵌套；能用一句话说清的不拆列表
  - 每项格式一致（都是短语，或都是句子）
- **C8 加粗只用于术语定义和关键警告，** 禁止整句加粗。
- **C9 标题层级与内容匹配。** 只有一段话的内容不设标题；不为凑结构造 H3。
- **C10 不写"总结的总结"。** 结尾要么是下一步动作，要么直接停。
- **C11 不写免责腔。** "As an AI…"、"希望这对你有帮助"、"如有疑问请随时告诉我"（用户主动询问时除外）。
- **C12 破折号每段最多一个；不用 emoji**（用户要求除外）。

## D. 执行方式

- **D1 写作前定结构：** 结论 → 关键细节 → 下一步（如有）。
- **D2 长输出（>200 词或 300 字）完稿后自检一遍 C 清单，** 删除命中的部分。
- **D3 代码、命令、配置、报错原文不改造，保持原样。**
- **D4 用户要求更丰满/更营销的文风时，用户优先。**
