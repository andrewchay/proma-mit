# H03 无副作用基线与 G0 冻结证据

> 2026-10-10 23:40 GMT+8。基线 0fee9d24（已推送 origin）。

## H03 落地

1. **harness-flags.ts：开关单一事实源**（4 例）
   - 登记表只含 `toolScheduling`（默认启用）；缺失文件 = 全部默认，无新拒绝面。
   - 严格解析 overrides：未知字段/非法值拒绝；持久化原子写（tmp+rename）；损坏文件原件保留并拒绝加载。
   - 说明：模块与测试同批编写，未单独记录红灯，如实注明。
2. **harness-baseline.test.ts：B15 无副作用基线钉板**（2 例）
   - flag off（调度禁用）与 flag on 的离线安全基线结果逐任务一致（行为兼容；禁用退化为全串行仍持锁的 E04 语义由既有生命周期测试承担）。
   - TCC 始终关闭：核心工具注册表（createCoreTools）无 TCC/context-compiler 工具。
   - retired Runtime 不恢复由 P03 矩阵承担，不重复钉。
3. **G0 冻结**：contracts.md 与 benchmark-spec.md 顶部加入冻结声明（范围、锚点、解冻程序）。

## 门禁

全仓 578 文件（见提交记录）；typecheck/lint/docs/diff 通过；workspace 36→36。electron 0.12.145→0.12.146。

## 边界

- harness-flags 目前只有查询/持久化与登记表，加载接线到调度器 service 的启动路径**未接**（现仅测试与回滚演练直接调用 setToolSchedulerDisabled）；接入是扩容项，需 G0 后新批次。
- "日志无敏感正文"由既有锁事件设计（只记键不记参数）与回执脱敏承担，未新增专项扫描。
