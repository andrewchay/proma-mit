# Project Pilot 持续目标（2026-09-28）

验收目标：以 Pi 与 Vercel AI SDK（仓库标识 `ai-sdk`）作为长期 Runtime 候选，按费用边界、证据结算、停止恢复、P0 工作流、G0/G1 顺序推进到“可申请受控真实试跑”；可先选择任一候选完成隔离验收，不必 Pi 优先。G2 真实调用首选模型已定为 GLM `glm-5.3-flash`（Z.ai 官方牌价已入库），但仍须另获渠道、次数、预算授权。

- [x] 核对两 Runtime 请求路径：Pi 使用 prepareRequest/onPayload；AI SDK 生产模型工厂在 `packages/core/src/providers/ai-sdk-bridge.ts`，每次请求经过其 Provider fetch；两者共用同一逐请求费用包络/预留契约，但分别接入，不把单 turn 当单 HTTP 请求。
- [x] Vercel AI SDK provider 工厂允许注入受控 fetch（OpenAI/Anthropic/Google）；OpenAI-compatible 假模型经本地出口拒绝时 loopback HTTP 零发送，6 PASS、typecheck PASS。此为接入点证明，生产尚未注入预算出口。
- [x] 首段共享上界算术与命令内请求级原子子预留：safe integer＋BigInt ceil、身份/授权/执行状态核验、不可复用 requestId、同命令累计不超预留、崩溃重开保留占额；离线定向 7 PASS。价格和请求证据 ID 暂由调用者声明，**未经验证不能接生产出口**。
- [x] 证据绑定与请求体指纹：价格证据必须注册于版本库审核表；包络费率/上界不得偏离证据且上界为正整数；requestEvidenceId 强制为最终 HTTP 请求体 SHA-256，同执行指纹唯一（崩溃换 requestId 也拒绝重发同一请求体）；derive 从真实 body 提取输出上限并夹紧模型上界，模型标识强制绑定（google 经出口核验的 verifiedModel 传入）；发送前 verifyPilotRequestBody 核对指纹。审查员复核三项问题闭合。定向 14 PASS、全仓 509 文件零失败。
- [x] 登记首条真实价格证据：用户指定 glm-5.3-flash；Z.ai 官方牌价输入 $0.15/M、输出 $0.50/M（上下文 1M、最大输出 128K）入库为 zai-glm-5.3-flash-2026-09-28；derive 拒绝多模态消息块（messages/contents 双协议受检）与非 function 内置工具。复核通过。定向 17 PASS、全仓 509 文件零失败。国内牌价覆盖依赖 USDCNY≥5.6；max_tokens 对推理 token 的服务端强制语义待接线实测。
- [x] ai-sdk 生产出口接线（-54）：project-pilot-request-exit.ts 受控 fetch——最终 body 依次 derive→reserve→verify 后才发送，预算不足/证据不符/多模态/缺 max_tokens 一律 HTTP 零发送；按 sessionId 反查 Pilot 受控执行（库不可用 fail-closed），仅 Pilot 会话注入；streamText 强制 maxOutputTokens=131072；手动/自动/工具内/溢出恢复四条压缩路径同出口；Pilot 模式禁用子代理委派（绕过路径 fail-closed）。复核通过：无绕过、非 Pilot 零行为变化。定向 36 PASS、全仓 510 文件零失败。
- [x] 逐请求结算/释放（-55）：settlement 模块按证据价同一 ceil 算术结算实际用量，settled 释放差额、超预留/用量不可信转 needs_reconcile 保持占额；出口流式注入 include_usage 并 tee 解析 usage（非 2xx/无 usage/解析失败转待对账，崩溃残留保持 reserved）；可用额度 SUM 按状态计费；旧库表重建迁移。复核通过：无超释组合、全路径落三类状态之一。定向 44 PASS、全仓 511 文件零失败。
- [ ] G2 续跑（首呼已验证钱路：4 请求全过出口逐笔 settled 合计 $0.0083≈¥0.06；-57 修复 worktree 写入豁免与终态门禁后需重新打包应用）。旧项目授权已 paused、命令 needs_reconcile 占 $0.50（释放运营策略未定义）——续跑方案：新建项目（复用 G2-执行/G2-评审员工与 pilot-g2-sandbox 工作区，注意工作区需有 ≥1 提交）→ 新发 $1.00/2 次/24h 授权 → 新建任务绑定工作区派发。验收追加：写入真实落地、执行 completed、评审命令走第 2 run。
- [ ] G2 受控真实试跑（参数已确认：$1.00 / 2 命令 × 6 轮 / 总请求 ≤20 / 24h 有效；渠道 bigmodel 国内 OpenAI 兼容端点 + Key 已配置，模型 ID 须精确 glm-5.3-flash）。**实际计费为 CNY，总花费硬上限 ¥10，超出须单独向用户申请**（$1.00 USD 为客户端预算上界）。**-56 已放开 ai-sdk 能力位，应用内发起不再被 readiness 拦截**。用户操作：bigmodel 渠道启用且含 glm-5.3-flash → 两名 ai-sdk/safe/development 员工（执行+评审）绑同一隔离 Git 工作区 → Pilot 策略（$1.00 / 2 次 / 24h）→ 预检 → 预览 → 发行 → 派任务。验收：回执与 usage 落库；usage.completion_tokens ≤ max_tokens（thinking 计入输出实测）；预留→实际结算余额正确；断流占额转 needs_reconcile 不复用；全程无未过出口的请求；结束后与 bigmodel 账单核对。
- [ ] Pi Runtime 生产出口接线（独立验收；重试、压缩、工具新增请求纳入或禁用）。max_tokens 对推理 token 的服务端强制语义在首次真实试跑前实测。
- [ ] 保留各 Runtime 独立放行条件：同一受控出口、能力位、readiness 与费用结算纵向测试必须单独验收，禁止因其中一条通过而全局放开。

