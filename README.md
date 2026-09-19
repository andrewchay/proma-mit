# Gravitas

> Gravitas 是开源 AI 桌面应用 **Proma**（github.com/ErlichLiu/Proma）的改造衍生版本。除特别注明外，内容表述为本项目视角。

Gravitas 是一个本地优先的 AI 工作台：把多模型 Chat、通用 Agent、可视化 Workflow、项目管理与 AI 员工、领域能力包、订阅商业化、企业版与私有化部署放在同一个客户端里，数据和配置尽量留在本地。

它不只是聊天框，而是一个可以长期沉淀个人与团队工作流的 Agent 操作系统：简单问题用 Chat，复杂任务交给 Agent，反复执行的流程固化为 Workflow，管理性工作交给项目看板与 AI 员工，垂直领域（营销、出海 sourcing）通过领域能力包按需订阅启用。

![Gravitas 品牌海报](<./generated-images/gravitas-brand-doc-v2.png>)

<video width="560" controls>

<source src="https://img.erlich.fun/personal-blog/uPic/%E7%AE%80%E5%8D%95%E4%BB%8B%E7%BB%8D%20Proma.mp4" type="video/mp4">
</video>

## 产品模块总览

| 模块 | 一句话说明 |
| --- | --- |
| Chat / Agent / Workflow | 三种基础工作模式：回答、行动交付、流程固化复用 |
| 项目管理与 AI 员工 | 看板 / 甘特 / 飞书钉钉同步 / 决策协作治理，AI 员工无人值守执行任务 |
| 领域能力包 | 营销（达人营销 / Campaign / 投放）与出海 sourcing，按插件订阅分发 |
| 订阅与权益 | 微信 / 支付宝下单、验签回调、订阅生命周期、权益门禁 |
| 企业版与私有化部署 | 账号打通、工作区权限、审计合规、成员管理；登录 / 一键部署 / 仪表盘 |
| 可观测与评测 | 会话 span 瀑布图、Token 统计、服务端运行档案 / Signals / 评估数据集飞轮 |
| 桌面体验 | 灵动岛、语音输入、远程机器人、记忆、Goal、自动更新 |

## 现在能做什么

### 基础工作模式

- **Chat 模式**：多模型对话、附件解析、图片输入、Markdown / Mermaid / KaTeX / 代码高亮、并排对话、系统提示词、上下文管理。
- **Agent 模式**：支持 Pi、AI SDK、Claude、Proma 等 runtime（默认 **Pi**，推荐 **Pi** 与 **AI SDK**），提供隔离工作区或直接打开本地项目、权限模式、文件操作、长任务流式输出、计划确认和用户追问；流式期间可追加输入（steer / 软中断），Pi runtime 恢复历史会话前按模型窗口与 usage 自动压缩上下文。
- **Workflow 模式**：把反复要做的流程在画布上编排成可视化执行链（start / end、agent、tool、skill、transform、condition、approval 等节点），发布后可手动、定时或事件触发；支持节点能力白名单发布冻结、失败重试与错误路由、人工审批、无凭证模板的分发 / 升级 / 回滚。
- **Skills & MCP**：每个工作区独立配置 Skills、MCP Server 和工作区文件；内置 Skill 集市与 Skill Set 分组开关，支持外部 Skill 导入并附带启发式安全审计。
- **TypeSafe 判断服务（可选，P0）**：固定使用 `jev-1.13.0`；可对 Skill 路由做不改变实际行为的 shadow 观测，并增强 Chat → Agent 推荐。服务不可用时自动回退现有推荐工具，不参与权限放行或交付物自动验收。

### AI 员工与项目治理

