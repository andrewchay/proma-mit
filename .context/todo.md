# Gravitas 迭代 — 三大需求追踪

> 更新：2026-08-06
> 优先级：需求1 > 需求2 > 需求3
> 详细方案见 `plan/gravitas-iteration-plan.md`

## 需求1：子任务并行执行 ✅（已完成 & 已提交）

- [x] 定位根因：provider-agnostic-agent-adapter 工具串行执行
- [x] 重构智能分组并行：SubAgent/普通工具 Promise.all 并发，串行工具保持顺序
- [x] 测试全绿 + typecheck
- [x] 已提交 `af2b3c2`（electron 0.11.18）

## 需求2：Agent 模式发送排队 ✅（已完成 & 已提交）

- [x] orchestrator 会话级 FIFO 队列 + 入口排队 + pumpNext + promote/cancel/status
- [x] IPC/preload + agent-service 薄包装 + queue_state 广播
- [x] 前端排队贴片 + AgentView handleSend 入队 + 全局订阅校正
- [x] 测试全绿 + typecheck
- [x] 已提交 `6324fe1`（electron 0.11.19, shared 0.1.53）
- [x] 已打包 v0.11.19 DMG 成功（out/Gravitas-0.11.19-arm64.dmg）
- [ ] **待用户：覆盖安装到桌面实测排队/并行交互**

## 需求3：飞书权限（指定责任人拉不到人）🟡（代码加固已提交，待实测定位）

- [x] 深入分析根因（基于 SDK 官方语义），见 `notes/feishu-contact-search-deepdive.md`：
  - R1 部门树空 + department_id=0 只抓根部门直属 → 抓不到子部门成员
  - R2 find_by_department 的 department_id 类型与枚举 ID 不匹配
  - R3 权限范围（需在飞书后台配「部门节点」）
- [x] 代码加固：部门枚举 8 层 + open_department_id + find_by_department 双 ID 类型并集（已提交 `6715297`，electron 0.11.20）
- [x] 复数路径修正：`/contact/v3/user/find_by_department`（单数）→ `/contact/v3/users/find_by_department`（复数），
      单数会被飞书网关直接 404；提取 `buildFeishuFindByDepartmentUrl` + 单测 2 用例锁定路径拼写（⚠ 未提交）
- [x] **实测通过**（2026-08-07）：项目管理「指定责任人」已能拉到用户 ✅
      —— 关键根因正是复数路径（单数 `user/find_by_department` 被飞书网关 404）。
      部门枚举+双ID并集+复数路径三层加固叠加生效。
- [x] **任务状态回写修复**（2026-08-07，⚠ 未提交）：同步报 `Invalid Param 'task', must not be empty (1470400)`
      —— 根因：飞书 Task v2 更新接口 `PATCH /open-apis/task/v2/tasks/:id` 请求体必须用 `task` 字段包裹新值
      `{ task: {...}, update_fields: [...] }`，原代码直接平铺 `completed_at/update_fields` 导致飞书校验失败。
      已修正 PATCH body + 新增 `feishu-todo-provider.test.ts` 单测 2 用例锁定请求体结构防回归。

## 需求4：飞书文档拉取会议纪要 ✅（已完成，未提交）

> 对齐已有「钉钉文档拉取」，为飞书增加同等能力。
> 按用户确认：支持 docx / sheets / wiki（含 bitable）/ 完整 URL 输入 / UI 与钉钉合并为一个「云文档拉取」入口。

- [x] `feishu-doc-fetcher.ts` 新建：docx（/docx/v1/documents/{id}/raw_content）、sheets（查工作表列表+读首表 A1:K200）、wiki（get_node 拿 obj_token 再路由）、bitable（多维表格首表记录）；tenant_access_token 缓存；复用飞书 Bot 凭证（getFeishuBotById + getDecryptedBotAppSecret）
- [x] `feishu-doc-fetcher.test.ts` 单测 7 用例锁定 URL 解析（docx/sheets/wiki + 查询参数 + larksuite 国际版 + 非飞书链接拒绝）
- [x] `project-service.ts` 新增 `importFeishuDocAndExtractTasks`
- [x] `work-module.ts` 新增 `FETCH_FEISHU_DOC` 常量；`work-module-ipc-handlers.ts` 注册 handler（复用渠道 LLM）
- [x] `preload/index.ts` 新增 `fetchFeishuDoc` 桥接 + 类型
- [x] `ProjectView.tsx` MeetingNotesPanel：「钉钉文档拉取」→「云文档拉取」，加钉钉/飞书平台切换
- [x] typecheck 全绿 + 单测 7 通过
- [ ] **待用户：真实飞书链接实测（需企业应用开通文档/表格/知识库读取权限）**
