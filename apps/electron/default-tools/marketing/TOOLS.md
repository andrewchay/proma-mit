# 营销工具集

## 工具列表

| 工具名 | 描述 | 领域 |
|--------|------|------|
| ma_generate_storyboard | 生成广告视频分镜脚本 | shared |
| ma_match_kols | KOL 智能匹配 | influencer |
| ma_generate_outreach | 生成建联话术 | influencer |
| ma_generate_creative_brief | 生成创意 Brief | influencer |
| ma_search_kols | KOL 数据搜索 | influencer |
| ma_kol_crm | 达人 CRM 管理 | influencer |
| ma_kol_portal | 达人端自助服务 | influencer |
| ma_audit_content | 内容审核 | influencer |
| ma_generate_script | 生成内容脚本 | influencer |
| ma_generate_strategy | 营销策略生成 | paid-media |
| ma_optimize_campaign | 投放策略优化 | paid-media |
| ma_design_campaign_test | 设计投放测试方案 | paid-media |
| ma_forecast_budget | 预算预估 | paid-media |
| ma_campaign_agent | Campaign 管理 | paid-media |
| ma_analyze_content_performance | 内容数据追踪 | paid-media |
| ma_generate_phase_report | 阶段复盘报告 | paid-media |

## 模型调用引导

当用户提到以下场景时，调用对应工具：

### 达人相关（influencer）
- "找 KOL" / "找达人" → ma_search_kols
- "匹配达人" / "推荐 KOL" → ma_match_kols
- "生成邀约" / "建联话术" → ma_generate_outreach
- "生成 Brief" / "创意指导" → ma_generate_creative_brief
- "审核内容" / "内容质检" → ma_audit_content
- "生成脚本" / "分镜脚本" → ma_generate_script
- "管理达人" / "CRM" → ma_kol_crm

### 投放相关（paid-media）
- "做策略" / "营销方案" → ma_generate_strategy
- "算预算" / "预算预估" → ma_forecast_budget
- "优化投放" / "调整策略" → ma_optimize_campaign
- "测试方案" / "A/B 测试" → ma_design_campaign_test
- "管理 Campaign" → ma_campaign_agent
- "追踪数据" / "内容表现" → ma_analyze_content_performance
- "复盘" / "阶段报告" → ma_generate_phase_report

### 通用（shared）
- "分镜" / "视频脚本" → ma_generate_storyboard
