# Owner 固定包与真实研发冒烟（2026-10-26）

结论：**平台安装包冒烟通过，Owner 真实业务冒烟未通过。** 本轮不自动重试付费请求，不把模型 completed 或模型自述 approved 当作交付完成。

## 构建与授权

- 基线 `d84508f8` 加 `codex/owner-validation-integrity` 当前未提交修复；没有合并、提交或安装替换用户应用。
- 完整 main/preload/renderer/resources 构建、两个 macOS 原生模块构建、node-pty/better-sqlite3 重编译及 ZIP 打包完成。
- 包内版本 `0.13.332`，`gravitasChannel=dev`，`gravitasTestBuild=true`。版本号与旧包相同，必须按以下hash区分。
- 未签名 arm64 ZIP：`apps/electron/out-owner-test/Gravitas Owner Test-0.13.332-arm64-mac.zip`，286729948 bytes，SHA-256 `a6fe8787cc0dd49a816f1d09edbee38a4a237c67b63b1c3be0449b1af9b93641`。
- ASAR：309923336 bytes，SHA-256 `b1214a90fb87fd6f3ff00daa83b9161ec928f7bca30bb1415d085f8129a81aa5`。已核对包内包含请求次数门禁和结果保存路径。
- 用户明确授权：GLM-5.3-Flash，新隔离profile、合成2048目标，总预算1.40美元、最多8次模型请求。只使用已配置的智谱渠道，没有发送真实项目源码或PDF。

## 实际结果

| 项目 | 证据与结果 |
|---|---|
| 不收费安装包冒烟 | 实际Electron退出0，SQLite、资源/Skills、知识库及隐藏浏览器6项检查通过 |
| 凭据预检 | 两次在发送前被加密格式阻断；两份导出数据库中规划准入与员工请求预留均为0，无模型请求 |
| 员工执行 | 真实Runtime completed；1次Write写出index.html，模型请求2次 |
| 正式验证 | 六项中四项通过：加载、16格棋盘、初始数字块、方向键合并；最高分持久化与重开入口断言失败 |
| 旁路浏览器 | 只检查加载与棋盘，两项通过；不能覆盖或替代正式六项结果 |
| Reviewer | Runtime completed，模型请求2次；输出自述approved，但quote使用省略号拼接，严格原文校验拒绝落库；技术评审表0行 |
| Owner最终验收与原对话交付 | 未执行，报告均为not_checked |
| 请求与费用 | 共4次请求，账本结算5012 USD micros（$0.005012），无未结算员工请求；这是按冻结审价和usage计算的账本值，服务商账单尚未核对 |

项目：`c7afe7df-3d46-4e26-b704-e2233808ce9d`。真实业务结果：[report](../../../.context/owner-validation-integrity/live-development-20261026-124215/owner-real-chain-report.json)。文件清单：[manifest](../../../.context/owner-validation-integrity/live-development-20261026-124215/manifest.json)。导出11个文件的SHA-256均已独立重算匹配。

## 已暴露的问题与处理

1. 冒烟准备仅声明“方向键移动与合并”“分数与结束判定可见”两个标准，却冻结了最高分与重开断言。下一轮应先把目标、验收标准和验证命令对齐，不能把不一致的夹具直接归因于员工能力不足。
2. Reviewer把两项失败解释为超出验收范围并自述approved，引用又采用不连续片段拼接。现有严格服务门禁拒绝了结果并持久写入attention；不得放宽原文校验来制造通过。
3. 原包装脚本只看安装包退出码，平台passed可能掩盖业务失败。现已补独立业务结果检查：研发正式验证未全过或无准确approved评审时返回非零；已用同类反例和包装脚本回归验证。真实调用原始日志仍保留其原退出0事实，不改写为新版脚本实跑结果。

## 证据保全与检查

- 包装脚本先导出再清理；导出失败保留原profile。目的目录校验覆盖符号链接祖先；读取拒绝符号链接/硬链接和身份变化。
- 导出项目数据库、原始会话回执、成果、快照、正式验证与attempt记录，不导出channels、SDK、MCP或Skills配置。
- 证据包只用于只读审查。原工件中的绝对路径仍指向已清理profile，不能当作直接恢复工作区的备份；SQLite可按只读immutable模式离线审查。
- 两种Provider入口在同一准入/预留事务内合计计数，最多8次；费用仍受项目、命令和Owner20%门禁约束。
- 出口与导出相关回归4文件0失败；新增结果判定及包装脚本回归3文件0失败。全仓typecheck与10个本轮源码文件Biome检查通过。code-simplifier已只读复核。

本轮已使用4次请求，授权内剩余4次没有自动使用；后续先修正冒烟标准与提示，再决定是否进行新的受控运行。完整Owner自治、最终验收、原对话交付及真实停止仍未验收。
