# Gravitas 浏览器重构 · 工作日志

## 2026-10-06 主题预览视觉统一（艺术系定稿方向）
- 用户反馈：界面背景纹样"太丑"→ 已移除 ThemeTextureLayer 及 theme-texture-layer.tsx，运行界面恢复纯净；预览卡图案保留。
- 用户反馈：简笔 SVG 预览"太简陋"，与青花瓷/青绿山水不一致 → 用户选定**艺术系**：全部主题卡改画作预览，卡片只留图与名称。
- 实现：Pillow 程序化绘制 10 幅同系列插画（纸纹颗粒 + 柔边笔触 + 有限配色），脚本 `scripts/generate-theme-preview-art.py` 可复现；AppearanceSettings 简化为统一 `image` 结构，删除 theme-preview-decor.tsx 与调色板分支；被替换的 ember 旧截图预览已删（新图 `theme-ember-*-art.webp`）。
- 注意：程序插画非真实画作，质感与真迹有差距；若需更高保真需引入真实图像素材（如公版名画）或外部生成能力。
- 验证：typecheck / theme-contrast.test（3 pass）/ build:renderer 全过；版本 0.12.103。

## 2026-10-05 分支清理与 backup 内容核实
- main 与 origin/main 同步（0ccc2b3e）；删除 21 个已完全合入的分支（本地 12 + 远程 9，含 5 个干净 worktree），`git branch -d` 全部通过。
- backup/main-pre-rebase-20260927 已删除（tip 94bcd94f，2026-10-05 删除；内容经逐项核实全部被 main 覆盖，如需找回走 reflog）。
- `backup/main-pre-rebase-20260927` 形式领先 51，patch-id 级仅 6 个差异；逐项核实均已被 main 覆盖：研发委派 M1（main 有 development-review.ts + 冻结快照）、双链跳转（NoteMarkdownView wikilink 放行）、记忆范围多对多（经 feat/project-memory-scope PR #12 合入 3603a42e）、青花瓷主题（theme.ts/AppearanceSettings）、new-media/research 领域包（subscription.ts 逐行一致）、头像设置页（SettingsModuleView）。backup 无独有内容，可删。
- 真正未合入：`feat/marketing-campaign-full-chain` 7 个提交（09-11，营销 Campaign 全链路，落后 358）+ stash@{0} wip-before-marketing，均搁置待定。

## 2026-09-29 智谱额度查询调研（用户暂缓，未实现）
- Coding Plan 额度可查：`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`，Authorization 头直接放 API Key（无 Bearer 前缀为准，带 Bearer 亦有实现兼容）；响应 `data.level + data.limits[]`，unit 3=5 小时窗口、6=周窗口，可仿 Kimi 双窗口展示。
- 团队版（zhipu-coding-team）：同端点加 `?type=2`，且必须带 `bigmodel-organization`（org-xxx）+ `bigmodel-project`（proj-xxx）头；ID 在团队后台用量页 URL 获取；401/403 视为凭据失效。接入需渠道表单新增两个可选字段。参考：cc-switch `query_zhipu_team_at`、token-monitor `zaiTeamLimits.js`、sub2api issue #6266。
- 按量付费（zhipu）现金余额/资源包：无公开 API，第三方均只查套餐额度，无法像 DeepSeek `/user/balance` 那样展示。
- 未来接入点：`channel-manager.ts` getChannelPlanQuota 增加智谱分支（仿 Kimi/DeepSeek 模式）+ `renderer/lib/channel-plan-quota.ts` supportsChannelPlanQuota 加 `zhipu-coding`/`zhipu-coding-team`；团队版另需 org/project ID 配置与请求头注入。

## 2026-09-29 ChatGPT Codex 订阅可用性修复（未真机验收）
- 原链路只接 OAuth/模型目录/额度：普通 Chat `getAdapter(openai-codex)` 缺注册；Pi Agent 空 Base URL 被拦，按自定义临时 provider 注册会把 OAuth JSON 当 API Key 及 Anthropic 协议发送。不能靠普通 OpenAI adapter 兼容 Codex。
- 采用 Pi 0.87.1 内置 `openai-codex` 模型和 `openai-codex-responses` transport，应用渠道的加密凭据通过 `CredentialStore` 读取/串行刷新回写（不读写 Pi 全局 auth.json）。Chat 用原生 Pi SSE + 原 Chat UI 事件/工具循环；Pi Agent 直接注册内置模型，独立压缩仍未接入，避免错误协议；Chat/Agent 标题也走内置协议。
- 离线 mock 原生 SDK 确认发往 `https://chatgpt.com/backend-api/codex/responses` 且 Bearer 为 access token，事件包含 text_delta/done；未使用用户真实凭据发起外网调用。Chat 现限 SSE 保持应用内代理适配；真实订阅成功率和登录状态仍需应用内验收。

## 2026-09-28 Project Pilot Goal：放开 ai-sdk Pilot readiness（-56）
- 发起链路核查发现最后一个代码闸：启动预检要求 `supportsBudgetStopThreshold=true`，而 `ai-sdk` 为 false——直接发起会被 readiness 拦在 queued、零请求。用户批准放开（PILOT-20260928-56）。
- 依据：ai-sdk 单次费用上界已由受控出口在**发送前**强制（证据派生→预留→body 核验，否则 HTTP 零发送），强度高于事后阈值；注册表唯一证据 glm-5.3-flash，其他模型 fail-closed；非 Pilot 零行为变化。
- 改动：shared 能力位翻转 + 注释；agent.test.ts 两处断言、runtime-budget.test.ts（ai-sdk 现按预留精确换算 0.5 USD，proma/pi 保持 throw）。readiness/G1/研发执行夹具仍用 proma 验证阻断不变。
- 门禁：定向 43 PASS；全仓 511 文件零失败、typecheck 三包 0、Biome 0 error（3 warnings 既有）、docs:check、diff-check 过。未调用 Provider。
- 提交 0d143d8c（-54/-55）之后本条为 -56。G2 现在真正只等用户应用内发起。

