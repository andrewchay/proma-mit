# G2 -58：评审命令（reviewer run）自动派发

- [x] 读透 intent-store / budget-ledger（runs 上限）/ dispatch 测试夹具
- [x] dispatch：commandIdentity 参数化 role；按 assignee 区分 executor/reviewer 路径
- [x] reviewer 守卫：须存在已结算的 executor 命令；max_runs 由账本强制
- [x] reviewer 提示词与幂等键 intent:{id}:reviewer:0
- [x] 测试：reviewer 派发 / 早于执行拒绝 / executor 身份哈希不变 / 超次数拒绝
- [x] 门禁：定向测试 + 全仓 electron + typecheck + biome
- [x] 台账 -58 + 提交（7802afd8 已推送）
