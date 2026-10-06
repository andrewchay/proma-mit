# Claude / Gravitas Runtime 下线风险审计（2026-09-29）

范围：`/Users/chaihao/LLM/proma-mit`，静态只读审计；没有修改产品代码、执行迁移、调用 Provider 或运行测试。审计时 HEAD `7d4bd836`，工作树已有 Codex 订阅相关未提交修改，不应覆盖。术语：UI 的“Gravitas”是 runtime ID `proma`；另有 `claude`，保留候选为 `pi` 和 `ai-sdk`。`@gravitas/*` 是产品包命名，不是要删的 runtime。

## 阻断风险

1. **Workflow 权限边界**：`workflow-agent-executor.ts:163-181` 传节点能力策略，但 `agent-orchestrator.ts:2109-2278` 非 Claude 分支提前返回；`isWorkflowToolAllowed` 在 Claude 路径 `:2651-2659`，受限 Skill 插件 `:2838-2850` 也只在该路径。若现有 Workflow 自动迁到 Pi/AI SDK，工具/MCP/Skill 白名单不能凭现状认为仍被硬执行。先在目标 runtime 的实际工具执行点实现策略，并测试越权拒绝；否则暂停相关 Workflow。
2. **旧会话与 SDK 原生历史**：`agent-session-manager.ts:759-765,840-875` 对 `sdkSessionId` 使用 SDK 原生 fork；`agent-orchestrator.ts:3693+` rewind 区分原生文件快照与 JSONL 截断。`agent-orchestrator.ts:2049-2068` 切非 Claude 会清除 SDK session ID。保留历史只读和导出；变更前备份元数据、JSONL 与 SDK 历史，用户明确接受无法原样 resume/file rewind 后再做可逆迁移；不要批量静默重写。
3. **持久后台配置**：`proactive-target-validation.ts:27+`、`ipc.ts:2307-2311` 只接受 `proma/ai-sdk`；定时任务、监控与 Routine 可能继续引用 `proma`。`project-pilot-readiness.ts:69-76` 只接受 `proma/ai-sdk`，但只有 AI SDK 当前声明预算出口能力；Pi 不可简单替代。先盘点真实实例与运行状态，暂停/迁移再移除。

## 高风险

4. **路由与遗留默认**：`shared/types/agent.ts:679-690,832-838` 合法值仍含两者，默认虽为 Pi；`agent-session-manager.ts:79-83` 与 `settings-service.ts:35-41` 保留旧值。`agent-service.ts:70-75` 注册四路，`runtime-routing-agent-adapter.ts:24-25` 直接索引；先删 adapter 会使旧配置发送抛错。区分历史可读取 ID 与新执行可用 ID，发送前 fail-closed、引导迁移，不做隐式回退。
5. **入口散落**：`AgentView.tsx:280-285` 可选两旧 runtime；`AgentTeamPanel.tsx:79,233` 员工默认 Proma，`project-sqlite-store.ts:2972` 数据层默认 Proma；`agent-collaboration-tools.ts:749` 子会话缺父 runtime 时回退 Claude；`migration-to-server.ts:269` 缺失值回退 Claude；`ipc.ts:1777` 切换比较以 Claude 兜底。必须同步修改入口、持久化和迁移默认，避免产生新旧记录。
6. **渠道/模型可用性**：`agent-orchestrator.ts:2214+` 逐 runtime 校验 Provider，`shared/types/channel.ts:245+,497-512` 有运行时协议矩阵；旧渠道模型不保证 Pi/AI SDK 兼容。逐实例核验，不按 ID 批量改派。旧报错文案仍建议“切回 Claude”。
7. **依赖/发行**：`apps/electron/package.json:53,89-96`、`electron-builder.yml:46-58` 打包 Claude SDK 主包与平台 binary；`agent-session-manager.ts:840`、`agent-collaboration-tools.ts:886`、若干 MCP 工具及 `feishu-bridge.ts:1900` 仍引用 SDK。先将类型和运行调用解耦、决定原生历史兼容期，再移依赖/打包资产，验证各平台打包。不可按包名删 `@anthropic-ai/sdk`，它也可能服务于非 Claude 通道。

## 推荐分阶段门禁

- **阶段 0：定义范围**：停止新选用两 runtime，或彻底删除代码/SDK？确定旧会话只读保留、迁移目标与文件 rewind 取舍。
- **阶段 1：盘点与备份**：会话/员工/定时任务/监控/Routine/Workflow/Pilot/委派和渠道模型按 runtime 统计；保存配置/JSONL/SDK session 数据，识别运行中任务并暂停。当前审计未读取用户实际数据，数量未知。
- **阶段 2：目标能力验收**：Pi/AI SDK 的 Workflow 工具/MCP/Skill 策略、权限交互、headless、恢复、成本闸门逐场景测试；Pilot Pi 保持关闭。先 shadow/灰度并提供回滚。
- **阶段 3：可逆退役**：禁止新建旧 runtime、老会话明确提示/只读，按兼容渠道逐条迁移后台实例；对遗留发送显式拒绝，禁止静默转 Pi。
- **阶段 4：移除实现和依赖**：只有依赖扫描、历史导出/兼容策略完成，且回归、typecheck、各目标平台打包与应用内冒烟通过后，再删除旧 adapter/SDK binary/配置文案。更新 README/CLAUDE.md 需用户单独许可（仓库规范）。

最低回归：历史会话加载/发送拒绝与迁移/分叉/回退，四路旧配置容错；Workflow 越权工具拒绝；后台调度与 Pilot readiness；Provider/模型矩阵；协作子会话；构建和分发包；用户中断及恢复。结论是**目前不建议直接物理删除**，可先软下线新入口，但对正在使用旧 runtime 的后台任务须先盘点。