## 2026-09-28 Project Pilot Goal：逐请求结算/释放 + G2 参数确认（-55）
- 用户确认 G2 参数：预算 **$1.00**（1,000,000 micro-USD）、**2 命令 × 6 轮**、总请求硬上限 20、24h 有效；渠道为 bigmodel 国内 OpenAI 兼容端点（端点/Key 用户已配置）。已核实 bigmodel 模型 ID 为小写 `glm-5.3-flash`（渠道必须精确一致，否则 derive 拒发）、其兼容接口支持 `stream_options.include_usage`。
- 实现 `project-pilot-request-settlement.ts`：`settlePilotRequestUsage` 按证据价同一套 BigInt ceil 结算实际用量——实际 ≤ 预留 → `settled` 释放差额（可用额度 SUM 改为 settled 行按实际计、其余按预留计）；实际 > 预留或证据不可用 → `needs_reconcile` 保持全额占额；幂等不改判。`markPilotRequestNeedsReconcile` 只作用于 reserved 行。
- 出口增强：流式请求注入 `stream_options.include_usage`（注入后才算指纹/核验/发送，三者一致）；`settleAfterResponse` tee 响应副本异步解析 usage（SSE 取最后一个带数值 usage 的 data 块 / JSON 取 `usage` 字段）→ 结算；非 2xx、无 usage、解析异常、tee 异常全部转待对账；进程崩溃残留保持 reserved。理论占额状态只有 reserved/needs_reconcile/settled 三类，无静默蒸发路径。
- schema：`pilot_request_reservations` 增加 `settled_cost_micros` 列与 `settled` 状态（CHECK 联动）；旧库（de82e991 版表结构）走重建迁移，逐行保留占额并重建双索引——迁移测试模拟降级→重开验证。
- 复核（glm-5.3-flashx 子会话）结论「通过」：算术与预留一致且单调性保证不超；无超释状态组合；tee 全路径落三类状态之一；迁移不丢数据不丢索引。
- 验证：定向 44 PASS；全仓 511 文件零失败、typecheck、lint 0 error（3 warnings 既有）、docs:check、git diff --check 全过。
- **边界**：结算信任 Provider 诚实回执；`max_tokens` 对 thinking 的服务端强制语义在 G2 首呼实测；国内 CNY 牌价由 USD 证据覆盖依赖 USDCNY≥5.6。G2 现在只等用户在应用内发起（readiness 位仍未全局放开，走既有 Pilot 门禁发起）。

## 2026-09-28 Project Pilot Goal：ai-sdk 生产受控出口接线（-54）
- 新增 `project-pilot-request-exit.ts`：`createPilotRequestFetch` 把最终 HTTP body 依次送入 derive→reserve→verify 后才调真实 fetch；非字符串 body、预算不足、证据不符、多模态、缺 max_tokens 一律 throw（HTTP 零发送）。`resolvePilotBudgetForSession` 用 `getAgentExecutionBySessionId` 反查 Pilot 受控执行（库不可用直接抛错=fail-closed，宁可拒发不可漏发），仅 Pilot 会话注入出口，普通会话零行为变化。
- 接线点：adapter 构建 `pilotRuntime`（单闭包覆盖整 turn）→ `createAgentAISDKModel` 注入 fetch + streamText 强制 `maxOutputTokens=131072`（来自 GLM 证据）；手动/自动/工具内/溢出恢复四条压缩路径经 `fetchFn` 走同一出口；requestId 用 randomUUID 全局唯一，崩溃重复发送由请求体指纹唯一约束兜底。
- 审查发现的绕过路径已堵：Pilot 会话可派生 Agent 子代理，子代理新 sessionId 解析不到预算上下文——Pilot 模式直接禁用 runSubAgent（工具报错零花费），未做预算化透传。
- 验证：定向 36 PASS（exit 5 + adapter 14 + evidence 8 + envelope 3 + reservation 6）；全仓 510 文件零失败、typecheck、lint 0 error（3 warnings 既有）、docs:check、git diff --check 全过。协作子会话复核结论「通过」：无绕过路径、非 Pilot 零行为变化、重试/多 step/溢出恢复全覆盖。
- **边界**：逐请求结算/释放未做（预留持续占额，响应后对账是下一片）；Pi 出口未接（独立验收）；`max_tokens` 对推理 token 的服务端强制语义未实测（首次真实试跑前必须验证）；真实调用仍需渠道/次数/预算授权（G2）；渠道模型 ID 必须精确为 `glm-5.3-flash`。

## 2026-09-28 Project Pilot Goal：登记 GLM glm-5.3-flash 首条真实价格证据
- 用户指定 glm-5.3-flash 为首个目标模型。核对 Z.ai 官方文档（docs.z.ai 定价页与 GLM-5.3-Flash 模型页）：输入 $0.15/M、输出 $0.50/M、缓存输入 $0.03/M（更低不抬高上界）；上下文 1M、最大输出 128K；OpenAI 兼容 Chat Completion；思考不可关闭（计入输出）。注册表登记首条真实证据 `zai-glm-5.3-flash-2026-09-28`（micro-USD/M：150,000 / 500,000，上限 1M / 131,072）。
- derive 新增 fail-closed 闸：① 拒绝多模态消息块——GLM-5.3-flash 原生多模态，image_url 引用图片的 token 数不受 body 字节数约束，会击穿「token ≤ 字节」上界（messages[].content 与 google contents[].parts 均受检）；② 拒绝非 function 内置工具（如按次计费 web_search）；③ body 为 JSON null 等非对象形态干净拒绝。纯文本 function 工具放行。协作子会话（glm-5.3-flashx）复核牌价换算与拒绝逻辑，结论通过、无必改项。
- 定向 17 PASS；全仓 509 文件零失败、typecheck、lint 0 error（3 warnings 既有）、docs:check、git diff --check 全过。
- **边界与风险**：国内平台同名模型牌价 ¥0.80/¥2.80，USDCNY≥5.6 时被此 USD 上界覆盖，汇率/牌价变动须另增证据条目；`max_tokens` 对推理 token 的服务端强制语义未实测，接线时必须验证（这是「可执行上限合同」的核心）；生产 fetch 出口仍未接 derive→reserve→verify；真实调用仍需渠道/次数/预算授权。渠道配置必须用精确小写模型 ID `glm-5.3-flash`。

