# P01/P02 第二十二批：策略模型与一致性钉板证据

> 2026-10-09 22:55 GMT+8。基线 972e85d4。

## P01 策略模型

- `packages/shared/src/types/harness-policy.ts`：`HarnessPolicy`（policyVersion=1、单调递增 revision、三项保证）+ 强度 `off|preferred|required`。
- 严格解析：未知字段/非法强度/非法 revision/版本不符全部拒绝（`HarnessPolicyError` 带逐条原因）。
- 只收紧：`assertPolicyTightensOnly` 要求 revision 递增且每项强度不下降；硬底线（权限硬拒绝、Web Bridge 逐次确认、Pilot fail-closed）是代码常量不在策略内，策略无法放宽它们。
- Provider 前拒绝：`requiredGuaranteeGaps` + `assertRuntimeSatisfiesPolicy` 把 required 保证映射到能力——budgetStop→supportsBudgetStopThreshold、toolScheduling→新能力 supportsInProcessToolScheduling（claude=false，SDK 子进程不在本进程锁域；proma/pi/ai-sdk=true）、planWriteScope→supportsPlanMode。新保证必须登记映射，否则视同不支持。
- 接线：`ai-sdk-agent-adapter` 在进入 turn 循环前 `assertRuntimePolicy('ai-sdk')`（fail-closed）。proma/pi/claude 的接线归入 P03 一致性批。
- 配置侧：`agent-runtime/harness-policy.ts` 从 `~/.gravitas/harness-policy.json` 加载；缺失→默认策略（不写盘）；损坏/未知字段→抛错、**保留原件不覆写**、拒绝受控运行。

## P02 一致性钉板（只断言当前事实）

`policy-invariants.test.ts`：
- Plan 模式：`.md` 写允许、非 `.md` 写拒绝、写 Bash 拒绝、只读 Bash/Read 允许。
- safe + worktreeScopedWrite：树内写允许、`../../etc` 逃逸拒绝；无 scope 时写一律拒绝。
- Pilot 预算闸与权限模式无关：不支持的 runtime 在任何权限模式下 fail-closed；预留 0 无法核验。
- 调度器接线不吞工具结果（Write/Bash 真实执行返回内容）。

## 诚实边界

- `bypassPermissions` 在 ai-sdk 工具权限层确实全放行（现状）；硬底线在预算闸/Web Bridge 逐次确认/Pilot fail-closed 等独立层，钉板测试明确这一分布而非假装权限层有硬 deny。
- required 保证目前仅三项；UI 展示与审计原因归 P04。
- 默认策略不引入新拒绝面（budgetStop=off、toolScheduling=preferred、planWriteScope=required 是既有行为的固化）。

## 门禁

全仓 564 文件 3826 pass/0 fail/28 skip；九包 typecheck、lint、docs/diff 通过；真实 workspace 36→36。

---

## P03/P04 第二十三批补记（2026-10-09 23:20 GMT+8，基线 0f67a117）

### P03 一致性矩阵与四 Runtime 接线

- `adapters/harness-policy-conformance.test.ts`：声明式矩阵 `MATRIX` 逐项钉住四个 runtime 的 retired / budgetStop / inProcessToolScheduling / planWriteScope；能力翻转必须同步改表，否则测试失败。
- 默认策略在全部 runtime 上无缺口；required budgetStop → proma/pi 拒绝、claude/ai-sdk 通过；required toolScheduling → claude 拒绝（SDK 子进程不在锁域）。
- 预算阈值合并语义跨 runtime 一致（不支持→拒绝；支持→取更严格值）。
- retired runtime（claude/proma）仅做数据级断言，不构造会话、不为其恢复运行级验收。
- Provider 前拒绝接线补齐：`pi-agent-adapter.query`、`provider-agnostic-agent-adapter.query`（proma）、`claude-agent-adapter.query` 入口均先 `assertRuntimePolicy(...)`；四个 runtime 全覆盖。

### P04 UI 与配置拒绝

- IPC `harness-policy:get-state`（只读）：返回 missing/ok/invalid 三态、revision、逐条拒绝原因、各 runtime 缺口（`buildRuntimeGaps` 共享语义，主进程与 UI 同源）。
- AgentSettings 新增「策略」Tab（`HarnessPolicyPanel`）：作用域路径、强度三态着色、缺口列表、损坏时的错误与原因；只读不编辑，并注明审批与沙箱是独立层。
- 配置拒绝行为（P01 已落地，P04 验收）：损坏 JSON / 未知字段保留原件不覆写并拒绝受控运行。

### 门禁

全仓 565 文件 3832 pass/0 fail/28 skip；九包 typecheck、lint、docs/diff 通过。

### 边界

- UI 只读：策略修订只能改文件， tightened-only 校验在解析/断言层，尚无专门的"保存策略"写入路径（暂无需求）。
- 审计原因（每次拒绝写入审计流）未接线：当前拒绝以异常形式上浮到会话错误，未追加到 web-bridge/computer-use 式 JSONL 审计。
