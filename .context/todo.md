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
- [ ] **待实测**：在项目管理「指定责任人」复现一次，把错误/诊断文本发来精确判定 R1/R2/R3
