# 本轮任务：落地卡兹克体系三个差异（2026-11-02 16:35 起）——已完成

目标：A) 事件路由规则层 B) 审批外推飞书卡片 C) 发布后核实步骤
授权边界：允许本地提交与建分支；未重建/未重启应用、未 push、无真实 Provider 费用。
分支：codex/p1-five-direction-slice（本轮 10+ 提交，最新 8a412e14）

## 状态：A/B/C 全部完成 + D 验证通过（62 例全绿 / tsc / biome 零告警）

- [x] 0. 探索接入点（explorer 挂掉后改为主上下文直接探索）
- [x] A. 事件路由规则层
  - [x] A1. `getEventRulesPath()`（config-paths.ts）+ 统一事件 schema `AgentAutomationEvent`
  - [x] A2. event-rules.json 读写/校验/默认模板（readEventRules/writeEventRules/validateEventRule）
  - [x] A3. `event-router-service.ts`：dedupeKey 去重（10min 窗）/group 并发门（parallel 缺省 1）/tell 策略（needed/always/silent）/workflow-event 执行器懒加载注入
  - [x] A4. 接入 bridge-command-handler（IM 非命令文本旁路 dispatch，不拦截原流程）+ 通知回调广播到绑定聊天
  - [x] A5. 测试 12 例全绿
- [x] B. 审批外推飞书卡片（票拟+批红）
  - [x] B1. `agent-permission-service` 外推通知器（sendToRenderer 后触发，失败不影响审批）
  - [x] B2. `feishu-approval-cards.ts` 纯函数：票拟卡（危险等级配色+允许/拒绝按钮）/回调解析/批红结果卡/失效卡（5 例）
  - [x] B3. `feishu-bridge` 接线：LarkChannel cardAction（WS 卡片帧）+ openId 白名单（默认空=拒绝）+ respondToPermission + resolved 事件同步（渲染端队列消空）+ 卡片原位 PATCH 回写（失败降级文本）
  - [x] B4. 测试 + tsc 通过
- [x] C. 发布后核实步骤（第五步·核实）
  - [x] C1. `delivery-verification.ts`：summary_present + artifact_paths_exist 探针（路径正则提取、上限 8、pathExists 可注入）
  - [x] C2. writebackExecutionResult completed 分支接线（workflow/审批后/headless 三路径全覆盖）
  - [x] C3. `pilot_delivery_verification_receipts` 不可变回执表（immutable trigger，仅 Pilot 执行写）
  - [x] C4. 测试 9 例（含 trigger 拒 UPDATE、INSERT OR IGNORE 幂等）
- [x] D. 验证：apps/electron tsc 通过；7 个测试文件 62 例 0 fail；biome 12 文件零告警
  - 已知无关失败：workflow-event-service.test.ts 固定 /tmp 路径 EPERM（沙箱限制，同 note.md 既有记录）

## 未做（需用户或环境）

- 审批外推的 openId 白名单默认为空（功能显式开启才生效），需要接设置面板/成员映射
- 事件规则 event-rules.json 无 UI，手工编辑文件；webhook 入站未接（桌面无 HTTP listener，可后续走 companion-server）
- 规则的 to.kind=session（直启 Agent 会话）为预留字段未实现
- 门禁/路由改动需重建应用才对运行中的 Agent 生效（旧 bundle）
- 并行会话风险：本轮期间检测到同 worktree 的分支切换（feat/pi-1.4.0-trial ↔ codex/p1-five-direction-slice），已通过"每步立即 commit + cherry-pick 找回"化解；后续并行会话建议各自用独立 worktree