- **AI 员工（Agent Employee）**：在项目管理中定义 AI 员工，指派任务后由 Agent 无人值守执行并回写结果——默认安全模式、按任务申请 Bash / 写文件 / 联网权限、同项目并发排队、60s 心跳保活、可绑定 Workflow SOP 作为执行器；支持 `@AI员工` 提及直接派发子任务。执行护栏包括**任务级 Token 配额**（UI 入口 + 消耗可见 + 用量查询）、**卡点 elicitation**（需要用户确认时外推通知）、乐观锁防并发冲突，以及**项目级 AI 成本面板**。
- **看板与状态管理**：拖拽排序与跨列改状态一次落库、自定义状态列（按 backlog / unstarted / started / completed / cancelled / triage 六个语义组归类，可设颜色与 WIP 上限）、失败自动回滚；飞书 / 钉钉同步按语义组双向映射，外部轮询不会打回本地进行中状态，拖拽排序不触发外部 API。甘特图任务状态标注与优先级排序、项目级 high-level 风险徽标。
- **项目决策与协作链路（本地治理闭环）**：决策链覆盖候选、证据与假设、DACI 拍板、影响任务、执行验证及替代版本（关键决策保存结构化来源定位与校验值，修订显式关联被替代版本）；协作链覆盖项目、Task、责任人、Agent Run / Session、版本化交付物与验收交接——负责人提交、验收人逐项确认 DoD、负责人发起交接、接收人确认或退回。项目与任务 DoD 冻结到交付版本，管理员可为低风险任务配置"成果引用存在 / 权威执行已完成"自动验收器；依赖交接契约绑定真实依赖边，逐项确认后才解除阻塞；流动健康展示 WIP、等待、30 天吞吐、平均周期与 SLE 超时。当前仍是本地单操作身份，远端多人身份认证与外部证据自动对账尚未接入。

### 领域能力包（按订阅分发）

- **营销能力包（ma-*）**：26 个达人营销 Skills（品牌 DNA、品牌屋、消费者洞察、KOL 金字塔、内容日历、脚本工坊、内容审核等）经营销 plugin 以订阅方式分发；配套**营销应用中心**（顶部菜单栏独立视图）、达人库 / 稿件审核 / 内容追踪 UI、Campaign 子系统（campaign-manager + 工具）、广告投放包（投放计划 / 调控审批 / 调控规则引擎）与共享素材层（广告视频生成的分镜 / 引擎 / 合成、视频创意管线）。
- **出海 sourcing 能力包**：面向出海业务的检索核验、画像构建、邮件收发与漏斗指标，检索核验补齐后可完整走通 sourcing 工作流。

### 订阅与权益（商业化）

- **权益是付费能力的唯一权威**：本地开关不能解锁付费能力，领域包与高级能力由服务端下发的权益（entitlement）门禁。
- **真实下单链路**：微信 Native 下单、支付宝 precreate、主动查单兜底；支付回调使用**真实验签**，堵住伪造开通的漏洞。
- **订阅生命周期**：到期降级、退款收回、状态推导；桌面端提供订阅管理 UI、签名权益 API 验证与订阅引导页。
- **账号登录**：邮箱验证码与 OAuth 登录（已替换早期手机号无验证登录），并补齐公网安全边界。

### 企业版与私有化部署

- **企业能力四阶段**：账号打通（服务端 none auth + Electron 连接 + 迁移向导）、工作区级权限落地（含开源版权限适配）、审计合规（完整性校验 + hash 链 + 法律保全）、成员管理（邀请 + 角色分配）；本地租户映射与数据迁移工具、配置版本化与审计日志。
- **私有部署 minimal set**：local / OIDC / both 登录闭环、一键部署 + 部署烟测、健康与注册表仪表盘（成本 / 速度 / 容量 / 准确率）、子 Agent 父子树视图与会话管理。
- **服务端 Web 路线（P0–P5 基础能力）**：独立 Bun server、Postgres 多租户 store、Redis Stream replay、S3-compatible workspace 文件、跨 worker task lease、预算 / 限速、追加式审计、运行指标与僵尸任务诊断；OIDC/JWT、KMS 和管理员审计已有实现与离线测试。生产身份源、真实云 KMS 和真实 Provider 仍需按部署环境验收。

### 可观测与评测

