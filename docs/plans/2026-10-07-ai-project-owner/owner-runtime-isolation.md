# Owner规划B：一请求、零工具受限出口

截至2026-10-09 GMT+8。Electron0.12.117/shared0.2.31；仅隔离实现/假SDK与本地运输验证，无真实模型收费、生产员工、安装/发布。

## 权威用途与冻结资料

`project-owner-planning-source.ts`只从planning_link/preparation双证据与真实execution解析，不接受客户端purpose标志。坏证据不得回null降级。严格Schema/身份/版本/目标归属/current binding/完整carrier配置/Goal/Plan/context/协议hash复核；发送资料冻结为同库`source_snapshot`（目标、项目/任务元信息、岗位建议摘要），没有文件正文/密钥/角色规则全文。A老准备缺快照仅可在来源仍当前、paused未关联execution时显式重复准备补齐；变更或已关联执行拒绝补造。晚到回执可读冻结资料，不将旧资料解释为新调用许可。

## 实际Runtime与请求

- Worker只传authority userPrompt，不传员工Skills/角色全文；保留既有队列和startedAt generation。一次额外动态import曾使研发回归16失败，改为静态引用、无额外await后23项全通过，未放松测试。
- Orchestrator在通用队列/Goal/命令/动态上下文/workspace MCP/history前分流，绑定真实channel/model/cwd，固定system与单user，无通用上下文、自动标题/Goal续跑。
- AI SDK adapter再次反查用途和真实凭据/渠道/工作区；不创建core/custom工具、不MCP acquire、不读Skills/history/附件、不Pilot/压缩/排队追加。Core仍是已有SDK引擎，专用收紧字段不授予权限；固定system/user，max step1，SDK内外retry0，真实输出4096。无fetch出口则拒绝，不能回退裸Caller。steering、compact、权限切换拒绝，真实abort保留。
- 最终JSON实际body白名单验证OpenAI Chat/Anthropic Messages/Google Generative的模型、system/user、零历史/工具/非文字及4096。最终凭据与确认渠道解密Key一致，不把密文当API Key。渠道与用途在async请求体读取后、HTTP前再读。
- `project_owner_planning_admissions`同事务核验原controlled准入＋唯一link/execution/session占位，保存request hash与资料快照（不保存headers/URL key）；占位表示可能发送，不表示Provider已启动或费用已结算。并发仅一次，网络异常/重开也不删除占位补跑。

## 独立安全审查与修复

协作实现与独立只读审查均已wait all。报告`owner-planning-b-security-review.md`保留在会话工作台（2026-10-09），指出fetch内部默认follow可绕过单HTTP/出口检查。父修复Owner运输强制`redirect:'error'`，覆盖Request/init的follow；普通controlled不变。离线运输契约＋真实本地127.0.0.1 mock服务器307/308均验证仅首请求1次、重定向目标0访问、错误保留占位。

审查同时发现普通兼容usage会把未报告token归零。保留普通兼容字段但新增Owner专用`owner_planning_usage`可空证据；无usage真实SDK场景保留null，不允许C将兼容0当真实用量/费用。length保留原文但terminal非success。SDK原文`result`和`finish_reason`进入共享类型，不伪造Provider request ID。

## 已验证边界

父独立复跑：source6项/17断言、payload3项/25、admission10项/58；admission含真SDK三协议→真最终body/凭据检查→临时Bun DB→假SSE、并发/网络异常/Goal异步变更/回滚/重开/加密Key/redirect。**此层mock了controlled费用准入，不是实际收费授权**。另一source测试用真实A禁令，伪造running仍零准入。

隔离SDK4项/15、Orchestrator3项/12、真实SDK离线7项/18；普通SDK adapter14项/34、core6项/20、controlled23项/97、研发23项/113均通过。独立审查另跑11文件99项；其审查时离线SDK为5项，父之后新增无fetch及缺usage两项，不回写原审查结论。

**A普通context对Owner禁启动仍保留。** C可信Run/生成与澄清/完整费用预检UI尚未接通，不能仅删禁令启动规划；paused准备、purpose或4096不授权费用，不保证金额硬上限。B临时Bun/sql.js与真SDK离线不等于真实Electron Native迁移/生产导航/真实Provider，D仍须补验收。没有Owner自主组织员工、业务DoD完成或闭环结论。

最终同一静态源码验证：全仓555隔离文件、失败0；全包typecheck、lint1991、docs/diff、完整build含两macOS native helpers通过。日志为会话机器`/tmp/owner-b-{tests,typecheck,lint,build}-verified.log`。这些是本地源码门禁，不是远端CI/安装或真实Provider验收。