## 2026-09-28 Project Pilot Goal：价格证据入库与请求体指纹（审查阻断修复）
- 针对上轮 code-reviewer 的两个阻断落地：① 新增 `project-pilot-request-evidence.ts`——价格证据必须是版本库内审核注册表的条目（生产默认为空，未注册即 fail-closed 拒绝）；`derivePilotRequestEnvelope` 从**最终 HTTP 请求体**逐字节生成 SHA-256 指纹作为 requestEvidenceId，按 provider 协议（openai/anthropic `max_tokens`/`max_completion_tokens` 取小、google `generationConfig.maxOutputTokens`）提取输出上限并与模型审核上界夹紧；输入上界用「token ≤ UTF-8 字节数」夹紧模型上限。② `reservePilotRequest` 现在校验包络费率/上界与证据一致、requestEvidenceId 必须是 64 位十六进制指纹，并新增同执行内指纹唯一约束（DB 唯一索引 + 事务内检查）——崩溃后换 requestId 重发同一请求体被拒绝；新增 `verifyPilotRequestBody` 供发送前核验请求体未被篡改。
- 验证：定向 14 PASS（evidence 5 + envelope 3 + reservation 6，含索引存在断言）；全仓 509 测试文件零失败、typecheck、Biome 0 error（3 warnings 既有）、docs:check、git diff --check 全过。审查员复核三项问题后确认闭合：模型标识强制绑定（google 需出口核验 URL 后经 verifiedModel 传入，缺失即拒）、上界 safe 正整数防 NaN 绕过、唯一索引兜底跨连接并发。
- **边界**：生产 fetch 出口尚未调用 derive/verify（接线是下一步）；价格注册表还没有任何真实模型条目，出现真实价格前任何预留都会被拒；仍无逐请求结算/释放与跨执行恢复策略；「token ≤ 字节数」是保守真上界但比实际粗（对 CJK 约 3 倍高估预留）。

## 2026-09-28 Project Pilot Goal：请求级原子子预留离线原语
- 增加 `project-pilot-request-envelope.ts` BigInt 向上取整算术及 `project-pilot-request-reservation.ts` SQLite 命令内请求子预留；子预留不会重复计入 grant，总占额限制在命令预留内。核验 running execution/session/command、活动 grant 与时效；requestId 只可用一次，崩溃重开仍占额，缺证据、无预算、写入回滚则拒绝。离线定向 7 PASS，全仓 508 文件零失败。
- **严格边界**：priceEvidenceId/requestEvidenceId 现在只是调用方提供的字符串，并不验证价格文件或最终 HTTP body，不能接生产真实 Provider；已预留后还没有可核验的每请求响应结算/失败回收机制，继续保守占额。SQLite 事务只序列化单个项目数据库句柄内写入；跨进程并发需要额外锁或架构单写者证明。此切片是内部原语，不代表任一 Runtime 费用能力验收或放行。

## 2026-09-28 Project Pilot Goal：AI SDK 受控 HTTP 出口首段离线验证
- `packages/core/src/providers/ai-sdk-bridge.ts` 的 OpenAI/Anthropic/Google 模型工厂增加可选自定义 `fetch` 注入，默认不变。OpenAI-compatible AI SDK 模型通过本机 loopback 夹具调用 `generateText(maxRetries:0)`；注入出口捕捉最终 body 后抛错，断言 HTTP 零发送，6 PASS、typecheck PASS。没有接生产预算，也不意味着任意 Protocol 已通过费用验收。
- 下一步共享预算包络应有逐请求数据库原子子预留、可审核固定价格/输入上界/输出强制参数，并在 AI SDK 生产 `streamText` 的所有内部 step 及 Pi 每请求接入；重试、压缩与工具新增请求均须纳入或禁用。

## 2026-09-28 Project Pilot Goal：双 Runtime 客户端预算包络决策
- 用户确认长期保留 Pi 与 Vercel AI SDK（仓库 `ai-sdk`），两者均可作受控 Pilot 候选，不必 Pi 优先；同意先做客户端受控请求出口的离线方案，未授权真实付费请求。
- 当前 `ai-sdk-runtime-core.ts` 每次 turn 使用 Vercel `streamText`，工具循环内可发多次模型请求，且外层有整轮重试/独立压缩；`packages/core/src/providers/ai-sdk-bridge.ts` 的 OpenAI/Anthropic/Google 工厂当前未注入自定义 fetch。Pi 主流走 prepareRequest/onPayload，但已有 soft gate 不是硬美元上限。共享账本应承接命令预留下的每请求子预留，两个 Runtime 分别注入受控出口。Provider/model 价格和 token 上界若无法验证，必须在发送前拒绝；这仍不等同 Provider 实际账单的绝对硬限。
- `project-pilot-readiness.ts` 首版仅允许 `proma`/`ai-sdk`，`pi` 仍排除；共享能力位里两者 `supportsBudgetStopThreshold=false`。后续每 Runtime 独立验收、独立启用，不把“支持自控费用包络”等同现有 `supportsBudgetStopThreshold`（后者语义偏运行中停止）；正式 G2 仍需授权。