- **会话运行瀑布图**：Pi runtime 采集 tool / task span，JSONL 按月存储，会话面板可视化 span 瀑布图；任务卡点与 AI 成本进入项目级面板。
- **Token 统计**：按会话 / 轮 / 工具 / Skill / MCP / 模型维度统计 token 消耗与费用（设置 → Token 统计）。
- **服务端可观测闭环（P-I～P-IV）**：运行档案 trace_id 闭环 + span 每层 cost、基于 span 树的自然语言 Signals、Agent 自查运行档案、真实 input / output 采样生成评估数据集，形成"追踪 → 评估 → 再追踪"飞轮。
- **评测与自演化**：能力 benchmark、toolset benchmark 与真实运行反馈、定时评测调度，支撑 self-evolution loop 与 agent-as-directory。

### 安全与信任

- **Web Bridge（P0）**：Proma / AI SDK runtime 打开独立、可见且隔离的受管浏览器（多标签 Electron CDP 引擎），按逐次确认执行导航、Chrome CDP 接入、点击和输入；上传只经系统文件选择器，最多 10 个文件 / 50MB，绝对路径不进入工具结果。
- **Computer Use（macOS P0）**：用户授权后列出显示器、读取截图、识别前台应用 / 窗口并控制鼠标键盘滚动；敏感步骤进入专用"用户接管"状态，Agent 暂停直至用户完成。
- **操作审计**：本机 JSONL 记录 Web Bridge 与 Computer Use 操作摘要，可按来源 / 会话 / 操作类型筛选与导出，不含页面正文、截图、敏感输入或本地绝对路径。
- **权限体系**：safe / ask / allow-all 模式、计划确认、AskUser 追问、子 Agent 不能自动批准高风险操作。

### 桌面体验与连接

