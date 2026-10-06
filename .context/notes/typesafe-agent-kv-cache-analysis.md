# TypeSafe 编码 Agent 论纲：KV cache 统治力分析

> 来源：用户提供的 "Why yet another agent?" 设计论纲（2026-09），讨论以"LLM 没有 KV cache 会怎么设计 coding agent"为思想实验，提出 meta-attention、动态路由、结构化 skills 等方向。
> 本笔记 = 原文要点归档 + 我方逐条批判性分析 + meta-attention 成本模型推演。时间基准：2026-09，价格基于 Anthropic 公开定价（cache read ≈ 0.1× input，write ≈ 1.25× input）。

## 一、原文六大论断归档

1. **路由不划算**：opus→sonnet→opus 需重新处理上下文，长会话下比纯 opus 更贵（原文算得 pure opus 约为 2/3 成本）。
2. **工具调用是奇怪的 tradeoff**：工具需在 system message 预声明，高基数 + off-policy 场景下模型表现差；skills 有效正是因为"检索出来的知识 ≠ 预注入的约束"。
3. **Compaction 存在但目标函数可疑**：压缩假设所有未来 turn 共享同一状态；无 query 感知的通用压缩很难优于定向压缩。
4. **Subagent 不够好**：状态传递（传什么进去、merge 什么回来）成本高，抑制了自动并行化。
5. **重启存在**：状态损坏后重来的兜底，本质是"按需加载相关旧状态"没做好。
6. **电池之争**：易用性（openclaw 极端）vs 强大（claude code/codex 极端）。

## 二、逐条分析（我方修正）

### 2.1 论断 1 的数学在 cache-aware 定价下反转

原文按 base input 价格计价上下文重载（opus 5、sonnet 3），完全忽略 cache read。用 2026 价格重算（$/M tokens）：

- Opus: input 5 / output 25 / cache write 6.25 / cache read 0.5
- Sonnet: input 3 / output 15 / cache write 3.75 / cache read 0.3

设 X=0.65M（上下文）、Y=0.12M（输出）、Z=0.23M（工具回读增量），单位 $：

- Path 1（纯 opus）：0.5X + 25Y + 0.5Z = 0.325 + 3 + 0.115 ≈ **3.44**
- Path 2（opus→sonnet→opus，切回时全量 cache write）：0.3X + 15Y + 0.3Z + 6.25(Y+Z) = 0.195 + 1.8 + 0.069 + 2.1875 ≈ **4.25**

结论：在合理参数下两者同量级，path 2 贵约 24%（并非原文的 50%+），且对 X 不敏感（0.3X vs 0.5X，X 越大 path 2 反而越省）。**KV cache 统治力的正确粒度是 "provider+model 组合"**：跨 provider 切换必 miss（KV 格式不通用），同 provider 同族模型切换可保留 cache（Anthropic model switching retention 已支持）。原文方向（缓存边界决定路由经济性）正确，但数值结论过度悲观。

### 2.2 论断 2 成立，且已被官方动作验证

Anthropic tool search tool + programmatic tool calling 本质就是原文主张的"两层结构：方向性描述按需注入 + 完整 schema 按需 dump"。skills 有效的根因：skill 是检索出来的知识而非预注入约束，天然规避高基数工具选择退化。**这是全文最可直接落地的洞察。**

### 2.3 论断 3/4：compaction 与 meta-attention 是同一原语

关键综合：**compaction 本质是一次"目标函数不感知 query 的 context rebuild"；meta-attention 是同一机制换成 query-aware 的 α 选择**（详见第四节成本模型）。因此"支持不支持动态重构"不是路线分歧，只是压缩器的打分函数和触发时机问题。

Subagent 判断需更新：2025 下半年后显式 brief + 结果收敛已是主流。真正未解决的是 **merge 语义**（哪些子上下文回流、写冲突仲裁）——这是 harness 问题不是模型问题，恰好是显式标注 reads/writes 能切入的接口，也是全文最有原创性的设计点。

