# AI 员工创建与工作区修复记录

## 需求和根因

2026-10-07 17:28 GMT+8 用户报告 AI 员工创建中的工作区选不中、无法保存，并提及已建立其他岗位模板；用户确认实际使用0.12.104员工新建/编辑界面。17:40用户确认选用了研发配置，17:41授权先修复。

对应版本与修复前源码中，研发配置只展示带rootPath的工作区，托管工作区被静默过滤；保存按钮要求工作区和显式模型，但不解释缺项。20份跨职能岗位资料存在，尚未接入创建表单。旧general执行路径使用bypassPermissions，不能当安全的非代码替代。

## 已实现的源码行为

- 新建表单默认`controlled`非代码受控配置，支持托管及本地工作区，不要求Git、不创建worktree。`development`仍要求本地目录，并在执行时校验Git，不放宽研发和Pilot准入。
- 服务保存与启动均核验Pi/AI SDK、safe/auto、真实工作区、启用渠道及显式启用模型；多工作区必须在任务明确选择，拒绝范围外目标、全局回退、Workflow和没有有效主任务的启动。
- Runtime及会话元数据使用实际safe/auto；非代码不设置worktreeScopedWrite豁免。权限申请文字不视作授权，完成沿用暂停待人工验收，不自动完成业务任务。
- 未知执行配置拒绝启动，不回退到旧版全自动。旧员工不自动迁移；已有general配置编辑保留但明确提示并确认，新建表单不提供新general入口。
- 全部工作区仍可见，研发不可选项说明原因；切换配置后已有不适合的选择不会静默消失，允许取消，并阻止保存。checkbox在事件内先捕获checked再更新。
- 缺名称/渠道/模型/工作区等逐条说明；保存失败也在表单旁显示，保留输入。修正不支持Workflow却提示先发布SOP的误导。
- 20份模板作为创建预填：名称、角色、描述及完整岗位规则，默认controlled/safe；保留真实渠道、模型及工作区选择。不创建实例，不把roleSlug当employeeId，不代替费用或执行授权。
- 模板生成器验证原始哈希、未绑定状态和资料访问范围；预填冻结版本及来源SHA256。资源内附完整AgentLand MIT许可；原cards/roles/manifest未变。

## 验证

100项独立进程定向测试通过：受控契约4、表单/模板4、员工真实服务＋mock runner22、Pilot选择器1、readiness9、后台7、链服务5、Owner草案15、IPC5、规划16、Jotai9、组件SSR3。

服务测试覆盖托管配置保存/重读/数据库重开、auto和safe传入runner、无worktree写豁免、任务完成后暂停待验收、多区缺显式目标/范围外目标/非法Workflow及未知profile启动拒绝；既有研发及旧general兼容。测试使用临时配置、sql.js和fake渠道，不调用真实Provider，最终清理；真实工作区目录清单无新增。

真实React StrictMode表单＋内存API的独立浏览器烟测通过：研发托管项disabled且原因可见→选择需求分析师模板→选择托管工作区与模型→创建结果为controlled/safe；编辑模拟失败后模型/岗位等输入保留、错误靠近保存按钮，手动重试成功，并截图检查。用户原Owner原型/目标草案标签未修改。无关面板在烟测中占位，不能将它等同于真实Electron IPC或生产数据库UI验收。

模板生成--check及原资料静态校验通过；后者仍不证明模型岗位能力、Shepherd动态检索或派工完成。类型检查、11文件定向Biome、main/preload/renderer构建、diff与文档门禁通过。没有全量test/lint、打包启动或真实模型验收。

## 版本与上线边界

Electron0.12.108，共享包0.2.26。分支feat/ai-project-owner；未自动推送、合并、安装或改现有员工。用户0.12.104不会自动获得源码修复，仍需固定Electron验收、完整打包和明确的更新安装操作。

新controlled档案不能交给不认识该配置的旧版本执行；旧0.12.104可能将未知profile误作普通员工。更新前应保存数据备份，不能混用新旧安装或在新档案写入后无恢复方案地降级。当前新版本自身已增加未知profile的fail-closed启动校验，但不能逆向改变旧二进制。

controlled不进入当前Pilot白名单，不具备新的Owner授权/费用停止保证或自动岗位匹配；子任务与Workflow受控适配未接入。本轮不宣称AO-04/AO-06、Owner自主闭环或发布验收完成。

## 复验入口

```bash
bun test apps/electron/src/main/lib/agent-controlled-context.test.ts
bun test apps/electron/src/renderer/components/projects/agent-employee-form.test.ts
bun test apps/electron/src/main/lib/agent-development-execution.test.ts
bun scripts/generate-employee-role-templates.ts --check
python3 docs/ai-team/checks/validate.py docs/ai-team
bun run typecheck
bun run docs:check
```

完整UI烟测构建器和本批日志保留在会话工作台的`employee-form-smoke/`，只用模拟数据，不写真实配置。