- **灵动岛（macOS）**：仅在需要用户关注时（权限审批 / 计划确认 / 用户提问、任务失败、完成未读）触发浮层，支持点击导航、项目级静音与总开关。
- **远程机器人**：飞书 / Lark 桥接（消息同步、任务通知、OAuth），钉钉、微信桥接入口；外部 IM 统一 auto 权限模式并包装不可信群聊消息。
- **记忆与工具**：Chat 和 Agent 共享跨会话记忆；联网搜索、内置 Chat 工具。
- **目标管理（Goal，借鉴 LoopX）**：长生命周期目标跨会话追踪，todos（所有权 / 声明）、用户门控（Gate）、证据沉淀与配额上限；会话一键绑定目标，Agent 运行中主动读取 / 领取 / 完成 todo，自动化不可推进时自动阻断。
- **其他**：文件预览工作台（文档双击独立窗口预览）、语音流式输入（应用内外 Ctrl + `）、全局快捷键、快速任务窗口、自动更新、代理设置、亮色 / 暗色主题。
- **本地优先**：会话、工作区、附件、配置、Skills 默认存储在 `~/.gravitas/`；核心数据 JSON / JSONL，项目、营销与 Campaign 使用本地 SQLite，Context Store 为可重建索引。

## 快速开始

### 下载安装

从 [GitHub Releases](https://github.com/andrewchay/proma-mit/releases) 下载。可用平台以对应发布页的实际附件为准；本地构建成功不等于该版本已发布。

### 首次配置

1. 打开 Gravitas，先完成环境检查。Agent 模式依赖本机基础环境，尤其是 Git、Node.js / Bun 以及可用的 Shell。
2. 进入 **设置 > 渠道**，添加至少一个 AI 供应商渠道：填写 Base URL、API Key 和模型列表；也可使用订阅制端点（GitHub Copilot 设备流登录、ChatGPT Codex OAuth 等，登录后自动写入凭据并在模型选择处显示额度余额）。
3. Agent 模式默认使用 **Pi Runtime**，推荐同时使用 **Pi** 与 **AI SDK** 两种 runtime。Pi 对多种渠道协议（Anthropic、OpenAI 兼容、Google 等）兼容，开箱即用；AI SDK 支持 OpenAI-compatible 与 Anthropic、Google provider，也是后续服务端 Web 化的优先路径。Claude runtime 需要 Anthropic 或兼容协议；Proma runtime 仍可用但非首选。
4. 进入 **设置 > Agent**，选择默认 Agent 渠道、模型和工作区。新工作区只默认启用 `find-skills`、`proma-coach`、`skill-creator` 三个核心 Skills，其余内置能力保留在 Skill 集市按需安装；思考模式按模型推理等级矩阵分级。
5. 如需记忆、联网搜索、飞书 / 钉钉 / 微信桥接、订阅与领域包，在设置页对应 Tab 中继续配置。
6. 如需 TypeSafe 判断，在 **设置 > 工具 > TypeSafe 判断服务** 中保存 API Key 并显式开启。该功能默认关闭；请求只包含当前用户消息的截断文本、通用附件类别，以及 shadow 判断所需的已启用 Skill 名称与简介，不发送历史对话、附件内容、工具结果或本地路径。API Key 仅在主进程使用 `safeStorage` 加密保存；系统加密不可用时只在当前进程内存中保留。

### 使用已有本地项目

在 Agent 左侧的"工作区"栏点击文件夹加号，选择已有项目目录。Gravitas 会把该目录作为 Agent 的实际工作目录（cwd）：文件浏览、`@` 文件引用和变更检测都会指向该项目，Agent 可以直接读写项目文件。

选择本地项目不会把会话记录、MCP 配置或 Skills 写入项目根目录；这些仍保存在 Gravitas 的私有配置目录。普通"+"按钮则继续创建原有的隔离工作区。删除本地项目工作区只会移除 Gravitas 中的关联，不会删除项目文件夹。

### 使用 Web Bridge

在 Gravitas 或 AI SDK runtime 中，Agent 可通过 `WebBridgeNavigate` 打开网页，并用 `WebBridgeSnapshot`、`WebBridgeScreenshot`、`WebBridgeScroll` 查看页面。`WebBridgeNavigate`、`WebBridgeClick`、`WebBridgeType`、`WebBridgeDownload` 和 `WebBridgeUpload` 均需逐次经过 Agent 权限流程，不能"始终允许"。上传时会额外弹出系统文件选择器：Agent 不能传入或读取本地路径，最多选择 10 个文件、总计 50MB，且绝对路径不会返回给模型。登录凭据、敏感信息、提交表单、支付、删除或授权等操作应由用户在最后一步确认或接管。

如需复用已有 Chrome 的登录态，可由用户自行以 `--remote-debugging-port=9222` 启动 Chrome，然后让 Agent 使用 `WebBridgeChromeTargets` 和 `WebBridgeConnectChrome` 连接指定页面。该 Bridge 仅连接 `127.0.0.1` 的调试端口，不会启动或关闭 Chrome。

在 **设置 > 操作审计** 可查看本机 Web Bridge 与 Computer Use 的 JSONL 操作摘要，按来源、会话 ID、操作类型筛选，并导出当前筛选结果为 JSONL。

### 使用 Computer Use（macOS）

Computer Use 的正式支持范围为 Proma runtime 与 AI SDK runtime；Claude runtime 和 Pi runtime 仅做工具发现、权限拒绝与文本降级的兼容性验证。

macOS 提供状态 / 能力查询、显示器枚举、前台应用和窗口识别、授权请求、截图、移动、点击、双击、拖拽、受限快捷键、输入与滚动。`ComputerUseScreenshot` 返回 `display_id` 和 `coordinateScale`，后续操作带回该缩放值即可自动换算坐标，适用于 Retina 和多显示器布局。密码、验证码、密钥、支付和最终提交等敏感步骤必须由用户接管。

首次使用时，Agent 会通过 `ComputerUseRequestPermissions` 请求系统授权；在 macOS **系统设置 > 隐私与安全性** 中为 Gravitas 打开：

1. **辅助功能**：允许鼠标点击、键盘输入和滚动；
2. **屏幕与系统音频录制**：允许读取屏幕画面。

无需管理员密码、完全磁盘访问或输入监控权限。Windows 与 Linux 安装包保留能力查询，但在完成原生输入实现和真机权限验收前会明确显示"控制不可用"。

### 订阅与领域包

订阅管理与支付入口在应用内：选择订阅方案后经微信 / 支付宝完成支付，权益生效后对应领域包（营销、出海 sourcing 等）解锁；订阅到期或退款后权益自动收回。企业批量开通与私有化部署的授权发放请联系许可方。

### 服务端 Web 本地验收

服务端应用位于 `apps/server/`。本地 P2 验收会启动临时 Postgres 与 Redis，然后验证跨 worker lease、Redis event replay 及两个独立应用实例之间的 Web session/run/workspace/SSE 路径：

```bash
docker compose -f apps/server/docker-compose.p2-test.yml up -d

