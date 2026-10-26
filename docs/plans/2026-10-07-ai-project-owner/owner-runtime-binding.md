# 受控Owner规划A阶段：绑定与暂停关联（后台基础）

时间：2026-10-08 GMT+8。已批准`owner-planning-runtime-controlled.md`方案后的第一阶段。源码Electron0.12.116/shared0.2.30，没有安装或收费调用。

- Owner为固定`project_owner`职责＋明确名称，carrier为既有员工ID；不改员工角色、不创建新Owner principal或升级权限。
- 同paa.db追加`project_owner_runtime_revisions`（严格连续历史/schema/local-user、expectedRevision CAS、变更原因）与`project_owner_planning_links`（request幂等、目标/计划/来源/配置版本、协议/请求指纹、承载任务与业务目标任务分开）。绑定只接受enabled controlled AI SDK载体及显式模型/共同授权workspace；指纹冻结配置而不保存渠道凭据/路径。
- 准备在同一事务复用`prepareControlledTask`，创建首次即paused、可见权威Owner规划任务，不通知Runner。业务目标Task不变。关联与preparation目的标记一起提交；重试严格回读来源与所有关联内容，未知字段/权限、坏历史、错误来源、旧版本、载体改变、丢记录、目标递归规划承载任务均拒绝，不盲创建。
- B阶段实际零工具/单请求出口未完成，**planning_link或preparation目的标记任一存在就阻止普通controlled预检/queue/provider入口**，证据丢失不降级普通Agent。maxRequests1/output4096现阶段仅冻结意图，不宣称已落实模型参数约束。没有启动接口、配置/准备IPC或UI；这些在后续C完整入口时接入并要求明确确认。
- 复用现有严格本机身份校验，不新造目录/授权系统。目标可以在未配置Owner时照常保存；没有绑定不能准备规划。

## 验证与边界

模块缺失RED→GREEN、关联篡改RED（maxRequests9曾被复用）→严格全字段比较GREEN。13 BDD/46断言通过：未配置、CAS、零执行paused、双击幂等、外部身份/目的字段、目标/配置/资料变更、单任务业务不变、双证据丢失保护、历史损坏、外层事务回滚、DB重开、载体停用/Runtime/工作区变化、拒绝规划承载递归。载体工作区错误夹具采用不存在ID；直接store空数组兼容保留旧单工作区，不能误称它证明撤权。

普通controlled回归23项/97断言通过；全仓549独立文件失败0；全typecheck、lint1983、docs/diff、完整build（两native helpers）通过。真实Provider/外部服务explicit skip仍不算PASS。A使用隔离Bun/sql.js存储测试，尚未做本片独立Native/Electron验收；前片47次Native IPC不能冒充本片新增schema已验收。

后续B：实际AI SDK最终一请求/零工具/注入/重试边界；C：Run证据、generated或clarification、严格费用预检确认UI；D：Native迁移/恢复/完整门禁/独立安全审查。实际收费另逐次确认，没有硬金额限制承诺、自动派工或Owner自主闭环结论。仅本地开发提交，不push/merge/安装，不改README/AGENTS。