- [ ] 1. 单请求可证明费用边界：固定 Provider/模型/请求负载/输出上限/价格契约，逐请求剩余额度验算；不能证明时 fail-closed，不开放 Pi readiness。
  - [x] 核查 Pi 0.87.1 cache warming 默认旁路，有限费用模式关闭；定向 29 PASS、typecheck PASS。
  - [x] 查清 Pi Provider HTTP 层重试独立于 agent loop，有限模式显式设 `retry.provider.maxRetries=0`；adapter＋真实 SDK 配置 30 PASS。
  - [x] 核对 DeepSeek 官方 `max_tokens`、上下文和价格条款，以及 Pi 注册的动态模型 cost=0；现有路径不能证明单请求 USD 硬上限。
  - [x] Pi 0.87.1 本机 loopback 验证 prepareRequest→onPayload→HTTP；有限模式追加已准入 payload 检查，拒绝时 HTTP 零发送；三文件 36 PASS。此处不计算美元上限。
  - [x] 以官方 deepseek-flash 作为候选审计（非授权选择）：价格与模型别名可变，token 字符比例只是估计；未取得服务端美元硬上限/价格锁，静态算例不得当作保证。
  - [ ] 审计实际输入 token 与线上最终 payload、输出和价格变更控制；取得可执行上限合同或维持 fail-closed。
- [ ] 2. Provider 或可审计价格快照回执、Pi 终态 result 与 Pilot 账本结算；异常保留未知费用。
  - [x] 增账本原语回归：已完成执行无可信结果时 unknown 占额 500 micros、暂停 grant、拒绝后续预留（25 PASS）。
  - [x] 普通 Pi 员工假 runner 回调：无 result 完成保持任务待验收；失败后迟到成功不改写终态（20 PASS）。
  - [x] 员工完成回写前加入保守 Pilot 终态检查：配置 Pi、来源不匹配或缺可解析 Runtime 费用/token 结果均拒绝成功，改走失败 unknown 停等；纯门禁回归与普通员工定向 23 PASS。
  - [x] 完成回写须同一命令 settled 且 grant 未暂停；Pilot 在结算前先持久化失败待结算态，防崩溃留下假成功；账本原语夹具与纯门禁测试通过。
  - [ ] Pilot Pi 员工端纵向结算尚不能走正式入口：readiness 与费用 capability 关闭；不得在测试中绕过门禁假称已验证。Provider 回执/可核价证据仍缺。
- [ ] 3. 停止/恢复的持久结果、代际终止证明及人工对账。
- [ ] 4. 技术评审返工、审批续跑和最小收件箱的 P0 纵向闭环。
- [ ] 5. G0 契约评审，G1 隔离 fixture A01–A07/A09a 故障矩阵。
- [ ] 前述通过后另行申请 G2 受控真实试跑授权；未经授权不调用付费 Provider。

约束：CLAUDE.md/README.md 修改先请求用户许可；Pi Pilot readiness 与费用能力位暂不开放。未提交的 -40～-42 修改保留，提交前复核整个 diff。