export PROMA_P2_TEST_DATABASE_URL='postgres://proma:proma@127.0.0.1:55432/proma'
export PROMA_P2_TEST_REDIS_URL='redis://127.0.0.1:56379'

bun run --filter='@gravitas/server' test:p2-live
bun run --filter='@gravitas/server' test:web-e2e

docker compose -f apps/server/docker-compose.p2-test.yml down
```

这套环境只用于本地验收；正式部署需提供 `PROMA_WEB_DATABASE_URL`、`PROMA_WEB_REDIS_URL`、S3-compatible storage 配置与 envelope key。生产环境设置 `PROMA_WEB_OIDC_ISSUER`、`PROMA_WEB_OIDC_AUDIENCE`、`PROMA_WEB_OIDC_JWKS_URL` 后，服务会校验 RS256 Bearer JWT 并建立租户 scope。

可选项：

- 月度成本预检：`PROMA_WEB_MONTHLY_BUDGET_MICROUSD`（租户/用户总额）与 `PROMA_WEB_MODEL_MONTHLY_BUDGET_MICROUSD`（单模型额度，微美元整数）。
- Redis 固定窗口限速：`PROMA_WEB_RATE_LIMIT_TASKS` 与 `PROMA_WEB_RATE_LIMIT_WINDOW_MS`。
- 评估数据集采样飞轮：`PROMA_WEB_SPAN_SAMPLING=1`（可选 `PROMA_WEB_SPAN_SAMPLE_RATE` 采样率，默认 0.1；默认关闭且不采集内容快照）。

运行指标可通过 `GET /agent/metrics` 查询；Agent 运行时可观测 API（运行档案 span 树、Signals、评估数据集）及 `/agent/ui` 工作台见 [docs/server-observability-api.md](./docs/server-observability-api.md)。

私有部署（M1–M4：登录闭环、一键部署 + 烟测、健康仪表盘、子 Agent 树视图）的部署方式与验收清单见 `.context` 交接文档与 `apps/server/` 内说明。

## 模式选择

### Chat 适合

- 日常问答、解释、翻译、润色、轻量代码讨论。
- 读取附件内容后做总结、改写、比较。
- 同时对比多个模型输出，或用不同系统提示词做探索。

### Agent 适合

- 修改、创建、整理本地文件。
- 调研、编写报告、处理多步骤任务。
- 使用 MCP、Skills、Shell、Git、项目文件等外部上下文。
- 需要权限确认、计划模式、后台任务或远程机器人持续跟进的工作。

### Workflow 适合

- 把反复要做的流程一次性编排成可视化流程，以后按设定触发。
- 定时、事件驱动或需要人工审批流转的业务。
- 需要沉淀、复用到多个工作区并保证执行一致的流程。

### AI 员工适合

- 管理性、可拆解、可验收的重复任务：指派给 AI 员工后无人值守执行并回写到看板。
- 需要配额护栏、卡点确认与执行留痕的团队协作场景。

简单说：**只需要回答时用 Chat，需要行动和交付结果时用 Agent，需要把流程固化下来反复执行时用 Workflow，需要把任务交给"数字同事"时用 AI 员工。**

## 截图

### Chat 快速分析

![Gravitas Chat 快速分析](<./docs/assets/screenshots/proma-chat-demo.png>)

### Agent 工作台

![Gravitas Agent 工作台](<./docs/assets/screenshots/proma-agent-demo.png>)

### Skills

每个工作区都可以沉淀专属 Skills。

![Gravitas 工作区 Skills](<./docs/assets/screenshots/proma-skills-demo.png>)

### Skills & MCP

同一个工作区可以管理 stdio / HTTP MCP Server，按需启用或关闭。

![Gravitas MCP 配置](<./docs/assets/screenshots/proma-mcp-demo.png>)

### 流式语音输入（支持全局输入）

- Gravitas 内部使用：Ctrl + \` 触发识别，再次按下结束自动输入到 Gravitas 内对应的输入框
- Gravitas 外部使用：Ctrl + \` 触发识别，再次按下结束自动输入到当前光标所在处，如无光标则默认写入剪贴板

![Gravitas 语音输入](<./docs/assets/screenshots/proma-typeless-input.png>)

## 支持的模型渠道

| 供应商 | Chat | Agent | 协议说明 |
| --- | --- | --- | --- |
| Anthropic | 支持 | 支持 | Anthropic Messages API |
| DeepSeek | 支持 | 支持 | Anthropic 兼容协议 |
| Kimi API | 支持 | 支持 | Anthropic 兼容协议 |
| Kimi Coding Plan | 支持 | 支持 | Anthropic 兼容协议，使用专用认证头 |
| OpenAI | 支持 | 支持 | Chat Completions / AI SDK runtime |
| Google | 支持 | 支持 | Gemini Generative Language API / AI SDK runtime |
| 智谱 AI | 支持 | 支持 | Anthropic 兼容协议 |
| MiniMax | 支持 | 支持 | Anthropic 兼容协议 |
| 豆包 | 支持 | 支持 | Anthropic 兼容协议 |
| 通义千问 | 支持 | 支持 | Anthropic 兼容协议 |
| GitHub Copilot | — | 支持 | 设备流 OAuth 登录，额度面板 |
| ChatGPT (Codex) | — | 支持 | OAuth 登录 + 自动刷新，额度面板 |
| 自定义端点 | 支持 | 支持 | OpenAI 兼容协议 / AI SDK runtime |

**推荐使用 Pi 和 AI SDK**。Pi 是当前默认 runtime，支持工具调用、MCP、Plan、AskUser、子 Agent 与流式输出，对多种渠道协议兼容；AI SDK 能力相近，也是后续服务端 Web 化优先路径。Claude runtime 保留 SDK 原生 session / snapshot 能力（fork / rewind 最接近完整时间线恢复）；Proma 作为较早的 provider-agnostic runtime 仍可用但能力相对有限。

订阅制端点（Copilot / Codex 等）通过预设清单做动态模型发现，登录后自动刷新凭据；思考模式按模型推理等级矩阵分级，而非简单布尔开关。

## 本地数据

Gravitas 采用本地文件存储，方便备份、迁移和排查问题。

```
~/.gravitas/
├── channels.json
├── conversations.json
├── conversations/
│   └── {conversation-id}.jsonl
├── agent-sessions.json
├── agent-sessions/
│   └── {session-id}.jsonl
├── agent-workspaces/
│   └── {workspace-slug}/
│       ├── {session-id}/       # 隔离工作区的会话目录和私有运行状态
│       ├── workspace-files/
│       ├── mcp.json
│       └── skills/
├── attachments/
├── user-profile.json
├── settings.json
├── calendar/                    # 日程管家：events.jsonl / tasks.jsonl
├── projects/                    # 项目管理：paa.db（SQLite；生产 better-sqlite3 直写 WAL，bun test 用 sql.js）
├── goals/                       # Goal 状态层：{goalId}.json + index.json
├── token-usage/                 # Token 统计：{YYYY-MM}.jsonl
└── sdk-config/
```

API Key 会通过 Electron `safeStorage` 加密后写入 `channels.json`。核心数据结构以 JSON 配置和 JSONL 追加日志为主；已有业务数据库保留原路径，sql.js 导出采用原子替换，Campaign/KOL 使用 Electron 内置 node:sqlite。备份和恢复要求见 [存储合同](docs/storage-contract.md)。

## 开发

Gravitas 是 Bun workspace monorepo。

```
gravitas/
├── packages/
│   ├── shared/     # 共享类型、IPC 常量、配置、工具函数
│   ├── core/       # Provider Adapter、SSE、代码高亮
│   └── ui/         # 共享 React UI 组件
└── apps/
    └── electron/   # Electron 桌面应用
