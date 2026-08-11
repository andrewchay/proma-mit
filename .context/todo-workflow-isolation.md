# Workflow 独立项目隔离 — 任务追踪

> 2026-08-10 启动。状态：✅ 已完成（代码 + 测试 + code review + 文档；待打包装实测）

## 已完成
- [x] 与用户确认方案：Workflow 借独立 project 实体目录 + 执行会话完全分离不进 Agent 列表
- [x] 独立项目目录：config-paths.ts 新增 getWorkflowProjectsDir / getWorkflowProjectPath（`{configDir}/workflow-projects/{workflowId}/`，初始化 .context）
- [x] 会话来源标记：AgentSessionMeta.sessionSource; createAgentSession 增参; workflow 会话不建 workspace 下 session 子目录
- [x] Agent 列表完全分离：listAgentSessions 过滤 sessionSource==='workflow'（所有 UI 消费点收口）
- [x] Workflow 节点绑定项目目录：workflow-agent-executor 传 projectDir + sessionSource；设计器会话也标 workflow
- [x] **cwd 覆盖跨全部 runtime**：orchestrator 的 claude / pi / provider-agnostic 三分支都透传 projectDir（修复了「初版仅 claude 分支生效、pi 默认 runtime 静默丢弃」的 P1）
- [x] 测试：agent-session-manager(过滤+隔离)、workflow-agent-executor(projectDir 断言)、新增 agent-orchestrator.projectdir.test.ts(provider-agnostic cwd 覆盖 + pi 缺目录早报错)；全 pass
- [x] 全量 typecheck 通过（8 package）
- [x] 验证：lib 全量测试失败集与 pristine 完全一致（26 fail 均为既有 quota/routing 环境性失败，非本次引入）
- [x] 文档：CLAUDE.md 存储树 + 关键设计；note.md 记录实现与遗留建议

## 遗留建议（P2，非阻塞）
- projectDir 无根锚定白名单校验（当前注入面受控：仅 workflow executor 传 getWorkflowProjectPath）
- storage-service cleanupArchivedSessions 未覆盖 workflow 会话的磁盘清理（影响小）
- 打 DMG 覆盖安装实测 workflow agent 节点 cwd 与 Agent 列表分离