## 2026-09-28 Project Pilot Goal：结算失败不准成功回写
- 发现 `recordPilotTerminalUsage` 曾吞掉结算异常，员工服务随后继续任务交付。现在返回账本 settlement，Pilot 完成必须同一 command `settled` 且 grant 未暂停；null/needs_reconcile/归属错则保持失败、任务暂停、不做成功统计或交付。由于账本目前只接受终态执行，先持久化为失败「费用待结算」，结算成功后才提升 completed；崩溃窗口也不留假成功。纯门禁＋员工＋账本定向测试与全仓门禁另见台账。此项没有提供 Provider 原始费用可信性。
- 重要后续：完成分支前的卡点、研发证据采集失败、停止、超时也各自有 unknown 结算/停等路径；正式 Pilot Pi 启动仍禁用，不能以单元测试声称纵向链完成。

## 2026-09-28 Project Pilot Goal：Pilot 终态成功回写保守门禁
- 审计 `handleExecutionComplete`：原先 `recordPilotTerminalUsage` 虽能把缺回执记为 unknown 并撤权，但发生在 execution completed 后，仍继续任务回写与交付；不能把费用失败与执行成功混同。现在成功回写前检查 Pilot 执行：员工配置为 Pi 一律不能报告成功（尚无可核验终态 result）；来源与员工配置不一致、缺 Runtime 费用或 token 字段亦拒绝，转 `handleExecutionError` 并以 unknown 停等。普通非 Pilot 语义不变。
- 纯门禁与普通员工测试定向 23 PASS，typecheck PASS；正式 Pilot Pi 启动仍被 readiness/capability 关闭，未验证其真实回调纵向路径。其他 Runtime 本地 `total_cost_usd` 是 Runtime 转述，字段有效并不意味着 Provider 原始账单可信；这里只保留已有 Runtime 结算语义，不宣称 Provider 可信或费用上界完成。

## 2026-09-28 Project Pilot Goal：员工终态回调离线边界
- 复用 `agent-development-execution.test.ts` 的隔离 Git worktree 与假 headless runner：普通 Pi 研发员工（无 pilotCommandId）成功回调无 SDK result 时 execution=completed、任务仍 paused 待人工验收；失败回调后迟到成功保持 failed，不交付。定向 20 PASS。这只覆盖员工服务普通 Pi 入口，**不是 Pilot Pi 的 unknown 结算纵向验收**。
- Pilot Pi 正式 `tryStartExecution` 在 readiness/capability 阻断，现有测试已证 queued 不触发 runner；为了测试回调若强行跳过此门禁，会误示 Pilot 已放行。账本原语 unknown 结算与普通 Pi 回调分别有证据，但两者的正式纵向路径尚未打通；需要在保持生产门禁的前提下设计可注入/回放的受控回调测试，不应直接改 capability。

## 2026-09-28 Project Pilot Goal：DeepSeek Flash 候选契约与终态停等复核
- 候选限定官方 `deepseek-flash`／OpenAI-format `https://api.deepseek.com` 的 Chat Completions；这是审计对象，不是已选试跑模型。官方 [模型与价格](https://api-docs.deepseek.com/quick_start/pricing) 当前称版本 DeepSeek-V4.1-Flash，1M context、384K 最大输出、峰时 cache miss $0.30/1M input、output $1.20/1M；但明确保留调价权，旧模型别名可重映射。官方 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion) 称 `max_tokens` 为 1～393216，默认 thinking enabled；官方 [token usage](https://api-docs.deepseek.com/quick_start/token_usage) 明确字符换算只是近似，以响应 usage 为准。不能把这些动态网页值直接冻结为硬保证，也不能把 Pi `contextWindow` 推断或注册 `cost=0` 当计费上界。
- 保守静态算例（仅用于排查量级，**不是验收上界**）：即便假设 input≤1M、output≤384K，按当前峰时非缓存价也可达约 $0.7608（不考虑输入输出共享 context 的进一步收紧）；与 Pilot 某笔预留 500 micros（$0.0005）的数量级不符。关键不是计算公式，而是尚未在发送前获得可依赖的输入 token 计数/线上最终参数及价格锁定或服务端硬额度；即使发出后返回 usage，也不能追回单请求超额。
- 终态离线回归加强：现有 `settlePilotExecutionUnknownUsage` 对已完成执行写 needs_reconcile、暂停 grant；本轮在 `project-pilot-budget-ledger.test.ts` 增断言未知费用保持 500 micros 原预留且后续预留拒绝，定向 25 PASS。此为**账本原语**证据，非 Pi 真实回调纵向测试；Pi adapter 没有 SDK result，不能伪造成本以求结算。下一步应验证员工服务真实 Pi 回调路径与故障交错，同时继续寻求可信价格/上限协议，不能凭离线夹具打开 readiness。

## 2026-09-28 Project Pilot Goal：Pi 请求体第二道屏障
- 0.87.1 `agent-loop.js` 的 `prepareRequest` 在 streamFunction 前；`sdk.js` 将 `onPayload` 接到 Pi Provider；`openai-completions.js` 在 SDK `create(params)` 之前调用该钩子。本机 loopback fixture 验证准入→payload 审核→拒绝 HTTP 零发送，未触发真实 Provider。
- 有限模式增加预算门禁 `beforePayload()`，未准入/已阻断不能进入既有 onPayload；有效准入链保留既有钩子。定向三文件 36 PASS。此门禁只核验一条请求的归属，未限定价格、输入 token 或输出上限；不能叫美元硬封顶。Pi 终态仍无可核验 SDK result，现有员工服务没有 result 时走 unknown 用量结算，不应伪造 result。

## 2026-09-28 Project Pilot Goal：Provider 请求层与官方契约核查
- Pi coding-agent `sdk.js` 的 `buildRequestOptions` 从 `SettingsManager.getProviderRetrySettings()` 取得 `maxRetries`，传至 `modelRuntime.streamSimple`；pi-ai `openai-completions.js` 通过 `retryProviderRequest` 包装 OpenAI SDK（SDK 自身 maxRetries=0）。先前仅设置 `retry.enabled=false` 只关闭 agent loop，不必然禁 Provider HTTP 重试。现有限模式已设置 `retry.provider.maxRetries=0`；mock＋真实 SDK SettingsManager 共 30 PASS、typecheck PASS。普通模式不改变。
- `pi-model-registry.ts` 动态注册模型 `cost` 全为 0、maxTokens 按 provider 给 16K/32K/64K，contextWindow 部分启发式推断；这些均非 Provider 价格或输入计费上限。DeepSeek 官方 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion) 规定 `max_tokens` 1～393216、输入＋输出受模型 context length 限制；[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) 当前列 1M context、peak/off-peak 输入缓存价与输出价，并声明价格可变、保留调整权。Pi openai-completions compat 对 deepseek.com baseUrl 推断 max_tokens；最终 payload 仍可经 onPayload 改写。不能把请求前本地估算当固定 USD 硬上限。
- 安全结论：第 1 包尚未通过；在选定有可审计价格变更控制和实际请求/响应约束的 Provider/模型之前，不放开 Pi Pilot。无 Provider 调用。

