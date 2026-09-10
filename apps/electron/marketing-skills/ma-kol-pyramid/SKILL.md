---
name: ma-kol-pyramid
description: KOL金字塔投放策略设计专家。基于预算和TA画像，设计头部/腰部/KOC的金字塔配比、分阶段动作和平台分配策略。适用于KOL投放规划、达人合作预算分配、种草策略制定。当用户提到"KOL策略"、"达人配比"、"金字塔"、"KOL预算"、"头部腰部KOC"时触发。
version: "1.0.1"
---

# KOL 金字塔投放策略

## 这个 Skill 做什么

基于预算、TA 画像和品牌人格，设计系统性的 KOL 金字塔投放策略：
- **金字塔配比**：头部/腰部/KOC 的人数、预算和角色分配
- **达人形象角色矩阵**：各层级达人在传播中承担的形象角色，以及与品牌人格的匹配逻辑
- **分阶段动作**：预热期/爆发期/持续期各层级的具体动作
- **平台分配**：各平台的预算占比和主攻层级
- **选号标准**：可量化的 KOL 筛选标准

## 何时使用

**合适的场景：**
- KOL 投放预算规划
- 达人合作策略制定
- 种草 campaign 的 KOL 配比设计
- 新品牌首次 KOL 合作的整体策略
- 季度/年度 KOL 合作复盘和优化

**不合适的场景：**
- 单个 KOL 的合作谈判（用 ma-connect-bot）
- KOL 的具体内容创作指导（用 ma-creative-pilot）
- 没有预算信息时（无法设计配比）

## 工作流

### Step 1 · 预算与目标确认

确认以下信息：
| 信息项 | 说明 |
|--------|------|
| 总预算 | KOL 合作总预算 |
| TA 画像 | 目标人群特征（年龄、城市、兴趣） |
| 传播目标 | 品牌曝光/种草/转化/口碑 |
| 目标平台 | 重点投放的平台 |
| 时间周期 | campaign 周期 |
| 产品类型 | 新品/爆款/日常品 |

### Step 2 · 金字塔设计

根据预算级别设计金字塔结构：
- 预算 < 20万：取消头部，聚焦腰部+KOC
- 预算 20-100万：标准三层金字塔
- 预算 > 500万：增加超头层级（明星/顶流）

### Step 3 · 阶段与平台分配

设计分阶段动作和各平台的预算分配。

## 输出格式

必须以 JSON 格式返回：

```json
{
  "status": "complete | partial",
  "pyramid": {
    "top_tier": {
      "ratio": 10,
      "budget_amount": 10.0,
      "role": "品牌背书/话题引爆",
      "count": "1-2人",
      "selection_criteria": ["粉丝画像匹配度>80%", "近30天互动率>5%"],
      "content_direction": ["品牌大片", "首发开箱"],
      "estimated_price_range": "50-100万/人"
    },
    "mid_tier": {
      "ratio": 30,
      "budget_amount": 30.0,
      "role": "精准种草/转化核心",
      "count": "5-10人",
      "selection_criteria": ["垂类匹配度>70%", "内容质量稳定"],
      "content_direction": ["深度测评", "场景种草"],
      "estimated_price_range": "5-15万/人"
    },
    "bottom_tier": {
      "ratio": 60,
      "budget_amount": 60.0,
      "role": "真实体验者/口碑沉淀者",
      "count": "20-50人",
      "selection_criteria": ["真实感强", "互动积极"],
      "content_direction": ["真实体验", "素人分享"],
      "execution_mode": "产品置换/佣金"
    }
  },
  "role_matrix": {
    "brand_personality_match": "达人形象角色如何放大品牌人格",
    "top_tier_role": "品牌背书者/信任放大器",
    "mid_tier_role": "场景种草者/垂类渗透者",
    "bottom_tier_role": "真实体验者/口碑沉淀者"
  },
  "phase_allocation": {
    "teaser": {
      "top_action": "预热视频/悬念海报",
      "mid_action": "剧透式种草",
      "bottom_action": "话题预埋",
      "key_message": "要来了"
    },
    "launch": {
      "top_action": "首发开箱/品牌大片",
      "mid_action": "密集种草",
      "bottom_action": "UGC裂变",
      "key_message": "现在拥有"
    },
    "sustain": {
      "top_action": "长尾内容维护",
      "mid_action": "二次传播",
      "bottom_action": "口碑沉淀",
      "key_message": "大家都在用"
    }
  },
  "platform_allocation": {
    "小红书": {
      "budget_share": 40,
      "tier_focus": "主攻腰部"
    }
  }
}
```

## 规则

1. **预算 < 20万时，取消 top_tier**，聚焦 mid + bottom，避免资源分散
2. **预算 > 500万时，增加超头层级**（明星/顶流），但要评估 ROI
3. **selection_criteria 必须可量化**，如"粉丝画像匹配度>80%""近30天互动率>5%"
4. **phase_allocation** 必须说明每个层级在每个阶段的具体动作，不是笼统描述
5. **platform_allocation** 的 tier_focus 要明确该平台主攻哪个层级
6. 预估报价要基于行业基准给出区间，不是精确数字
7. 如果品牌是新品牌，建议增加 bottom_tier 占比，用真实口碑建立信任
