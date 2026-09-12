# 出海 sourcing 工具包

该工具包把出海业务拆成四个可审计阶段：市场与关键词计划、买家候选、线索质量判断、人工确认前的外联草稿。候选公司必须经过网站/国家/联系人核验后才可进入外联队列；工具不会发送邮件、修改邮箱状态或调用外部 CRM。

推荐顺序：`sourcing_build_keyword_plan` → 外部检索与核验 → `sourcing_score_lead` → `sourcing_draft_outreach`。缺失证据时输出“待核验”，不要补造公司事实。