```

当前主要包版本：

| 包 | 版本 | 职责 |
| --- | --- | --- |
| `@gravitas/electron` | `0.12.37` | Electron 桌面应用 |
| `@gravitas/shared` | `0.2.6` | 共享类型、IPC 常量、配置和工具 |
| `@gravitas/core` | `0.2.16` | Provider Adapter、SSE、Shiki 高亮 |
| `@gravitas/ui` | `0.1.4` | 共享 React UI 组件 |

常用命令：

```bash
# 安装依赖
bun install

# 开发模式：自动启动 Vite + Electron + 热重载
bun run dev

# 构建 Electron 应用
bun run electron:build

# 构建并运行
bun run electron:start

# 类型检查
bun run typecheck

# 测试
bun test
```

Electron 子应用内也提供更细的脚本：

```bash
cd apps/electron

bun run dev:vite
bun run dev:electron
bun run build:main
bun run build:preload
bun run build:renderer
bun run dist:fast
```

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 运行时 | Bun |
| 桌面框架 | Electron 39 |
| 前端 | React 18 + TypeScript |
| 状态管理 | Jotai |
| 样式 | Tailwind CSS + Radix UI |
| 富文本输入 | TipTap |
| Markdown / 图表 / 公式 | React Markdown + Beautiful Mermaid + KaTeX |
| 代码高亮 | Shiki |
| 构建 | Vite + esbuild |
| 分发 | electron-builder |
| Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.143` |