### 2.4 性价比排序（对 Gravitas 的落地建议）

1. **条件化 AGENTS.md / per-directory gotchas**：成本最低，无 cache 顾虑（注入发生在 turn 边界），"免于 compaction"可用"每次 turn 注入而非一次性注入"实现。Claude Code 的 nested CLAUDE.md 已验证按路径加载，缺"按任务语义加载"。
2. **两层工具目录**：方向性索引常驻（≈ skill description 粒度），schema 按需 dump，dump 结果不污染长期上下文。
3. **Spawn 边界的定向压缩**：subagent 任务已知 → query-aware 压缩在 spawn 处最划算；父上下文不动，只为子任务构造定向 context。
4. **Meta-attention**：最后做——需要先有 chunk 级审计数据（tool call 输入/输出/推理的留存与打分），才能校准打分器。

Security-aware routing 首版应做**声明式策略**（用户标记敏感路径 → 任务硬性限定 model allowlist），不做"预测任务会碰哪些文件"的概率路由（预测本身要花一次调用，错判代价是隐私事故）。

## 三、思想实验校准：KV cache 是 10× 补贴

无 KV cache 的世界：每 turn 付全量重处理 T×P_in。有 cache：0.1×T×P_in（read）+ 1.25×ΔT×P_in（新追加 write）。

→ **静态前缀架构是 KV cache 补贴塑造出的演化结果**。补贴消失，动态 context 构造立刻成为默认最优。所以"无 KV cache 设计题"的价值在于：它暴露了哪些"直觉上应该有效但无效"的东西（路由、动态工具注入、query-aware 压缩）其实只是**不满足补贴的发放条件**（前缀不变）。工程上不必假装补贴不存在，而应把设计目标改为：**在补贴发放的间隙做动态化**（turn 边界、spawn 边界、阈值触发点）。

## 四、Meta-attention 成本模型推演

记号：T = 当前上下文 token 量；P_in = 主模型 input 单价；α = 重构后保留比例；K = 重构间隔（turn 数）；S = 单次打分开销。

### 4.1 打分开销可忽略

用便宜模型（p_s ≈ 0.2 $/M）对 chunk 摘要（总量 βT，β ≈ 0.2）打分：S ≈ βT×p_s ≈ 0.008×T×P_in（以 P_in=5 计）。对比重构 write 开销 1.25αTP，打分低两个数量级。**瓶颈不在打分，在 rebuild write。**

### 4.2 三种策略的每 turn 上下文项开销

| 策略 | 每 turn 上下文开销（近似） | 备注 |
| --- | --- | --- |
| 纯追加（现状） | 0.1TP + 1.25ΔTP | 随 T 线性增长，compaction 的动机 |
| 每 turn 全量重构 | 0.1TP + 1.25TP + S ≈ **1.35TP** | 约为纯追加的 **13×**，除非过滤 >92% 否则永不划算 |
| 阈值触发重构（每 K turn 一次，压到 αT） | 摊销 0.1TP + (1.25αTP + S)/K | 见下 |

### 4.3 阈值触发的盈亏平衡

一次重构的收益 = 之后 K 个 turn 每次省 0.1TP(1-α)：

```
K > 12.5α / (1-α)
```

- α = 0.1（砍 90%）→ K > 1.4 turn：几乎随时可做
- α = 0.3（砍 70%）→ K > 5.4 turn：约每 6 turn 一次即回本
- α = 0.5（砍 50%）→ K > 12.5 turn：需要长会话

**结论：激进过滤 + 低频触发在经济上稳健；温和过滤 + 高频触发是双输。**

### 4.4 与 compaction 的统一视角

