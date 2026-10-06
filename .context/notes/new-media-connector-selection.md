# 新媒体平台连接器选型决策

- 决策日期：2026-09-16（GMT+8）
- 范围：小红书、微信公众号的数据读取与内容发布
- 状态：已选择，等待分阶段实现

## 决策摘要

### 小红书

首期采用 **“官方分享/人工发布交接 + 官方报表导入”**，不实现普通专业号的服务端自动发布。

1. 发布：优先申请小红书分享开放平台，使用官方分享 SDK 将媒体带入小红书 App，由用户检查并最终确认发布。
2. 未取得分享能力前：生成文案、封面、媒体包和检查清单，打开官方后台或 App，由用户人工发布。
3. 数据：导入专业号、蒲公英或聚光官方后台导出的报表；取得明确商业 OAuth scope/白名单后，才启用对应 API Adapter。
4. 蒲公英、聚光、广告评论、私信三方和电商 API 分别建模，不把它们泛化为普通社区账号权限。
5. 不使用 Cookie、密码、网页私有接口、逆向签名、无人值守浏览器发布或未授权公开内容抓取。

原因：截至决策日期，未核实到面向普通品牌/专业号、OAuth 后可由服务器静默发布普通笔记的公开通用 API。官方分享 SDK 仍要求用户在 App 内完成发布；聚光发布属于广告素材和白名单能力。

### 微信公众号

生产多租户采用 **微信开放平台“平台型第三方平台”授权**；自有账号试点可提供受限的 AppID/AppSecret 直连模式。

1. 生产默认：商家管理员扫码授权，服务端保存 `component_access_token` / `authorizer_access_token`，按实际权限集动态协商能力。
2. 自有/受控账号：允许 `direct_appsecret`，使用官方 stable token 接口；不作为面向普通客户的默认方式。
3. P0 权限集：素材/草稿、群发与发布、用户数据；消息管理按需申请，不默认申请互斥的网页服务权限。
4. P0 能力：草稿写入、异步发布和状态回执、用户分析、图文分析、留言只读。
5. P1 能力：留言回复/删除、客服消息、群发；始终需要人工审批，并遵守 48 小时客服窗口、频控和主体认证限制。
6. 网页授权只用于微信内 H5 用户身份，不作为公众号账号连接方式。

原因：微信官方提供完整草稿、发布、统计和互动接口；第三方平台授权适合代运营/排版/CRM 等多租户服务，也避免收集客户公众号密码和 AppSecret。

## Adapter 形态

- `xiaohongshu-handoff`：本地草稿、媒体包、官方分享/人工交接、用户确认回执。
- `xiaohongshu-commercial`：仅在客户实际取得蒲公英/聚光/私信等 scope 或白名单后启用。
- `wechat-open-platform`：生产多租户默认，服务端 OAuth 回调和 Token 生命周期管理。
- `wechat-direct`：自有或受控账号试点，AppID/AppSecret 加密存储，能力按账号主体与认证状态协商。

账号能力不能静态写死。每个连接保存授权方式、主体类型、认证状态、实际 scopes/权限集、有效期及能力快照。

## 发布状态语义

- 小红书：`draft_ready -> handed_off -> user_confirmed_published`。没有官方回执时不得标记 `published`。
- 公众号：`draft_created -> publish_submitted -> publishing -> published | rejected | failed | deleted`，以官方回调为主、轮询为辅。

## 官方证据入口

### 小红书

- 分享开放平台能力：https://agora.xiaohongshu.com/doc/ability
- JS SDK：https://agora.xiaohongshu.com/doc/js
- 分享 SDK FAQ：https://agora.xiaohongshu.com/doc/qa
- MAPI 新手指南：https://ad-market.xiaohongshu.com/docs-center?bizType=943&articleId=4437
- 蒲公英授权范围：https://ad-market.xiaohongshu.com/docs-center?bizType=944&articleId=3196
- 专业号平台：https://pro.xiaohongshu.com/
- 电商开放平台：https://open.xiaohongshu.com/document/api

### 微信公众号

- 第三方平台概述：https://developers.weixin.qq.com/doc/oplatform/Third-party_Platforms/2.0/product/Third_party_platform_appid.html
- 商家授权流程：https://developers.weixin.qq.com/doc/oplatform/Third-party_Platforms/2.0/getting_started/how_to_service.html
- 公众号权限集：https://developers.weixin.qq.com/doc/oplatform/Third-party_Platforms/2.0/product/offical_account_authority.html
- 新增草稿：https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add.html
- 发布草稿：https://developers.weixin.qq.com/doc/subscription/api/public/api_freepublish_submit.html
- 发布状态：https://developers.weixin.qq.com/doc/subscription/api/public/api_freepublish_get.html
- 数据统计：https://developers.weixin.qq.com/doc/subscription/guide/product/analysis_data/analysis_data.html
- 留言列表：https://developers.weixin.qq.com/doc/subscription/api/leaving/api_listcomment.html
- 客服消息：https://developers.weixin.qq.com/doc/subscription/api/customer/message/api_sendcustommessage.html

## 实施顺序

1. 小红书发布交接 Adapter 和官方报表导入。
2. 公众号 direct 模式用于单一自有测试账号，验证草稿、发布回执和统计映射。
3. 申请并建设微信开放平台第三方平台，完成全网发布后切换为生产默认。
4. 获得小红书书面 scope/白名单后，再实现对应商业 Adapter；未获授权时保持 capability disabled。

以上为产品与工程接入决策，不替代平台书面授权或正式法律意见。