## 架构概览

Gravitas 的核心通信路径是：

```
shared 类型和 IPC 常量
  -> main/ipc.ts 注册处理器
  -> preload/index.ts 暴露 window.electronAPI
  -> renderer Jotai atoms 和 React 组件调用
```

主进程服务集中在 `apps/electron/src/main/lib/`：

- `agent-orchestrator.ts`：Agent 编排、环境变量、SDK 调用、事件流、错误处理。
- `agent-session-manager.ts`：Agent 会话索引和 JSONL 消息持久化。
- `agent-workspace-manager.ts`：工作区、MCP、Skills 和工作区文件管理。
- `project-chain.ts` / `project-chain-service.ts`：版本化决策与协作链、交付物验收交接状态机。
- `chat-service.ts`：Chat 流式调用、Provider Adapter、工具活动。
- `typesafe-judgment-service.ts`：可选的 TypeSafe 路由判断、保守阈值、代理、超时/重试与熔断；审计不保存用户消息正文。
- `conversation-manager.ts`：Chat 会话索引和消息存储。
- `channel-manager.ts`：渠道 CRUD、API Key 加密、连接测试、模型获取。
- `feishu-bridge.ts` / `dingtalk-bridge.ts` / `wechat-bridge.ts`：远程机器人桥接。
- `memory-service.ts`、`chat-tool-*`、`document-parser.ts`、`workspace-watcher.ts`：记忆、工具、文档解析和文件监听。

渲染进程以 Jotai 管理状态，关键 atoms 位于 `apps/electron/src/renderer/atoms/`。Agent IPC 监听器在应用顶层全局挂载，避免切换页面时丢失流式事件、权限请求或后台任务状态。

## 打包注意事项

本地验收包与正式版均使用 com.gravitas.app / Gravitas 身份，不应按独立应用并存安装。目录打包后运行 `bun scripts/package-smoke.ts <Gravitas可执行文件>`；烟测使用临时配置，不覆盖用户应用。默认离线烟测会验证打包资源、SQLite 重开、工作流模板、新工作区的三个默认 Skills，以及 Skill 分组批量停用落盘。

