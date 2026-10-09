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