## 2026-09-28 Project Pilot Goal：单请求费用边界核查
- Pi 0.87.1 `SettingsManager.getCacheWarmingMode()` 未配置时默认 `streaming`；`sdk.js` 创建 CacheWarmer，刷新通过独立 `modelRuntime.streamSimple` 发送，绕过当前 agent `prepareRequest` 门禁。有限费用模式显式设 `cacheWarming: off`；普通模式保留 streaming。adapter mock 相关 29 PASS、typecheck PASS，未调用 Provider。
- `pi-ai` 可设 `StreamOptions.maxTokens`，但无统一输入 token Provider 硬限，也不能凭 Pi 模型元数据证明 Provider 实际接收的输出限制；不同渠道可能改写 token 下限/推理计费，缓存与价格 tier 亦须审计。第 1 工作包仍未达成，不得把软门禁或本地价格估计当硬 USD 封顶；readiness/capability 保持关闭。
- 下一步优先确定支持可审计输入/输出与价格合同的 Provider/模型组合，验证最终请求参数和计费规则；无法证明则维持 fail-closed，不以冒烟代替证明。

## 2026-09-27 Project Pilot 使用 Pi Runtime 的可行性评估
- 决策建议：Pi 可作为受控研发执行内核的候选，先做无模型/无费用的能力验证；不可直接加入 Pilot 白名单或把 `supportsBudgetStopThreshold` 改为 true。当前仓库 Pi 依赖固定 `0.82.1`；所查官方能力以 `earendil-works/pi` v0.87.1 为参考，不能当作已安装版本保证。
- 已接的 Pi adapter 禁内置工具（`noTools: 'builtin'`）、禁隐式 extensions/context，使用 Proma Bridge 的 customTools、权限回调及 abort；这些是工具控制地基，不是费用门禁。首版 readiness 只允许 proma/ai-sdk，并要求调用级费用超额停止能力；Pi capability 明确 false。
- **版本校正**：已安装 0.82.1 并无 agent-core 公开 `finishTurn` / 请求前 `prepareRequest`；`prepareRequest` 在 coding-agent ModelRuntime 内部。0.82.1 有 `shouldStopAfterTurn`（低层循环）、`prepareNextTurnWithContext`（Agent）和可注入 `streamFn`，已用假流验证消息终态观察、工具前拒绝、请求间软预算。v0.87.1 API 不得直接作为当前仓库实现依据。单次请求仍不能按 USD 精准截费或绝对封顶。Pi usage/cost 属本地或 Runtime 转述，Provider 原始请求 ID、可信回执、价格快照需按具体 Provider 独立核验；模型用量/异常/重试/缓存与并发都须计入。
- 已完成第一段无 Provider PoC：Pi agent-core 0.82.1 假 stream＋预算实验 6 PASS；首轮准入、逐轮累计/拒绝下一请求、单次超额/缺费用时禁工具和续轮、失败携带费用保留、手工 abort 接线验证无继续工具调用。合并 22 文件 154 PASS、全仓 typecheck、Biome/diff-check PASS。它**不是产品接线**，没有对真实 adapter/Bridge 的扩展绕过、终态原文身份绑定、请求重试去重或真实 Provider 限额进行证明；这些留待下一切片。G0/G1 不因此通过。
- **0.82.1→0.87.1 升级兼容评估（2026-09-27，隔离 /tmp/pi-087-probe）**：npm 三个包 latest 均 0.87.1，可安装；官方 Agent 冒烟（initialState/streamFn/beforeToolCall/finishTurn/subscribe/prompt）通过。破坏面核对：`shouldStopAfterTurn` 已删（我们没用）；`ToolDefinition`/`ResourceLoader`/`AgentSession` 仍导出；`pi-ai` 的 `./api/*` 子路径保留。**唯一行为断点：`pi-agent-adapter.ts:446` 直接赋值 `session.state.messages`，0.87.0 起 SessionManager 为唯一事实源，赋值不再生效**——须改为 SessionManager.inMemory 或 sessionManager+refreshContext。类型涟漪：0.86.0 `ToolResultMessage` 变条件类型、details 限 JSON、provider stream 入参 Context→TranscriptContext（影响 message-adapter 与 adapter 测试）。无 ExtensionRunner/turn_end emit 用法，边界变更不影响。升级后 `prepareRequest`（每次请求前，含首次）正好对应 Pilot 预算准入闸门，比 PoC 的 subscribe 门控更干净。建议：等当前未提交切片收敛提交后，单独切片做 bump+修 adapter+全量回归；bump 前不改 lockfile。
- 已完成实际 bump（台账 `-35`，2026-09-27 晚）：三件套 0.82.1→0.87.1＋lockfile；唯一行为断点确认即 `session.state.messages` 赋值，已改为 `buildPiHistorySessionEntries`＋`SessionManager.inMemory(cwd, undefined, entries)` 预种子（创建 AgentSession 前注入）；`DefaultResourceLoader.systemPromptOverride`、`session.agent.toolExecution`、消息转换类型均兼容；adapter 测试 `streamSimple` 改经 `normalizeContext`。3 个真实 SDK 回归测试（条目链/上下文回读/AgentSession 可见历史）PASS，全仓 498 文件 0 失败。真实 Provider 冒烟（PROMA_PI_REAL_API）未开，Pi 能力位/白名单不变，G0/G1 不变。
- 参考：`apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`、`packages/shared/src/types/agent.ts`、`apps/electron/src/main/lib/project-pilot-readiness.ts`、`apps/electron/package.json`；官方源码 https://github.com/earendil-works/pi/blob/v0.87.1/packages/agent/src/types.ts 与 https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/extensions.md 。