如需验证真实 Kimi 自动压缩，可显式提供已有 Kimi Coding 渠道和加密渠道配置文件：

```bash
GRAVITAS_PACKAGE_SMOKE_KIMI_CHANNEL_ID=<channel-id> GRAVITAS_PACKAGE_SMOKE_CHANNELS_PATH=<channels.json> bun scripts/package-smoke.ts <Gravitas可执行文件>
```

该模式把加密渠道配置复制到临时配置目录，构造接近 256K 阈值的持久化历史，验证自动压缩审计、`compact_boundary`、最近 20 条历史保留和压缩后继续完成当前回合；结束后删除临时目录。它会产生一次真实 Provider 调用，应只在明确授权的验收环境运行。

`@anthropic-ai/claude-agent-sdk` 在 `0.2.113+` 后改为平台 native binary 分发。Gravitas 的 esbuild 配置会把 SDK 标记为 external，`electron-builder.yml` 会把 SDK 主包和平台子包一起打进安装包。

修改打包配置时请特别确认：

- 主进程 esbuild 保持 `--external:@anthropic-ai/claude-agent-sdk`。
- `apps/electron/package.json` 的 `optionalDependencies` 包含目标平台的 SDK 子包。
- `apps/electron/electron-builder.yml` 的 `files` 包含 SDK 主包和平台子包。
- 其它普通 npm 依赖通常应由 esbuild 打包进 `main.cjs`，不要随意 external。

更完整的工程约定见 [AGENTS.md](./AGENTS.md)。

## 贡献

欢迎修 Bug、补文档、加测试、完善体验，也欢迎围绕真实场景提交新的 Skills、MCP 配置或 Agent 工作流。

提交 PR 前建议先确认：

- 使用 Bun 运行脚本，不混用 npm / pnpm lockfile。
- 状态管理使用 Jotai。
- 尽量保持本地优先，优先使用配置文件和 JSON / JSONL。
- TypeScript 不使用 `any`，对象结构优先使用 `interface`。
- 新增 IPC 时同步修改 shared 类型、main handler、preload bridge 和 renderer 调用。
- 影响包行为时递增对应 package 的 patch 版本。
- 能用测试覆盖的行为尽量补上测试，尤其是共享逻辑、IPC 契约和持久化格式。

Gravitas 目前设有 PR 赠金计划。提交 PR 时可以在描述中留下邮箱，方便后续发放。

![Proma PR Bounty](<https://img.erlich.fun/personal-blog/uPic/PR%20%E8%B5%A0%E9%87%91%201.png>)

## Star History

<a href="https://www.star-history.com/?repos=ErlichLiu%2FProma&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=ErlichLiu/Proma&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=ErlichLiu/Proma&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=ErlichLiu/Proma&type=date&legend=top-left" />

</picture>
</a>

## 致谢

- [Shiki](https://shiki.style/)：代码高亮。
- [Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid)：Mermaid 图表渲染。
- [Cherry Studio](https://github.com/CherryHQ/cherry-studio)：多供应商桌面 AI 产品启发。
- [Lobe Icons](https://github.com/lobehub/lobe-icons)：AI / LLM 品牌图标。
- [Craft Agents OSS](https://github.com/lukilabs/craft-agents-oss)：Agent SDK 集成模式参考。
- [MemOS](https://memos.openmem.net)：记忆能力参考与集成。

## 许可证

本项目采用 **Business Source License 1.1 (BSL-1.1)**，详见根目录 `LICENSE`。

- 在 **Change Date（2030-06-22）** 之前，除非获得附加使用许可，源码及派生作品仅限非生产用途（详见 LICENSE 中的 Additional Use Grant）；
- 到达 **Change Date** 后，自动转为 **Apache License, Version 2.0**（见根目录 `LICENSE-APACHE` / [https://www.apache.org/licenses/LICENSE-2.0）。](https://www.apache.org/licenses/LICENSE-2.0%EF%BC%89%E3%80%82)

如需商业/生产授权，请联系许可方。
