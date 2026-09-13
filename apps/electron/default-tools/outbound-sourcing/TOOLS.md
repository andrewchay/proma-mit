# 出海 sourcing 工具包

该工具包把出海业务拆成四个可审计阶段：市场与关键词计划、买家候选、线索质量判断、人工确认前的外联草稿。候选公司必须经过网站/国家/联系人核验后才可进入外联队列；工具不会发送邮件、修改邮箱状态或调用外部 CRM。

推荐顺序：`sourcing_build_keyword_plan` → `sourcing_search_buyers`（复用内部联网搜索收集候选与来源）→ `sourcing_verify_company`（抓官网返回证据，不做判定）→ `sourcing_score_lead` → `sourcing_build_persona`（决策人画像假设，输出交接口径）→ `sourcing_draft_outreach`（冷首触）；收到买家回复后用 `sourcing_draft_reply` 生成回复草稿简报（知识库注入 + Calendly 意向判定 + 线程头）。

进度指标：`sourcing_outreach_metrics` 查看本地外联漏斗（已发送/待确认/回信公司/回复率/平均首回时延）。

邮件收发（审批制）：`sourcing_list_inbox` 查看已同步来信（传 email_id 读全文）；`sourcing_get_mail_status` 查询某联系人往来状态；发送一律用 `sourcing_queue_email` 入队，邮件只会在用户于待发队列中逐封确认后才经 SMTP 发出。缺失证据时输出“待核验”，不要补造公司事实。