## 2026-09-27 会话健康自测（用户问：运行记录/监听能否发现"卡住"）
- 本轮可观测信号（模型侧标记为证）：工具结果被裁剪多处、子代理交接被 budget 压缩多次、一次子代理"操作已中止"；行为面：用户 3 次发"继续"并追问"为什么总是卡住"，每轮重复恢复性读取（CLAUDE.md/台账/todo/git status）。
- 实测结论：标记注明"原始记录保留于会话 JSONL"，但 4 次不同路径探查（~/.proma/sdk-config/projects 各种 glob）均未定位到当前会话文件——**记录存在、不可寻址**。无监听层聚合信号，检测完全依赖用户察觉；这就是"总是卡住"未被系统发现的原因。
- 设计映射（与 Pilot 同构）：把"事实账本＋对账＋边界分类"用于会话自身——①稳定可寻址的会话记录接口（路径约定或查询 API）；②watcher 按 JSONL 计算每轮健康度：交付物数/轮、用户修复事件、裁剪/压缩/子代理失败计数、重复读取比、轮次时长；③stall 边界分类（context_overflow / handoff_loss / loop_without_progress / gate_blocked）写入健康账本；④对账触发行为自适应并**主动上报**，而非等用户问。
- 盲区：模型只见裁剪标记、不见被裁内容，长会话早期轮次滑出视野，自我计数不可靠——外部 watcher 是必要组件，标记自报仅作辅助。
- 本轮即时改进：小步直读、最小输出、停用大型探索委派（用户明确不需要 skill 形式）。

## 2026-09-26 Pilot PM04 历史候选意图账本
- 新 `project-pilot-intent-store.ts` 从权威只读观察生成 task/decision/delivery 候选，SQLite 在项目迁移时建 `pilot_intents`，删除项目同事务清理。相同候选幂等、失效设 stale；重启后历史可追溯，展示前必须 `getCurrentPilotIntents` 重读事实。
- 此账本没有 runnable command、执行器或通知；同项目 Promise 队列仅串行本模块对账，**不提供跨其他事实写者的严格快照一致性**。旧 open 只是上次对账结果，绝不能用于授权/自动派发。
- 新账本 5 PASS，连同现有 Pilot/chain/service 五文件定向 24 PASS；typecheck/lint/diff-check PASS。无后台事件接线、真实自治或 UI 真机。PM04 仍部分完成。

## 2026-09-26 Pilot PM11 任务列表审阅入口
- 任务列表标题打开现有 `TaskReviewPanel`（Radix Dialog），而不是新建审批服务；操作成功后刷新项目权威任务列表。面板已有真实验证、冻结差异、验收/返工/应用；范围变更后重新冻结仍待实施。
- 代码审查修正手写 modal 键盘问题及 Review 后列表不刷新的问题；typecheck/lint PASS，未进行 UI 真机。

## 2026-09-26 Pilot 策略草案首片（不可激活）
- 新增 `project-pilot-policy.ts`：每项目 JSON 草案，始终 paused；无 IPC 与执行器消费。写入限制预算、员工、模型、过期时间、revision；项目存在校验，缺实际绑定校验与预算扣减。
- 为未来跨进程安全边界，采用独占目录锁覆盖读-改-写、随机独占临时文件、fsync 文件及目录；配置损坏和符号链接失败关闭。遗留锁需人工核查后恢复。
- 7 个安全测试 PASS。**这不是实际授权，也没有付费模型动作；磁盘伪造 active 会被拒绝。** 下一步只能在真实绑定、预算预留、持久命令幂等和激活来源完成后开放。

## 2026-09-26 Pilot 只读观察首片（未完成自治）
- `project-pilot-reconcile.ts` 从权威 SQLite 任务/阻塞/执行与版本化 chain 只读投影项目状态和待当前 local-user 的候选决策、交付审阅；批量读取执行，指纹只用于展示，不是写命令锁。
- `PROJECT_IPC_CHANNELS.OBSERVE_PILOT` → main handler → preload → ProjectView「概览」，前台刷新；不启用后台监控/模型/派发/审批。
- 新测试 7 PASS，project-chain 4、project-service 1 回归 PASS；typecheck、lint 通过。无 UI 真机、真实模型、全量测试。
- 下一步先持久项目授权/预算/受控命令/恢复，再接事件和依赖唤醒，最后做 Reviewer/收件箱续跑；当前不宣称 G0/G1/P0 通过。

