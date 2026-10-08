# Gravitas 核心能力地图（2026-10-08）

> 依据：代码库实盘（apps/electron/src/main/lib 70+ 服务、apps/server、packages/*）+ git 近两周 128 提交 + release-notes v0.11.25。
> 结论先行：Gravitas 已从「AI Agent 桌面应用」演进为**单机优先的团队 Agent 协作操作系统（AgentIC OS）**。桌面 Electron 为主形态，apps/server 提供多租户 Web 运行时。

## 1. Agent 运行时内核
- **Pi runtime 为主力**（earendil pi 0.87.1）：pi-model-registry / request-budget-gate / tool-bridge / streaming-control；Claude/Gravitas Runtime 已软下线（停止新建与切入）
- 多 Provider：Anthropic、OpenAI、DeepSeek、智谱、MiniMax（含视频形态 H3 V2）、豆包、通义、Google、Custom，另有 codex adapter
- 编排可靠性：并发守卫、自动重试、流空闲看门狗、上下文压缩（context-compaction）、受控上下文（agent-controlled-context）
- 决策与预算：Turn 前置路由（ready/wait/blocked/quota/replan/repair）+ Goal 状态层（todos/配额/证据/用户门控）+ per-request 预算强制

## 2. 项目执行控制面（Project Pilot）——最大增量
- 约 30 个文件：control / policy / dispatch / budget-ledger / grant-pause / reconcile / terminal-gate / request-reservation
- 能力：授权与审批续跑、预算台账（授权级已占用/剩余 + 逐命令明细）、暂停/恢复、恢复重放、终局门禁、不可变运行回执、未验证停止升级为人工对账
- 派发智能化：按负责人分角色、评审命令在执行结算后派发、有限返工环路（同任务自动评审/返工）
- Owner 目标链路：版本化草案持久化 → 表单 → 校验 → 非代码员工任务准备与受控启动

## 3. AI 员工体系
- agent-employee-service：员工注册、派发闸门（交付落 draft 待人确认）
- 能力账本：capability ledger / transfer / migration / conflict / alerts
- 质量门：evaluation-gate、canary 灰度、observation、sample-scan
- 员工能力基准（employee-capability-benchmark）接入 eval 体系

## 4. 团队协作（AgentIC OS PH1/PH2，v0.11 主线）
- 成员同步：飞书/钉钉 ↔ 真人/AI 员工/Bot 双向映射；统一成员视图与负责人选择器
- 协作面：团队 Skills 目录、工作区文件共享事件流、Todo 事件流化、团队 Profile、团队收件箱 Mailbox（待办/看板并入）
- Run Center：按成员归属过滤、导出运行记录
- 治理：Context Hub / Work Graph、Token 成本记账收敛、成功输出转可复用资产提案、凭据统一治理 + 审批门
- 远程与开放：Bridge 即远程入口（/workflow、/proactive 远程触发）、成员互调协议、插件/SDK 开放、多租户精细化

## 5. 协作子会话
- 可见可追溯的委派子 Agent；配额单点闸、modelId 兜底链、交接预算（16 行/1800 字自动压缩）
- Server 端 team-collaboration / agent-registry API

## 6. 评测与自演化（eval）
- eval-service / runner / scheduler / builder / judge / self-evolver / benchmark-store / trace-writer
- 闭环：生成 → 评测 → held-out → 基准库；接真实渠道与 sub-agent

## 7. 扩展体系
- 插件 7 个内置：dynamic-island、computer-use、marketing、new-media、academic、outbound-sourcing、ste-writing；surfaces：agent-tools / agent-skills / contribute-prompts / overlay / settings
- Marketplace：Claude plugin marketplace 规范（known_marketplaces + installed_plugins + 去重归档），自有 marketplace repo：github.com/andrewchay/gravitas-skills
- Skills：工作区 skills/ 目录 40+（24 个 ma-* 营销、学术、出海 sourcing、办公三件套、skill-creator 等）
- MCP：stdio / SSE / StreamableHTTP、租户级 OAuth、secret-store、懒连接 + 工具目录缓存；workflows（PAA 模板，如 16 节点营销工作流）

## 8. 桌面与通道
- Computer Use（macOS，readOnly/allowWrite 分档）、Web Bridge（受管浏览器 + Chrome CDP）、灵动岛、语音输入、多主题系统
- 飞书深度集成（消息桥 / Todo v2 / 审批）、钉钉 Todo、微信开放平台（server 端 authorization / component-token）

## 9. 治理与可观测
- Token 统计（会话/轮/工具/Skill/MCP/模型多维度）、billing / metrics
- 审计：哈希链防篡改（server）、agent-audit-service、Span/Signal 查询工具、轻量文件日志
- 权限：agent-permission-service、凭据治理、审批门

## 10. 数据与记忆（本地优先）
- context-store：实体-边-事实 + CJK bigram 分词 + RRF 融合检索，DynamicContext 自动注入 + local_context_recall
- memory-service、knowledge-index；存储 JSON/JSONL/sqlite 双栈，无重数据库

## 判断（个人理解）
1. 产品重心已从「单体 Agent 工具」转向「团队协作 OS」：成员、收件箱、Run Center、互调协议都是组织级抽象
2. 当前主线是**执行可信度**：pilot 控制面的预算/回执/终局门/人工对账，回答「AI 员工能不能放心让它跑」
3. Runtime 收敛到 Pi：Claude Runtime 软下线，自研底座（预算门/流控/工具桥）接管
4. eval + self-evolver + 员工能力基准的出现，说明下一步方向是「AI 员工能力可度量、可进化」
