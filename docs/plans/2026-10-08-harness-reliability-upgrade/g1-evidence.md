# G1 离线行为矩阵证据

> 2026-10-11 12:15 GMT+8。基线 553833de。

## 结构

`apps/electron/src/main/lib/agent-runtime/harness-g1-behavior-matrix.test.ts`（17 例）：

- **B01–B16 活场景**：每个 B-case 直接驱动真实机制做小场景断言（非重跑内部实现）：
  - B01 验证记录未来时间/错身份拒绝；B02 V01 回执 subject 不符 + V03 goal 绑定不符双拒绝；
  - B03 判定只依据结构化计数（stdout 含 PASS 不判验证）；B04 检查点上下文漂移拒绝继续；
  - B05 调度错误释放锁后续可用；B06/B07 未加载/旧 schema 明确拒绝；
  - B08 同键写执行窗口不重叠（锁事件）；B09 unknown 全局排他；
  - B10 finishReason=length 判不完整（零执行=E03 收束声明）；B11 queued 取消零执行（锁事件）；
  - B12 required 保证 Provider 前拒绝（claude 拒/ai-sdk 过）；B13 Golden 集通过+归档诚实；
  - B14 legacy Skill 无哈希按旧数据处理+敏感记忆拦截；B15 TCC 关闭+默认策略四 runtime 无缺口；
  - B16 finished/verified/accepted 三态文案区分。
- **B17**：ACP 线 M7 无宿主阻塞，显式 out-of-scope（GA 门禁独立）。
- **映射清单程序核验**：每个 B-case 的 owner 证据文件存在性由测试断言（路径纠错两处：compaction/memory 测试在 lib 根不在 agent-runtime 子目录）。

## 结论

G1 = **离线确定性机制通过**。按台账规则："仅有逐项真实证据后可称确定性机制通过"——除离线逐项外，HR07/HR09/R01 已有真实运行证据；G1 通过表述限定为确定性机制级，不替代 G2（工程门禁）/G3（真实 Provider 完整验收）/G4（默认推广）。

## 边界

- B04/B05/B10/B15 为 mapped+轻量活场景组合，重场景由定向文件承担（清单核验）。
- B17（ACP 越权）在 M7 启动前无机制可测，out-of-scope 是诚实声明非通过。