## 2026-09-26 项目智能管理目标校准
- 用户原始诉求是项目管理者持续组织不同角色 Agent、无需进入工作区/会话推动步骤、必要时主动请求审批。UI/收件箱和配置简化是配套，不得替代主动管理主线。
- 静态审计基线 HEAD 017f9088：headless/自动派发/Proactive/人工 Review 已有；项目级规划、依赖解除唤醒、自动技术审阅返工及统一审批续跑尚未接成闭环。未运行本轮新测试或真实模型。
- 当前有效目标：`docs/plans/2026-09-26-project-pilot/goals-and-roadmap.md`；台账：同目录 `ledger.md`；完整实现证据：`implementation-audit.md`。历史 design.md 已显著标记被取代。
- 第一交付改为受控主动推进纵向切片＋最小审批入口；基础权限/预算/幂等/暂停/隔离/最小崩溃安全同步交付，真实试跑前确认具体授权。
- 已校正旧 Task Review ledger 的 11/11、R02/R03/G4 和零审批误推；保留 R01 PASS 及历史日志，未知仍 unknown，不等于自治通过。
- 本轮仅文档变更；没有修改产品代码、CLAUDE/README、运行权限或创建业务任务。

## 2026-08-13 元素定位收敛 + 站点信任权限 ✅
- **纯 AX ref**：BrowserEngineBackend.click/type 只认 Observe 的 AX ref（`r{g}-{i}`），不再做 element_id/selector DOM 定位回退（用户决策）；upload 仍用 CSS selector（合法例外）。Click/Type 工具描述已改。
- **站点信任权限**：agent-permission-service 新增 `noteWebBridgeHost/trustWebBridgeHost/trustCurrentWebBridgeHost/isWebBridgeSiteTrusted`；`WebBridgeDownload` 在当前站点被信任时自动放行，`WebBridgeUpload` 永远逐次确认，导航/点击/输入保持工具白名单；web-bridge-service 在 rememberSnapshot 时 note 当前 host。
- **验证**：53 单测全过 + 全仓库 typecheck 过 + 门面真机 slice 全过。

## 2026-08-13 WebBridge 底层已替换为 browser-engine（多标签 CDP）✅
- **交付**：在 proma-mit 新建 `browser-engine/`（controller/cdp/policy/key + 单测），并把 `web-bridge-service` 的默认 backend 换成 `BrowserEngineBackend`（实现 `WebAutomationBackend`，委托 browserController）。
- **工具**：新增 `WebBridgeObserve`（AX 结构化）+ `WebBridgeNewTab/ListTabs/SelectTab/CloseTab`（多标签），tool-registry 已注册，Observe/ListTabs 进 SAFE_TOOLS。
- **验证**：38 单测全过 + 全仓库 typecheck 过 + 门面集成真机 slice（`webbridge-backend-slice.ts`）全过。
- **架构要点**：
  - `WebAutomationBackend` 是稳定边界，`BrowserEngineBackend` 适配多标签 CDP 到单 tab 语义（`ensureTab` 兜底首标签）。
  - 保留 `PlaywrightCdpBackend`（外部 Chrome 桥接仍走 playbackwright）。
  - Snapshot(DOM) 保留给 WebBridgeSnapshot；Observe 走 AX。
  - 事件定位归一：click/type 支持 AX `ref`；`element_id`/`selector` 的 DOM 回退**尚未实现**（遗留项）。
- **遗留**：（1）click/type 对 element_id/selector 的 DOM 回退未做；（2）站点信任权限未加（下一步）；（3）browser-script-policy 受控脚本未接。

## 2026-08-13 方向锁定（重要）
**目标仓库：`/Users/chaihao/LLM/proma-mit` = Gravitas（package `gravitas`，remote `andrewchay/proma-mit.git`）**
- ❌ 不是 `ma-proma`（那是 `andrewchay/mapro.git`，package `ma-pro`，另一独立产品，上游指向 proma-mit）。
- 三个仓库浏览器实现归属：`Proma`(上游,CDP/AX/多标签) → fork `proma-mit`=Gravitas(DOM脚本,丢CDP/AX/多标签) → fork `ma-proma`(延续Gravitas + Playwright爬虫 + 站点信任权限)。
- **本次任务**：重构 proma-mit 的 WebBridge → 多标签 + 结构化AX + CDP真实输入，保留下载，并新增站点信任权限。
- 权限决策：引入 `ma-proma` 的 `trustedWebBridgeHosts` 站点信任机制（导航/点击/输入/下载在可信域名下自动放行，`WebBridgeUpload` 永远逐次确认）。注：proma-mit 现有无此机制（只 `isWebBridgeFileTransfer` 文件逐次确认）。
- CDP 引擎：Electron `webContents.debugger`（对标 Proma）。
- 首版：垂直切片（独窗口内多 tab + AX Observe + 真实点击填表 + 可信域下载）。
- 计划文件：`.context/plan/gravitas-browser-refactor.md`

## 仓库认知记录
| 仓库 | product | remote | package | 浏览器现状 |
|------|---------|--------|---------|-----------|
| `/Users/chaihao/LLM/Proma` | Proma | ErlichLiu/Proma | proma | CDP AX_tree 多标签 ref（最全）|
| `/Users/chaihao/LLM/proma-mit` | **Gravitas** | andrewchay/proma-mit | gravitas | 独立BrowserWindow + DOM脚本 + Playwright(cdp外部) |
| `/Users/chaihao/LLM/ma-proma` | MAPro | andrewchay/mapro | ma-proma | 同Gravitas + Playwright Python爬虫 + 站点信任权限 |

## 历史：Proma vs Gravitas 浏览器差异（源码级）

## 仓库关系
`proma-mit` 是从 Proma fork 出来的变体（产品名 Gravitas），但 in-app-browser 已被完全重写为不同的实现。

## 核心结论
两者底层都是 Electron/Chromium，但**驱动机制与语义抽象完全不同**：
- **Proma**：Electron 原生 `webContents.debugger`（CDP）+ `Accessibility.getFullAXTree`，**无障碍语义（AX）驱动**，元素用可回溯的 `backendNodeId`，ref 带代际防错位。
- **Gravitas**：独立 `BrowserWindow` + **注入 DOM 脚本**（`executeJavaScript` 执行固定模板），**DOM 驱动**（非 AX），元素用「写入 `data-proxima-web-element-id` 属性生成的 id」。

