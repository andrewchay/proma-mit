# Owner规划D：真实受控启动与单请求离线链

## 范围

C提交`c5c84719`完成准备/资料费用UI与Run留证，保留A启动禁令。D将常量禁令替换为严格权威用途/来源解析，复用已有`startControlledTask`费用确认、范围与有效期、队列、原子认领和最终Provider出口，不新增自由Caller、授权表或Pilot grant。保存目标、配置、准备或确认提案仍不授权调用。

仅显式`acknowledgeModelCosts: true`且匹配当前预检的启动入口可排队。实际发送复核同execution/session、冻结Goal/Plan/Owner配置及载体/channel/model/workspace、凭据与最终序列化body，固定4096输出、一次请求、零工具/历史/MCP/Skills/标题/压缩/重试。费用确认没有金额硬上限；SDK未报告费用或usage时保持unknown/null。真实Provider调用须另获逐次授权，本片没有执行。

## 停止约束

完整链BDD发现：持久停止意图已经落库但Runtime未确认abort时，原Session解析仍可能允许新发送。已以RED→GREEN修复：`resolveOwnerPlanningSession`在启动和最终请求解析时独立拒绝任何停止意图。该记录只收紧能力，不证明远端终止或费用结清；已经发送的SDK错误/晚到响应继续保全证据，不产生提案。内部生成入口也保留C的独立停止校验。

## 占位完整性

独立D审查复现真实准入后request_hash被改为空仍生成的P2。修复增加nullable `integrity_hash`，新占位固定次序摘要覆盖全部列，Run处理前验证身份、64hex、时间、快照与摘要；空摘要、非hex、另一合法SHA替换、时间变更或legacy NULL均保raw callback、转stale、不生成/结算或补发。旧表additive ALTER，旧行不补造证明；本地SHA不是签名，也不抵御有任意SQL写权限的攻击者。

## 可复现离线验收

`apps/electron/src/main/lib/owner-planning-controlled-flow.test.ts`使用真实费用授权/claim、Worker、Orchestrator、ElectronRuntimeServices、AISDKAgentAdapter、RuntimeCore与AI SDK Provider桥。替身仅为Electron/主机活动状态以及最后`proxy-fetch`内存transport；transport严格接受假域名，不访问网络。所有数据与假凭据使用临时`PROMA_TEST_CONFIG_DIR`并清理；Bun数据库路径为sql.js，不能冒称原生WAL。

当前12项112断言覆盖：
- 费用未确认0请求；真实proposal一请求，冻结system/user与4096实际body，无tools，generated/proposed、carrier暂停、无业务派工或学习。
- 必要澄清不生成Plan、不自动追加询问，usage缺失保持null、费用unknown。
- Goal/费用范围/TTL/载体配置或Owner marker变更0发送。
- 同preview并发双击复用execution、唯一admission、一请求。
- SDK length、网络失败、partial断流或302只尝试一次，保原文/unknown费用，不释放admission、不重试。
- 发送后心跳失联转stale，晚到成功不生成；错generation不停止其他attempt，正确Runtime取消先持久stop但不冒称同步远端证明。
- DB关闭重开保持来源、receipt/outcome/admission；重复原启动不能补发。

真实Electron/preload/UI→IPC→原生SQLite/WAL→受控启动→Worker→SDK离线链与独立审查均已wait all收敛，最新Native runId `642c8bd7-1eaa-4784-b08a-14b8022f23da`：proposal/clarification及五类准入损坏共7个内存HTTP，各一次；旧schema保持7条原行及NULL integrity不补造证明。父核验native源码哈希无差异。复审关闭P2、未确认剩余实质P0/P1/P2。完整560文件失败0、typecheck/lint2001/docs/build通过，不能用C的fake admission/callback替代这些D证据。真实Provider费用、生产导航、安装、断电/多进程和远端停止仍不在本片证据范围。最终验收状态以ledger中D收束条目为准。
