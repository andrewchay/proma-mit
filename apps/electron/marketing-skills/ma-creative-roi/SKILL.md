---
name: ma-creative-roi
description: 创意 ROI 评估专家。基于 DDB ROI 原则（Relevance / Originality / Impact）和李奥贝纳 Inherent Drama，对创意概念进行结构化评分与筛选。适用于创意比稿、Big Idea 筛选、创意方向决策。当用户提到"创意评估"、"ROI评估"、"创意筛选"、"DDB ROI"、"创意打分"时触发。
version: "1.0.0"
---

# 创意 ROI 评估

## 这个 Skill 做什么

基于 DDB 的 ROI 创意原则和 李奥贝纳的 Inherent Drama，对创意概念进行结构化评估：
- **Relevance（相关性）**：创意与品牌、产品、用户、文化语境的关联度
- **Originality（原创性）**：与竞品及行业惯用表达的差异化
- **Impact（影响力）**：能否引发注意、讨论、记忆和行动
- **Inherent Drama（内在戏剧性）**：品牌或产品中天然存在的人性冲突/情感张力

## 何时使用

**合适的场景：**
- 有多个创意方向需要客观筛选
- 比稿前对创意概念进行内部评估
- 需要向客户/管理层解释创意选择的依据
- 创意概念过于安全，需要检验是否有突破性
- 发现创意与品牌关联弱，需要诊断时

**不合适的场景：**
- 还没有任何创意概念时
- 纯执行层面的脚本/文案评估
- 只需要主观喜好评分时

## 工作流

### Step 1 · 输入确认

确认以下信息：
| 信息项 | 说明 |
|--------|------|
| 创意概念 | 待评估的 1 个或多个 Big Idea |
| 品牌信息 | 品牌 DNA、品牌意念、品牌主张 |
| 消费者洞察 | 核心 Insight / 传播切入点 |
| 竞品传播 | 竞品近期的核心创意方向 |
| 传播目标 | 本次 campaign 的核心目标 |

### Step 2 · 逐项评分

对每个创意概念按以下维度评分（1-10）：
- **Relevance**：是否直接回应品牌/产品/用户 Insight
- **Originality**：是否在竞品传播中出现过类似表达
- **Impact**：是否具备记忆点和传播张力
- **Inherent Drama**：是否挖掘到真实的人性冲突

### Step 3 · 推荐与风险

基于评分给出推荐排序，并指出每个概念的潜在风险。

## 输出格式

必须以 JSON 格式返回：

```json
{
  "status": "complete | partial",
  "concepts": [
    {
      "concept_id": "A",
      "big_idea": "创意概念一句话",
      "roi_scores": {
        "relevance": 8,
        "relevance_reason": "与品牌核心价值和用户洞察高度相关",
        "originality": 7,
        "originality_reason": "竞品未使用过类似角度，但行业内有相近表达",
        "impact": 8,
        "impact_reason": "具备话题性和记忆点，适合短视频传播",
        "total": 23
      },
      "inherent_drama": {
        "conflict": "人性冲突描述",
        "human_truth": "背后的人性真相",
        "brand_role": "品牌扮演的角色"
      },
      "strengths": ["优势1", "优势2"],
      "weaknesses": ["劣势1", "劣势2"],
      "risks": ["风险1", "风险2"]
    }
  ],
  "recommendation": {
    "top_concept": "推荐的概念ID",
    "reason": "推荐理由",
    "runner_up": "备选概念ID"
  },
  "confidence_score": 85,
  "missing_info": ["若有缺失信息，在此列出"]
}
```

## 规则

1. **评分必须逐项说明理由**：不能只有分数，必须解释为什么得这个分
2. **Relevance 优先**：如果相关性低于 5 分，即使 Originality 和 Impact 再高也不推荐作为首选
3. **Originality 要基于竞品和行业**：不是"我觉得很新"，要说明竞品是否做过类似方向
4. **Impact 要结合传播目标**：品牌曝光类看记忆度，转化类看行动号召力
5. **Inherent Drama 必须是真实的**：不是人为制造的冲突，而是品牌与用户关系中天然存在的张力
6. 对每个概念要同时列出优势和劣势，保持客观
7. 如果缺少关键信息（如竞品传播、消费者洞察），**status** 标记为 `partial` 并列出 **missing_info**
8. **confidence_score** 基于信息充分程度诚实打分（0-100）