## Gravitas 实现细节（reading web-bridge-service.ts / web-automation-backend.ts / web-bridge-tools.ts）

### 底层结构
- 每个 Agent 会话一个**独立可见的 Electron `BrowserWindow`**（1200×800，sandbox 开、nodeIntegration 关、contextIsolation 开）。
- 两种 backend（`WebAutomationBackend` 接口统一）：
  - `ManagedElectronBackend`（mode=`managed`）：`window.webContents.executeJavaScript(...)` 注入 DOM 脚本控制页面。
  - `PlaywrightCdpBackend`（mode=`chrome-cdp`）：用 `chromium.connectOverCDP`（playwright-core）连接**用户主动开启远程调试的真实 Chrome**，复用其登录态与页面——Proma 完全没有此能力。
- 不需要任意脚本工具：只有固定的 navigate/snapshot/click/type/scroll/setFileInput 模板脚本。

### Snapshot（`SNAPSHOT_SCRIPT` DOM 注入）
- 遍历 `document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')`，可见性过滤后取前 **200** 个，生成可交互 `accessibility[]`。
- 另递归生成树形 `accessibilityTree`（上限 500、深度上限 6，含 shadow DOM）。
- 返回 `url / title / text(innerText≤16000) / accessibility / accessibilityTree`。
- **元素 id**：`frameId + '-e-' + N`，通过 `element.setAttribute('data-prom-web-element-id', ...)` 持久化；selector 兜底 `id/#name/[role]/tag`。
- 注意：**不用 CDP AX tree**，纯粹 DOM 遍历 + 可见性启发式（offsetParent / getClientRects）。

### 交互（DOM 模板脚本）
- Click：`element.click()`。
- Type：`focus()` → 对 input/textarea 用原型 value setter 写入 / contenteditable 写 textContent → 派发 `InputEvent('input')` + `Event('change')`；`submit=true` 时补派发 Enter keydown。
- Scroll：`window.scrollBy({top:~,instant})`，clamp 100–2000。
- Upload：`DataTransfer` 注入 `input.files`，不落盘。
- 全部经 `executeJavaScript`，参数 JSON 序列化（数据非代码）。

### 文件
- Download：`fetch(url,{redirect:'error'})` → 落盘 `{configDir}/web-bridge-downloads/{sessionId}`，≤50MB。
- Upload：**通过系统文件选择器**（`dialog.showOpenDialog`）选文件，Agent 不能传本地路径；内容注入当前页面，不暴露绝对路径。

### 安全边界
- `normalizeWebUrl`：仅 http/https，拒绝带用户名密码。
- `will-navigate` / `will-redirect` 拦截非 http/https；`setWindowOpenHandler` deny（不新建未受管窗口）。
- 无 Proma 的 proma-file:// 本地预览协议；也不做文件系统/局域网白名单（Chromium 决定）。

### Profile / 登录态
- partition `persist:proma-web-bridge-{sessionId}`，**按会话隔离**（Proma 按工作区隔离）。
- 可 `connectChrome` 桥接到用户真实 Chrome 复用登录态。

### 权限模型（agent-permission-service.ts）
- `requiresPerActionApproval = isComputerUseTool || isWebBridgeFileTransfer(Download/Upload)`——**只有文件传输逐次确认**。
- 导航/点击/输入等页面交互：auto 模式下走 SDK classifier / 会话白名单（`"始终允许"`，对齐 kimi-cli `approve_for_session`），可免逐次确认。
- Worker 子代理工具调用自动批准（除需逐次确认的 CUse/文件传输）。

### 审计
- `appendWebBridgeAudit` 写 `~/.gravitas/web-bridge-audit/events.jsonl`，记录 navigate/click/type/scroll/download/upload/connect_chrome/stop（含 elementId、length、bytes）。

## Proma 实现要点（回顾）
- 见本文件下方旧条目；核心差异快速对照见下。

## 快速对照表

| 维度 | Proma | Gravitas |
|------|-------|----------|
| 驱动 | Electron `Debugger`(CDP) + `Accessibility.getFullAXTree` | `BrowserWindow` + 注入 DOM 脚本 / Playwright-core 连真实 Chrome |
| 语义 | AX 无障碍树（backendNodeId） | DOM 遍历 + 可见性启发式（写属性生成 id） |
| 元素引用 | `ref=r{g}-{i}` 带代际，失效校验 | `element_id`（data 属性）+ selector 兜底，重快照刷新 |
| 交互 | CDP `Input.dispatchMouseEvent`/`insertText`（真实输入事件） | DOM `element.click()`/value setter + 派发事件 |
| 任意 JS | 有受控 `BrowserExecuteJavaScript`(≤20KB) | 无任意 JS 工具，仅固定模板脚本 |
| 本地预览 | `BrowserPreviewOpen` + `proma-file://` 授权目录 | 无 |
| 外部 Chrome | 无（完全隔离） | `WebBridgeConnectChrome` 复用登录态 |
| 文件收发 | 禁下载 | Download/Upload（文件传输逐次授权） |
| 权限 | 首次风险声明 + 操作可 abort，按会话白名单 | 导航确认 + 文件传输/ComputerUse 逐次确认，页面交互走白名单 |
| 登录态隔离粒度 | 按工作区 | 按会话 |
| Tab 管理 | 多 tab（Agent/用户分离，上限20） | 单 BrowserWindow 单页（无多 tab 工具） |
| 快照内容 | 结构 AX 元素 | DOM 元素 + innerText + 通用 selector |

## 一句话
Proma 用 CDP AX 语义做稳定的 Agent 自动化（多 tab、本地预览、工作区隔离、受控 JS）；Gravitas 的 WebBridge 更轻——用 DOM 脚本注入 + 可桥接用户真实 Chrome，聚焦"看得见、可人工介入、能发文件"，权限在导航与文件层面把关，页面交互交给白名单。
