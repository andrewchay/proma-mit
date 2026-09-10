---
name: ma-marketing
description: Flow 复楼 —— 智能社交营销 AI 代理。整合策略生成、KOL 智能匹配、智能建联和创意内容指导四大核心能力。专为广告公司、品牌营销团队打造，解决社交营销中"KOL匹配难、执行效果难、完成目标难"的三难核心痛点。
version: "1.0.2"
---

# Flow 复楼 —— 智能社交营销 AI 代理 (MA)

> 每一分投放都应该有复利

## 这个 Skill 做什么

**Flow 复楼 (Marketing Agent)** 是一个 **AI 驱动的全链路社交营销智能代理**，整合四大核心能力：

### 1. StrategyIQ —— 策略理解与生成 🧠

自动解析品牌 Brief，生成完整的社交营销策略提案：
- Brief 智能解析（文本/PDF/语音）
- 平台矩阵建议（小红书/抖音/B站/微博/快手/海外平台）
- KOL 组合策略（头部/腰部/KOC 配比）
- 内容规划（预热期/爆发期/长尾期）
- 预算分配与 KPI 设定

### 2. MatchAI —— KOL 智能匹配 🎯

基于本地 KOL 数据库，智能筛选并推荐合适的达人：
- 多维度筛选（平台/领域/粉丝量/城市）
- 匹配度评分与推荐理由
- 风险预警（数据异常/竞品合作史）
- 预算智能拆解

**KOL 数据来源：**
- 本地数据库（SQLite）
- JustOneAPI（多平台）
- 新榜（国内主流平台）
- Mock 示例数据

**Agent 模式下优先使用 `kol-data` MCP 工具集**：
- `search_kols` — 搜索本地 KOL 数据库
- `get_kol_detail` — 获取达人完整详情
- `sync_kol_data` — 从 API 同步最新数据
- `analyze_kol` — AI 深度分析达人价值
- `get_kol_stats` — 数据库统计概览
- `seed_mock_data` — 填充示例数据快速体验

### 3. ConnectBot —— 智能建联 🤝

7×24 小时智能建联助手：
- 个性化邀约话术生成
- 谈判策略建议
- 合同条款模板
- 跟进计划与确认清单

### 4. CreativePilot —— 创意内容指导 ✨

KOL 内容创作的智能指导：
- 个性化创意 Brief 生成
- 平台-specific 脚本建议
- 合规性预审（敏感词/品牌规范）
- 参考样稿与视觉指导

## 何时使用

**合适的场景：**
- 品牌新品上市推广方案制定
- KOL 合作筛选与推荐
- 达人邀约话术撰写
- KOL 内容创作指导与审核
- 社交媒体营销策略规划
- 跨平台传播方案设计

**不合适的场景：**
- 需要实时投放数据监控（需对接广告平台 API）
- 法律合同审核（需专业法务）
- 财务预算审批（需人工确认）

## 工作流

### Step 1 · 需求澄清

**如果用户给了完整的 Brief**，可以跳过直接进 Step 2。

**如果信息不完整**，确认以下要素：

| 要素 | 说明 |
|------|------|
| 品牌/产品 | 品牌名称和产品信息 |
| 行业类别 | 美妆/3C/快消/母婴/时尚/运动鞋服/宠物科技等 |
| 营销目标 | 品牌曝光/种草/转化/销售 |
| 预算范围 | 影响平台选择和 KOL 配比 |
| 时间周期 | 传播起止时间、关键节点 |
| 目标受众 | 年龄、性别、城市层级、生活方式 |
| 首选平台 | 小红书/抖音/B站/微博/快手/海外 |
| 禁忌/禁区 | 绝对不能提的内容 |

### Step 2 · 策略生成（StrategyIQ）

使用 `ma_generate_strategy` 工具生成完整策略：
- 输入品牌 Brief 信息
- 获取平台矩阵、KOL 策略、内容规划、KPI

### Step 3 · KOL 匹配（MatchAI）

**Agent 模式下优先使用 `kol-data` MCP 工具：**
- 先用 `get_kol_stats` 确认数据库状态
- 数据不足时，用 `sync_kol_data`（source: mock 或 justone/newrank）填充
- 用 `search_kols` 按平台/类目/城市筛选候选达人
- 对重点达人用 `get_kol_detail` 查看完整信息
- 用 `analyze_kol` 生成达人画像和商业价值分析

**Chat 模式下使用 `ma_match_kols` 工具：**
- 确保本地 KOL 数据库有数据（先用 `ma_search_kols` 填充）
- 输入品牌需求和筛选条件
- 获取推荐列表（含匹配度评分）

### Step 4 · 智能建联（ConnectBot）

使用 `ma_generate_outreach` 工具生成邀约话术：
- 选择目标 KOL
- 输入品牌和合作信息
- 获取个性化邀约话术和谈判建议

### Step 5 · 创意指导（CreativePilot）

使用 `ma_generate_creative_brief` 工具生成内容 Brief：
- 为每个合作 KOL 生成个性化 Brief
- 包含平台规范、脚本建议、合规检查

## 模块化 Skills（工作区自动加载）

MA Marketing 工作区预置以下模块化 Skills，Agent 模式下自动加载：

| Skill | 功能 | 触发场景 |
|-------|------|---------|
| **ma-brand-dna** | 品牌DNA提取 | 品牌策略、品牌焕新、新品诊断 |
| **ma-brand-house** | 品牌概念产出 | 品牌屋搭建、愿景/价值观/品牌主张 |
| **ma-competitor-analyzer** | 竞品社媒诊断 | 竞品分析、差异化策略 |
| **ma-creative-concept** | 创意概念生成 | Big Idea、传播主题、Campaign 创意 |
| **ma-platform-role-mapper** | 平台角色定位 | 多平台策略、平台矩阵 |
| **ma-kol-pyramid** | KOL金字塔策略 | KOL配比、达人预算分配 |
| **ma-content-calendar** | 内容日历规划 | 排期、月度规划、内容统筹 |
| **ma-tone-manner** | 语气调性定义 | 品牌调性、内容风格统一 |
| **ma-ugc-campaign** | UGC活动设计 | 用户共创、互动活动、裂变 |
| **ma-paid-media** | 付费媒体规划 | 广告投放、信息流、预算分配 |

## 协作网络

MA Agent 可以与其他专业 Agent 协作：

- **marketing-xiaohongshu-specialist** — 小红书平台策略
- **marketing-douyin-strategist** — 抖音短视频策略
- **marketing-content-creator** — 内容创意与文案
- **sales-outbound-strategist** — 外联策略优化

## 核心指标

| 指标 | 目标 |
|------|------|
| KOL 建联效率 | 提升 5 倍+ |
| 策略生成时间 | 从 2 天缩短至 2 小时 |
| KOL 匹配精准度 | >90% |
| 平均 ROI | >1:5 |

## 平台 Specific KPI

| 平台 | 核心 KPI | 基准值 |
|------|---------|--------|
| 小红书 | CPE | < 5 元 |
| 抖音 | 完播率 | > 35% |
| 微博 | 话题阅读量 | > 1000 万 |
| B站 | 互动率 | > 8% |