Compaction 的成本 = 摘要输出（~2-5K token × output 单价）+ 压缩前缀的 cache write。它就是 α 由通用摘要决定的 rebuild。Meta-attention 的增量价值 = α 由 query 分布决定 + 可选的分级展示（不展示 / 摘要 / 全文）。所以正确实现路径不是"另起炉灶"，而是**在现有 compaction 流程前插一个 chunk ledger + 打分器，把通用摘要升级为定向重构**。

### 4.5 对 Gravitas 的实施要点

- Chunk ledger：append-only 存储 chunk（tool 输入/输出/推理/用户往来）+ 生成时摘要，复用 JSONL 惯例。
- 打分器：廉价模型，只在触发点跑（阈值：score 分布熵 / 会话轮数 / T 超窗口预算），不在每 turn 跑。
- 重构点固定在 turn 边界，重构后立刻持久化 compact_boundary（对齐现有 Pi 自动压缩的审计约定），杜绝"报错或无结果却伪造边界"。
- Spawn 边界单独走定向构造，与全局重构解耦。

## 五、Implications（2026-09-22 补充推演结论）

### 架构层

1. **Cache write 是新的预算单位**：注入主上下文的每个 token 成本 ≈ 1.25×P_in（write）+ 之后每 turn 0.1×P_in（read），比打分开销高两个数量级。推论：宁可在边界多花打分钱，也不要把低价值内容写进主上下文——「上下文卫生」是经济学结论，不是洁癖。
2. **Chunk ledger 是前提资产**：没有 chunk 粒度的持久化（内容 + 生成时摘要 + 位置元数据）就无法打分和定向重构。对 Gravitas 现有 JSONL 存储是兼容演进，不是推翻。
3. **动态化只允许发生在补贴发放的间隙**：turn 边界、spawn 边界、阈值触发点。会话中途换 provider/model 必然 cache miss，应做模型 pinned + 换模型时显式告知成本。
4. **Compaction 重新定位**：从「窗口将满的应急」改为按经济学阈值触发（K > 12.5α/(1−α)）。α 激进（砍 90%）时几乎随时可做——更频繁、更激进的压缩反而更省钱，与「留到 90% 窗口才压」的直觉相反。

### 产品层

5. **Spawn 边界是第一落点**：subagent 任务已知 → 定向构造 context 的 α 选择接近全知，收益先于主循环 meta-attention，且不需要打分基础设施。delegation brief 构造处先做。
6. **上下文卫生可以 UX 化**：展示当前 T、窗口预算、上次重构节省的成本，把不可见的经济学变成可感知卖点；顺带为 chunk 打分积累真实数据（校准用）。
7. **两层工具目录让 batteries 接近零边际成本**：方向性索引常驻 + schema 按需 dump，支持「内置数百工具」而几乎不付上下文代价 → 生态合作与「开箱即用」的产品杠杆。

### 战略层

8. **成本模型必须参数化**：cache read/write 定价由 provider 控制，是 harness 头上的抽象泄漏；定价结构变化（read 涨价、per-turn 计费、KV 外置服务）会直接移动最优策略，策略不应硬编码。
9. **显式状态是唯一不受补贴结构摆布的层**：静态前缀架构是补贴塑造的；谁把状态显式化（chunk ledger + reads/writes 标注），谁就能在补贴规则的缝隙里动态行动——这是「TypeSafe 编码 agent」论纲的真正护城河表述。

### 工程红线

10. **不为动态而动态**：静态前缀是 10× 补贴，全量重构每 turn 亏 13×；分级展示需显式标记摘要/全文版本，防同 chunk 双版本幻觉。

## 六、遗留问题

- Chunk 打分的 query 分布从哪来：最近的用户 turn？历史 query 的滑动窗口？待定。
- 分级展示（摘要 vs 全文）会引入"上下文里同一 chunk 出现两个版本"的幻觉风险，需要显式标记。
- 原文 Appendix 的工具（fastcontext、fff、rtk、headroom、ast-grep）未逐个评估，仅在需要 tool-search 落地时再调研。
