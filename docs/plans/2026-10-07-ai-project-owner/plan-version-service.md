# Owner计划版本服务与单任务目标入口

发生/核验：2026-10-08。18:34及21:11 GMT+8用户要求在`feat/ai-project-owner`继续开发；分支从`6808fda9`快进已合并main `6c71b384`。本片源码版本Electron0.12.114/shared0.2.30，不是新安装版本。

## 产品边界

单任务现可从真实TaskItem打开“目标草案”，复用项目目标的保存/冲突保护。不要求员工、模型、Git、文件路径或工作区；只有打开才加载目标面板。窗口内一次只打开一个任务，晚到关闭回调不影响新主体；小窗口独立滚动。

计划服务/IPC可以记录、修订、确认规划内容，但**尚无计划编辑UI、Owner模型调用或收费规划入口**。当前`origin=manual`明确为本机人工记录，不把校验、手工提案或测试夹具称作AI生成。没有假生成按钮，也没有将手工拆任务设为默认主路径。

## 存储与版本

沿用项目`paa.db`，新增附属`project_owner_plan_revisions(project_id, subject_key, revision, payload)`，复合主键与正修订约束。与现有Goal表同库，兼容严格schemaVersion1目标历史，不升级/覆盖旧目标payload，不复制Goal Todo、权威任务、execution或预算账本。

- `revision`：计划记录并发修订；内容确认也追加一条。
- `planVersion`：计划内容或规划来源变化才递增；确认不递增。
- `goalRevision/goalVersion`：精确绑定真实目标历史，不与计划/链路/grant版本混用。
- 保存/确认在同一事务重读目标与计划，校验`expectedGoalRevision`及`expectedRevision`。过期同内容也拒绝，不能自动重试。
- 保存需非空`changeReason`。当前同内容合法提交no-op；修改已确认内容生成新planVersion并回`proposed`。
- `confirmed`只确认内容，不授权执行。目标/项目或任务元信息/岗位规则变化时，当前读取派生`stale`，拒绝确认；原历史不改。
- 历史检查修订连续、合法`proposed→confirmed`及新版本转换。损坏JSON/绑定/来源/模式/转换拒绝，保留数据库，不补造确认。

`contextFingerprint`覆盖真实目标修订及目标文本、项目/任务身份与标题说明、岗位建议目录。保存必须携带取得来源时的`expectedContextFingerprint`，防止晚到提案悄悄绑定新资料。`planFingerprint`进一步绑定planVersion、目标修订、来源指纹和完整规范化提案。两者为内容/来源校验值，不是签名、远端认证或授权凭据。

## 岗位、身份与范围

岗位键来自已生成并验证的20份内置模板，冻结名称/版本/来源SHA256及实际加载完整规则的SHA256。目录不返回完整systemPrompt、凭据或文件正文。模板仅为能力建议，未实例化员工；非代码角色目录不证明代码员工/Owner动态匹配已经完成。角色删除/升级使当前来源失效，历史仍按冻结目录读取。

当前主体来自真实项目及可选同项目任务。来源只读目标、项目/任务元信息和内置模板摘要；不读取目录文件、外部网页、渠道或API key。项目/任务说明超过当前12000字符边界明确拒绝构建规划上下文，不截断后冒充完整来源；目标保存入口不受此规划限制影响。

操作人由主进程固定`local-user`，输入不能指定actor。写入/确认要求本机操作人启用；缺身份目录沿现有默认身份，目录存在但不可读、损坏、重复身份或enabled非法不回退默认。该本地目录不是远端多人身份认证。

## IPC及零执行副作用

shared→工作模块注册→preload贯通：

- `getOwnerPlanningContext`
- `getOwnerPlanDraft`
- `listOwnerPlanHistory`
- `saveOwnerPlanDraft`
- `confirmOwnerPlanDraft`

请求外层与提案/步骤内层严格白名单，拒绝夹带grant、权限、状态、员工身份或客户端版本；失败保留结构化`conflict/failed`类别。没有注册模型运行或派发工具。

保存、修订、确认、重开均不调用模型、不创建任务/执行/会话/授权、不发送task/project-chain派发事件。删除主体保留附属历史，正常服务拒绝继续操作失效主体；恢复必须随完整项目数据库，不单独恢复某表。

## 确定性证据

- BDD首次RED：缺计划模块；实现后GREEN。计划服务17项/106断言、IPC5项/39断言通过。
- 覆盖主体隔离、双CAS、来源/岗位漂移、晚到提案、未知字段与DAG、修订重置确认、停用/损坏身份目录、回滚、重开、老库加表、删除主体及损坏历史。
- 检查任务/execution/Pilot intent/command/grant/项目链表数量不增；task/project-chain事件为0。
- 单任务UI组件SSR/状态及Chromium交互使用确定性API替身；开关、输入、主体切换、重开Dialog、小窗长文本通过。不是Electron传输或应用重启证据。
- 所有Bun测试临时`PROMA_TEST_CONFIG_DIR`、还原原值并清理，分文件进程；未调用真实Provider、创建生产员工或安装应用。

完整门禁与固定Electron实测另见本轮verification记录；没有完成的证据不在本文件预先记PASS。

## 未完与下一切片

AO-02仍缺Owner身份、真实员工/代码角色池、配置继承与规划授权/用量来源全映射。现有`createLlmCaller`直接请求，不具备本片需要的最终发送前版本/配置复核、完整用量回执及代理路由证据，不能直接用于收费Owner规划。

接模型前复用并补审现有控制面，明确一次规划的费用/资料范围、最终发送复核、取消/重开/晚到及unknown费用回执；不能用Goal quota或新独立grant替代。随后Owner主动提案及可编辑计划UI接本服务，模型来源与调用证据另建明确契约，不伪装manual记录为模型结果。AO-04模型规划、AO-05执行授权版本关联、AO-06组织派工仍未完成，原Pilot预算停止能力门禁不放宽。
