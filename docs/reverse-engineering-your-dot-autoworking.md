# 逆向拆解：OpenAI「Your Dot」的自动工作模式

> 调研日期：2026-11-17
> 方法：REA（Reverse Engineer Anything）静态重建
> 目标产物：`/Applications/ChatGPT.app/Contents/Resources/app.asar`（ChatGPT 桌面应用，内嵌 Codex 运行时）
> 目的：弄清 Your Dot 如何做到"持续自动工作"，以及 Gravitas 项目管理为什么做不到同等效果，输出可操作的改造建议。

## 0. 结论速览

Your Dot 不是 Codex CLI 的插件，也不是某个本地后台进程。它是 **ChatGPT 服务端的一台常驻 agent 系统**，在本机桌面应用里只留下前端 UI 和连接桥。它的"自动工作模式"由五根支柱构成，但这五根**性质不同，不能并列**：

**三根是能力前提**（决定"能不能自动"）：

1. **持久 agent 实体**（Hermes）：身份、指令、技能、权限、记忆、文件全部是服务端持久对象，运行只是临时实例。
2. **常驻云电脑**（Orbit OS）：执行环境是一台永不关机的云 VM，镜像里预装桌面环境、浏览器自动化和 Codex-as-a-service 运行时——与用户的笔记本完全解耦。
3. **外部事件触发器**：邮件、聊天、PR、工单、数据源、定时任务都能唤醒 dot，不需要本机进程活着。

**两根是体验优化**（决定"顺不顺手"）：

4. **子代理并行 + 一次性工作区**（Flora）：大任务拆分并行，工作区可整体重置，返工 = 重跑。
5. **前置审批策略**：审批要求（审批策略 + 自动复核人）作为 dot 的属性一次性配置，运行期不逐步弹窗。

Gravitas 的项目管理**不是缺少 scheduler**——Owner management loop、autonomous scheduler、executor/reviewer 链路都是完整的——而是缺前三根支柱：执行环境绑在本机 Electron 进程、唤醒源只有本进程内事件、agent 没有独立于一次委托的持久实体。

> [!IMPORTANT]
> **一个必须先说清的前提。** Your Dot 敢做策略式前置审批，是因为它跑在服务端云 VM 上，有服务端审计、服务端凭据隔离、服务端计费。Gravitas 跑在用户本机，拿的是用户的文件系统权限和 API key。治理外壳（grant / 指纹 / 审计）不是 Gravitas 的负担，是它敢在本机跑无人值守的**唯一理由**。
>
> 所以"保留治理外壳、只改自动化的时空边界"这个原则成立，但必须补一句：**外壳的强度不随自主性提高而降低**。支柱 1–3 让"关机继续跑"成立，且不碰安全模型；支柱 4–5 是体验优化，不该和前三根并列成"五根支柱"。

---

## 1. 调研方法与证据

### 1.1 工具链

使用 REA（本地副本 `~/.npm/_npx/9b9809298fe40d2c/node_modules/rea-agents`，v6.4.0）：

```bash
# 全量应用图重建（后台运行约 8 分钟）
node scripts/rea.mjs analyze-javascript-application \
  .tmp/chatgpt-asar --format json --full-output \
  > .tmp/rea-chatgpt-analysis.json

# 辅助：asar 解包
npx @electron/asar extract /Applications/ChatGPT.app/Contents/Resources/app.asar .tmp/chatgpt-asar
```

REA 产出：31,271 节点 / 31,394 边的 JavaScript 应用图（`graph_id: jag_c86a750ad8bea573…`），evidence_id `ev_e2af6c9e7cd623d39afe64fab0dfb60042a35dc64b70334b70a23fc2aad79ee8`，覆盖 11,078 个源文件；Electron 主进程侧还原出 47 个 IPC 操作、27 个字面量通道、4 组 contextBridge API。

Your Dot 相关代码的定位：75 个 webview async bundle 含 `yourDot/YourDot` 引用，核心逻辑标识符为 `dotApproval`、`capableDot`、`sharedDot`、`dotOwner`、`multiDotSidebar`；功能命名空间为 `orbit`（dot UI）、`aeonMessaging`（与 dot 聊天）、`hermes`（agent 管理 API）、`flora`（运行时/子代理）、`wham`（Codex 线程共享）。

### 1.2 证据文件索引（本工作区）

| 证据 | 路径 | 内容 |
|---|---|---|
| REA 完整应用图 | `.tmp/rea-chatgpt-analysis.json`（355 MB） | 全量静态重建证据 |
| 解包副本 | `.tmp/chatgpt-asar/` | ChatGPT.app asar 解包 |
| Dot 标识符上下文 | `.tmp/dot-contexts.txt` | 75 个 bundle 中 dot 相关字符串/标识符 |
| API 端点上下文 | `.tmp/api-contexts.txt` | hermes/flora/dots/cloud-agent 端点周围代码（319 段） |
| 触发器上下文 | `.tmp/trigger-contexts.txt` | 触发器机制代码（26 段） |
| 提取脚本 | `.tmp/extract-dot-context.cjs` 等 | 可复跑的定向提取 |

---

## 2. Your Dot 架构拆解

### 2.1 总体图景

```
外部事件（邮件/聊天/PR/工单/定时）
        │
        ▼
  Hermes 触发器服务（服务端）
        │ 唤醒
        ▼
  Orbit OS 云电脑（常驻 VM）
  ├─ cloud-agent-desktop   （虚拟桌面 / X display）
  ├─ cloud-agent-browser-runtime （浏览器自动化）
  ├─ MCP 凭据（~/.local/state/browser/credentials.json）
  └─ Codex-as-a-service 运行时（CODEX_CAAS_SESSION_ID）
        │
        ├─► Flora 子代理（并行，/flora/subagent/thread/turns）
        │     工作区可整体重置（/flora/workspace/reset）
        │
        └─► Codex 工作区（块归属 footer.dotOwner，可续跑本地线程）
        │
        ▼
  持久状态回写：记忆 / persistent-folder / analytics/runs
```

前端（ChatGPT Web / 桌面 app）只做三件事：配置 dot（orbit UI）、查看活动（analytics、computer-history）、审批（/dots/approve）。**编排闭环完全在服务端。**

### 2.2 支柱一：持久 agent 实体（Hermes）

从 bundle 提取的 Hermes API 面（全部经 `Request.safeGet/safePost` 带身份校验调用）：

```
/hermes/agent                                创建/列出
/hermes/agent/{id}                           读取
/hermes/agent/{id}/save                      保存配置
/hermes/agent/{id}/system-hint               长期指令/人设
/hermes/agent/{id}/skills/{skill_id}/...     每 dot 独立技能包（含文件树）
/hermes/agent/{id}/permissions               权限策略
/hermes/agent/{id}/models                    模型选择
/hermes/agent/{id}/triggers[/{trigger_id}]   触发器（含 run_now）
/hermes/agent/{id}/persistent-folder/...     持久文件（= dot 的家目录）
/hermes/agent/{id}/conversations             跨会话对话记录
/hermes/agent/{id}/analytics/runs[/timeseries] 运行记录/时序
/hermes/agent/{id}/list-connector-readiness  连接器就绪状态
/hermes/agent/{id}/slack_handle              IM 身份
/hermes/agent-templates                      模板
/hermes/agents/pinned                        置顶
```

要点：dot 是一个有 CRUD 的**资源**，不是一次会话的日志。指令（system-hint）、技能、文件、记忆都挂在资源上，运行时只消费这些属性。

### 2.3 支柱二：常驻云电脑（Orbit OS）

最硬的证据是 bundle `146838.87652f10ab.js` 内嵌的云电脑初始化 Python 脚本（`.tmp/api-contexts.txt` 第 71 段起）：

```python
launcher = ["/usr/local/bin/cloud-agent-desktop"]
if not os.path.isfile(launcher[0]):
    raise SystemExit(10)
...
if not ready or ready.get("status") != "ready":
    subprocess.Popen(launcher + ["serve"],
        env={**os.environ, "ORBIT_OS": "true", "BROWSER_HEADLESS": "false"}, ...)
    # 最长 95 秒等待 ready
...
browser = subprocess.run(
    ["/usr/local/bin/cloud-agent-browser-runtime", "activate"],
    env={..., "DISPLAY": ready["display"], "XAUTHORITY": ready["xauthority"],
         "NODE_REPL_AUTH_TOKEN": token, "ORBIT_OS": "true",
         "CUA_REPL_BROWSER_ENV": "cloud", ...})
ready["session_id"] = os.environ.get("CODEX_CAAS_SESSION_ID") or ready["session_id"]
```

解读：

- dot 的执行环境是一台 **Linux 云 VM**（uid 1000、X display、xauthority），预装 `cloud-agent-desktop`（"Orbit OS" 桌面服务）和 `cloud-agent-browser-runtime`（浏览器自动化）。
- **`CODEX_CAAS_SESSION_ID` 表明 dot 的运行时就是 Codex-as-a-service**——dot 干活本质上是云端在跑 Codex 会话。
- MCP token 持久化在 VM 内（`~/.local/state/browser/credentials.json`），工具调用走 MCP。
- 前端文案佐证"永远在线"的定位：`restricted.orbitIntroduction.subtitle.capableDot` = "agents with exceptional capabilities that work all the time"（始终运行的 agent）。
- 本机可以通过桌面 app 设备配对成为 dot 的一台"电脑"（`sharedDot.devices.*`，并有明确警告：任何能用该 dot 的人都能让它在这台电脑上读文件、执行命令）。

### 2.4 支柱三：事件触发器 + 定时自动化（自动醒来的机制）

触发器类型（`codex.triggers.*` i18n 键 + `/hermes/agent/{id}/triggers` API）：

| 触发器 | 说明 |
|---|---|
| `newEmail` | 新邮件到达 |
| `chatUpdates` | 聊天更新 |
| `pageUpdates` | 页面更新 |
| `issueUpdates` | 工单更新 |
| `pullRequestUpdates` | PR 更新 |
| `dataSourceUpdates` | 数据源更新 |
| `messagesAndEdits` | 共享空间的消息与编辑 |
| `schedule_policy`（automations） | cron 式定时 |
| `run_now` | 手动触发 |

定时侧 API：`/automations/save`、`/automations/schedule_policy`、`/automations/run-on`、`/automations/set_status`、`/automations/query`。

唤醒链路：**外部事件 → 服务端触发器 → 拉起云电脑上一运行 → 回写记忆/文件 → 睡去**。用户笔记本关机不影响任何一环。

### 2.5 支柱四：子代理并行与一次性工作区（Flora）

```
/flora/subagent/thread/turns        子代理编排（拆任务、并行跑）
/flora/workspace/reset              工作区整体重置（用完即弃）
/flora/browser/auth|cookies|credentials|passkeys|form-fill|password-managers
                                    浏览器凭据/自动化能力
/flora/browser/handoff              交接
```

要点：dot 接大任务时不是单线程硬跑，而是**拆给多个子代理并行**；每个子代理的工作区可以整体重置——**返工 = 重置重跑**，不存在"状态漂移了怎么办"的问题。

### 2.6 支柱五：Codex 打通与前置审批

**Codex 打通**：

- 桌面 app 资源内捆绑完整 `codex-cli`（`/Applications/ChatGPT.app/Contents/Resources/codex-cli`）。
- 前端路由 `/codex/open-app?target=dots` 直接从 Codex 侧打开 dot。
- Codex 空间的块归属支持 `dotOwner`：`codex.space.page.blockAttribution.footer.dotOwner` = "{name} 的 dot 最后编辑"——dot 可以直接在 Codex 工作区干活，并能续跑已有线程（外部文档亦确认 2025-10-09 起 dot 可启动 Codex 工作并跟进已有线程）。

**前置审批**（对比 Gravitas 的逐步审批最关键的一点）：

- 审批路由：`/dots/approve?workspace_id=...`。
- 管理员配置项（`composer.dotApproval.*`）：`policyRequired`（需要审批策略）、`reviewerRequired`（需要自动复核人）、`bothRequired`。
- 语义：**"什么情况下需要人介入"是 dot 的持久属性，配置一次，运行期按策略执行**；而不是每步操作都停下来问人。

---

## 3. 机制闭环总结：Your Dot 的"自动"

```
配置一次（指令/技能/权限/审批策略/触发器）
   │
   ├── 外部事件 ──► 服务端唤醒 ──► 云电脑拉起 Codex 运行时 ──► 执行（可拆子代理）
   │                                                              │
   ├── 定时调度 ──► 同上 ◄─────────────────────────────────────────┤
   │                                                              │
   │                         回写：记忆 / 文件 / analytics         │
   │                         需要人时：按策略挂起，/dots/approve   │
   │                                                              ▼
   └──► 睡去（环境不销毁，下一事件再唤醒）◄───────────────────────
```

三个结构性前提：

1. **环境永远活着**——云电脑不归用户设备管；
2. **触发来自外部**——不依赖任何本机进程；
3. **状态是资源**——记忆/文件/配置持久在服务端，运行实例随便死、随便拉。

---

## 4. 为什么 Gravitas 项目管理做不到

Gravitas 并非没有自动化。当前代码里已存在完整链路（**均已逐条核实**）：

- 启动即恢复：主进程初始化项目 SQLite、恢复 Owner runtime、启动 autonomous scheduler、重放启动意图（`apps/electron/src/main/index.ts:558-585`）。
- 管理授权默认自动：`renderer/atoms/owner-management-delegation-atoms.ts:56`（`autonomousExecution: true` + `AUTONOMOUS_REQUEST_CEILING`）。
- 30 秒管理回路 + 事件唤醒：`project-owner-management-loop.ts:584`（`setInterval(runAllProjects, 30_000)`）。
- 冻结批次 → 签发 grant → executor/reviewer/返工：`project-owner-autonomous-scheduler.ts`（`reworkOrdinal` 已在命令键里）、`project-owner-execution-launch.ts`。
- 已有一次真实全链路跑通（README:495，2048 项目 GLM-5.3-Flash 7/7；README 同时明确"未触发返工，尚未验证自主多轮返工"）。

做不到 Your Dot 的效果，是四个结构性差异：

| 维度 | Your Dot | Gravitas 项目管理 |
|---|---|---|
| 执行环境 | 服务端常驻云电脑，与本机解耦，app 关了照样跑 | 用户电脑上的 Electron 主进程，app 退出即停 |
| 唤醒来源 | 外部事件触发器（邮件/聊天/PR/定时）+ 服务端推送 | 仅本进程内 30 秒轮询 + 内部事件 |
| 状态模型 | agent 是持久资源，运行是临时实例，返工 = 重置 | 授权/方案/批次是冻结账本，每步重验指纹，漂移即 stale 停机，失败不重试只记 attention |
| 人类闸门 | 前置策略（policy + reviewer 配一次） | 每次漂移重新确认；直接授权走 grant IPC 还会弹原生确认框 |

一句话：**Gravitas 的自动化是"宿主应用内的受治理续跑"，Your Dot 的自动化是"服务端常驻 agent 的事件驱动唤醒"**。差距是架构层的，不是功能层的。

---

## 4bis. 初版分析的复核结论（2026-11-17 修订）

初版把改造计划写成五个等权阶段。复核代码后，有三处**实质性低估**和一块**被漏掉的既有资产**——后者能省掉整个计划里最贵的那部分工作。

### 4bis.1 三处低估

**① Pilot 不是"被白名单阻塞"，是故意做的死路。**

初版 §5 把 Pilot 描述成差一个配置项。实际 `project-pilot-policy.ts:217`：

```ts
export function assertPilotPolicyActive(projectId: string, now = Date.now()): never {
  // 暂无具备授权来源、额度扣减及命令幂等的激活路径；即便磁盘内容被手动改为 active 也不可运行。
  void now; getPilotPolicy(projectId)
  throw new Error('Pilot 未获有效托管授权')
}
```

返回类型是 `never`，无条件抛。`pausePilotPolicy` 也只写 `state: 'paused'`，全文件不存在写入 `'active'` 的路径。

这不是门禁，是**刻意保留的不可激活状态**——注释明说要先有授权来源、额度扣减、命令幂等三件事。任何"复用 Pilot 链路"的方案，成本都是补齐这三套机制，不是改字段。

**② 阶段 2 的跨包成本被完全忽略。**

`apps/server/package.json` 只依赖 `@gravitas/core` 和 `@gravitas/shared`。全部 Owner 逻辑在 `apps/electron/src/main/lib/project-owner-*.ts`（100+ 文件）。让 server 跑 Owner 任务，要么把这一坨抽成共享包（大重构），要么在 server 重写一遍。初版写的"派发路由增加 runtime 分支"在这个前提下不成立。

**③ 阶段 1 的验收标准在 Dev 渠道下跑不通。**

`app-identity.ts:26` 的 `APP_AUTOMATIC_SIDE_EFFECTS` 按渠道开关自动副作用，Dev 不恢复后台自动任务。初版验收写"重启应用后管理循环自动恢复且零弹框"，得先决定验收走哪个渠道。

### 4bis.2 被漏掉的既有资产（省工最多）

**`companion-server.ts` 已经是一个内嵌 HTTP 服务。** 358 行，`node:http`，Bearer token 认证，配对码换 token 且 token 只存 hash，SSE 事件流带 `Last-Event-ID` 补发，随设置开关启停（`index.ts:606-609`）。

初版阶段 3 把"主进程 HTTP 端点"列为新工作，还专门写了风险条"webhook 暴露面——默认仅 loopback"。但鉴权、绑定地址、启停生命周期、事件推送**全都现成**。webhook 只是加一组路由。

**`event-router-service.ts` 已经把触发源归一化做完了**——`dedupeKey` 指纹去重 + 10 分钟时间窗、同 group 串行 + `parallel` 并发上限、`tell` 通知策略。文件头第一句就写着"所有触发源（IM 消息 / 内部事件 / **未来 webhook**）统一归一为 AgentAutomationEvent"。`EventRouteTarget` 目前只有 `workflow-event` / `log` 两种，扩展点清晰。

所以阶段 3 的真实形状是：**给 event-router 加一个 `owner-goal` 目标种类 + 给 companion-server 加一条路由 + 把 `rescanOwnerManagementProjects()` 暴露为可触发入口**。初版设计的 `project_triggers` 新表 + `project-owner-triggers.ts` 新服务是重复建设。

**阶段 4 同样**：`owner-runtime-verification-command.ts`、`owner-runtime-browser-verifier.ts`、`owner-runtime-assertion-templates.ts`（553 行模板库）已经在做结构化验收；`reworkOrdinal` 在 scheduler 里也已有。阶段 4 的真缺口是**verifier 失败后自动回到 rework**，不是 verifier 本身。

### 4bis.3 排序上的三处修正

| 初版阶段 | 修正后阶段 | 理由 |
|---|---|---|
| 原阶段 3（外部触发） | **新阶段 1**（前移） | 它不依赖 Owner 资源化；用现成的 companion-server + event-router，是投入产出比最高的一步 |
| 原阶段 1（资源化） | 新阶段 2 | 内容不变，仅顺延 |
| 原阶段 2（remote runtime） | **拆为** 新阶段 3（本机 sidecar）+ 新阶段 4（远端） | sidecar 与 electron 同进程树，可直接 import `main/lib`，绕开跨包成本；远端依赖 sidecar 的租约语义先稳定 |
| 原阶段 4（verifier） | 新阶段 5 | 内容收窄为"补失败分支"，verifier 本体已有 |
| 原阶段 5（审批策略） | 新阶段 6 | 目标从"零弹框"降级为"策略命中时自动复核"——在 `assertPilotPolicyActive` 恒抛的前提下零弹框不可达 |

初版里程碑表把 M3 标成"依赖 M1（M2 非硬依赖）"，但把 M1 列进依赖列，本身自相矛盾——这次一并改掉。

---

## 5. 对 Gravitas 的改造建议（按投入产出排序）

排序原则：**先做能复用既有资产、且不碰安全模型的**。这让第一阶段就能拿到可感知收益，同时把最贵的架构改动留到证据充分之后。

1. **外部事件触发器**（最高 ROI）：不依赖 Owner 资源化，且 `companion-server.ts` + `event-router-service.ts` 已具备全部基础设施。真实形状是"加一个目标种类 + 加一条路由"，不是新建触发系统。
2. **持久 agent 实体**：把 Owner manager 从"一次委托 + 账本"升级为长期存活实体——指令、技能、记忆、权限都是属性（参考 Hermes 的资源模型）。这是"它一直在"的基础。注意 `assertCurrent` 当前是逐字段 scopeHash 比对（`project-owner-management-delegation.ts:261-269`），改成 revision 比对要保留旧哈希兼容路径。
3. **执行环境外置**：**先做本机常驻 sidecar，不做远端**。sidecar 与 electron 同进程树，可直接 import `main/lib`，绕开 `apps/server` 只依赖 `core`/`shared` 的跨包成本。remote runtime 单列后续阶段。
4. **一次性工作区 + 确定性 verifier**：verifier 本体已有（`owner-runtime-verification-command.ts`、`owner-runtime-browser-verifier.ts`、553 行断言模板库），真缺口是**失败后自动回到 rework**——把 `needs_reconcile` 停机改成计数上限内的自动重跑。
5. **前置审批策略**：学 `dotApproval` 的字段设计，但**不要承诺零弹框**。在 `assertPilotPolicyActive` 恒抛的前提下，现实目标是"策略命中时自动复核 + 审计留痕，未命中仍弹框"。不要试图复用 Pilot 链路。

预期效果边界：做到 1–3 可达成"Gravitas 关闭后任务继续跑、外部事件可唤醒"；做到 4–5 提升"无人值守时长"，但不改变安全模型。

> [!WARNING]
> **关于"学 Your Dot 到什么程度"的判断。** 支柱 1–3 是能力缺口，值得补；支柱 4–5 是体验优化，补之前先问"本机跑无人值守，治理外壳降级后谁兜底"。Your Dot 的答案是有服务端审计和计费托底，Gravitas 没有。所以阶段 5–6 的每一项改动，都必须同时说明"治理强度不下降"的证据。

---

## 6. 分阶段实施计划（对应 Gravitas 现有模块）

总原则：每个阶段独立交付、独立验收。治理外壳（授权/预算/审计）保留，改的是"自动化的时空边界"。

阶段编排在初版基础上做了调整：**阶段 3 前移为阶段 1**（理由见 §4bis.3）；原阶段 1 顺延为阶段 2；原阶段 2 拆成"本机 sidecar"与"远端 runtime"两段。

### 阶段 1（原阶段 3）：外部事件触发器 ✅ 已实现

**目标**：Owner 任务可被定时和外部事件唤醒，不再只依赖 app 内 30 秒轮询。

**为什么排第一**：不依赖 Owner 资源化；`companion-server.ts`（358 行，Bearer 认证 + 配对码 + SSE 补发 + 设置开关启停）和 `event-router-service.ts`（去重 + 分组并发 + 通知策略）已具备全部基础设施。这是整个计划里唯一"只加不建"的阶段。

**实现状态（2026-11-17，v0.14.9）**：

| 改动点 | 模块 | 实际实现 |
|---|---|---|
| 路由目标扩展 | `event-router-service.ts` | 新增 `{ kind: 'owner-goal'; projectId: string; taskId?: string }` 与 `OwnerGoalWakeExecutor` 注入点；`validateEventRule` 校验 `projectId` 非空、`taskId` 若存在不可为空串；`runTarget` 新增分支 |
| 唤醒入口 | `project-owner-management-loop.ts` | 新增 `isOwnerManagementLoopRunning()` 探测循环是否启动；实际唤醒走 `requestOwnerManagementWake(projectId)`（按项目精确唤醒），**未用** `rescanOwnerManagementProjects()` 全量重扫 |
| webhook 路由 | `companion-api.ts` | 新增 `POST /api/hooks/owner-goal`，抽为 `handleOwnerGoalHook()` 保持路由表扁平；复用现有 `verifyToken` / `appendAudit` |
| 依赖装配 | `companion-server.ts` | `dispatchAutomationEvent` 懒加载 `eventRouter`，避免启动期连带引入 workflow 服务 |
| 触发器配置 | `event-rules.json` | **未新增 `project_triggers` 表**。`defaultEventRulesFile()` 增加了一条默认停用的 owner-goal 样例，用户复制改 `projectId` 即可 |

**HTTP 状态码语义**（`handleOwnerGoalHook`）：

| 码 | 含义 | 为什么 |
|---|---|---|
| 200 | 至少一条规则执行成功 | 正常路径 |
| 202 | 事件已接收但无规则处理（`no_rule`） | 未配置触发的部署不该报错 |
| 401 | 未认证 | 与其余接口一致，不泄露 trigger 是否存在 |
| 400 | `projectId` 为空 | 缺关键定位信息 |
| 502 | 全部规则执行失败 | 让外部系统重试，而非静默丢事件 |

**去重语义**：带 `taskId` 时 `dedupeKey = webhook:owner-goal:{projectId}:{taskId}`，同一任务的并发外部事件在 10 分钟窗口内只放行一次；不带 `taskId` 时回退默认指纹 `webhook:owner-goal:{projectId}`。

**测试覆盖**（共 22 个用例，`bun test` 全绿）：
- `event-router-service.test.ts`：校验分支、唤醒执行器入参透传、执行器返回 false / 抛错时的 failed 语义、默认模板样例
- `companion-api.test.ts`：401/400/200/202/502 五条状态码路径、审计写入、`summary` 兜底、**端到端去重**（真实 EventRouter + 临时规则文件，验证第二次为 `duplicate` 且不重复唤醒）

**验收结论**：
1. ✅ webhook 能唤醒 Owner 任务（`requestOwnerManagementWake` 为既有精确唤醒通道）
2. ✅ 10 分钟窗口内重放返回 `duplicate`（端到端用例覆盖）
3. ✅ 未配置规则时零副作用（`no_rule` 回归用例覆盖）

**风险**：webhook 暴露面。companion-server 默认读 `settings.companionServer.bindAddress`，保持仅 loopback 默认值；外发需用户显式改配置。另注意 `CompanionApiDeps` 新增了必填字段 `dispatchAutomationEvent`，第三方实现需同步。

### 阶段 2（原阶段 1）：长期 Owner profile ✅ 已实现（范围已修订）

**原计划的前提被证伪。** 初版写的验收是「重启零确认恢复管理循环」，隐含假设“重启会让委托失效”。实际不成立——

`project-owner-management-delegation.test.ts` 已有测试（现第 77 行）直接模拟重启：

```ts
store.closeProjectDb(); await store.initProjectDb()
expect(service.getOwnerManagementDelegation(f.project.id).delegation).toEqual(grant)
```

跑通。原因：委托存在 paa.db，`scopeHash` 由**当前配置内容**算出，配置没变哈希就不变；代码已刻意把 `revision`/`savedAt`/`changeReason` 排除在哈希外。

**因此本阶段不做原计划的「revision 比对」**——那是把内容寻址的不可绕过检查，换成依赖计数器自增的、可绕过的检查，属于安全性降级。

**实际交付**：长期 profile 作为**续签模板**。

| 改动点 | 模块 | 内容 |
|---|---|---|
| 数据模型 | `project-sqlite-store.ts` | 新增 `project_owner_manager_profiles` 表（`project_id` + `revision` 主键，payload + integrity_hash） |
| 类型 | `packages/shared/.../project-owner-management.ts` | `OwnerManagerProfile`：`maxCostMicros` / `maxRequests` / `expiresInHours` / `revision` |
| 读写 | `project-owner-management-delegation.ts` | `getOwnerManagerProfile` / `saveOwnerManagerProfile`（乐观锁）/ `deleteOwnerManagerProfile`（写墓碑，不物理删） |
| 自动续签 | 同上 | `renewExpiredOwnerManagementDelegation`：仅对**自然到期**的委托生效 |
| 循环接入 | `project-owner-management-loop.ts` | `reconcileOwnerManagement` 开头调 `renewExpiredProfiles`，失败不阻断原核对 |
| IPC | `project-owner-goal-ipc.ts` + preload + shared 类型 | `GET/SAVE/DELETE_OWNER_MANAGER_PROFILE` 三通道，四层同步 |

**四条安全约束**（每条都对应一个测试）：

| 约束 | 为什么 | 测试 |
|---|---|---|
| 只续**自然到期** | 已撤销（`revoked`）的委托不能被自动复活 | `Given 委托被撤销 When 调用续签 Then 不复活` |
| 未到期不续签 | 避免重复签发造成审计噪音 | `Given 委托尚未到期 When 调用续签 Then 不产生新委托` |
| 配置漂移硬拒绝 | 自动续签绝不能掩盖漂移——续签前重跑完整 `previewOwnerManagementDelegation` | `Given 配置已漂移 When 委托到期 Then 不自动续签` |
| **不抬高生命周期预算** | 累计花费由 `historicalUsage` 全量统计；续签只是开新窗口，不能让已花的钱回退 | `Given 已配置 profile When 续签 Then 生命周期预算上限不被抬高` |

**与 Your Dot 的差异**：profile 只存额度与期限模板，**不复制**指令/技能/权限——那些仍是运行时绑定的事实，避免出现「profile 说一套、绑定做一套」的双份真相。

**验收**：
1. ✅ 配置 profile 后委托到期自动续签并保持 `active`（集成测试走真实 `reconcileOwnerManagement`）
2. ✅ 未配置 profile 的项目行为完全不变（保持 `expired`）
3. ✅ 配置漂移时拒绝续签，交由人工重新确认

**遗留**：IPC 层测试因 bun 环境下 `electron` 具名导出（`shell`）不可用而无法运行，与本次改动无关（已用 `git stash` 验证基线同样失败）。IPC 逻辑目前只经类型检查覆盖。

### 阶段 3（原阶段 2 前半）：托盘常驻 ✅ 已实现（方案已替换）

**原计划是 sidecar，调研后被否决。** 三个阻断性理由：

**① sidecar 拿不到 API Key。** `channel-manager.ts:11` 直接 `import { safeStorage } from 'electron'`，API Key 用 `safeStorage.encryptString()` 加密存储。`safeStorage` 是 Electron 主进程专属 API，绑定 OS 钥匙串与 app 生命周期，独立 Node/Bun 进程无法调用。sidecar 要跑 Agent 只有三条路——主进程传明文 key（削弱加密存储）、sidecar 也跑 Electron（变第二个完整应用）、改存储格式（大规模迁移）。**三条都在削弱安全边界**，违反「治理外壳强度不随自主性提高而降低」。

**② macOS 上「关窗口」本来就不退出。** `index.ts:799-805` 的 `window-all-closed` 早已 `if (process.platform !== 'darwin') app.quit()`。主进程在 macOS 关窗后继续活着，Owner 循环照跑。

**③ 双进程调度会重复派发。** `project-owner-autonomous-scheduler.ts` 有 `inFlight` Map / `rerunRequested` Set / `lifecycleStarted` 等进程级状态，假设「只有一个进程在调度」。两个进程同时跑循环 = 重复派发 = 真金白银的模型调用费。而 `project-sqlite-store.ts` 打开 WAL 时**没有设 `busy_timeout`**，并发写会立即 `SQLITE_BUSY`，Owner 链路是 fail-first，表现为随机写失败。

**实际交付**：把「关窗常驻」从 macOS 专属推广到全平台。

| 改动点 | 模块 | 内容 |
|---|---|---|
| 关闭策略 | 新增 `window-close-policy.ts` | 纯函数 `resolveWindowCloseAction({ isQuitting })` → `allow-close` / `hide-to-tray` |
| 窗口关闭 | `index.ts` 的 `close` 处理器 | 由 `process.platform === 'darwin'` 改为策略函数；各平台一致隐藏到托盘 |
| 全窗关闭 | `index.ts` 的 `window-all-closed` | 同样走策略函数，只在真正退出时 `app.quit()` |
| 并发写退避 | `project-sqlite-store.ts` | `pragma('busy_timeout = 5000')`，避免主进程与外部工具（备份/诊断）写锁竞争时立刻失败 |

**为什么抽成纯函数**：原逻辑内联在 Electron `app.on('close')` 回调里，无法在 bun 测试环境验证。抽出来后可对「退出中/非退出中」两种输入直接断言，也把「策略只看 isQuitting、与平台无关」这条不变量锁进测试。

**验收**：
1. ✅ 未在退出时关窗 → 隐藏到托盘（3 个用例）
2. ✅ 正在退出时关窗 → 允许关闭
3. ✅ 策略与平台无关（防回归到平台分裂）
4. ⚠️ `busy_timeout` 无法 TDD——它是 better-sqlite3 的 pragma，bun 测试走 sql.js 分支到不了这里，只经类型检查覆盖

**遗留**：真正的「app 完全退出后任务继续」仍需进程外执行环境，但那需要先解决 safeStorage 隔离与跨进程互斥，不是本阶段范围。见阶段 4 的说明。

### 阶段 4（原阶段 2 后半）：远端 runtime

**目标**：任务执行可跨机器。**前置条件是阶段 3 的租约语义已验证稳定。**

| 改动点 | 模块 | 内容 |
|---|---|---|
| runtime 类型 | `packages/shared/src/types/agent.ts`（`AgentRuntime` union） | 增加 `'remote'`；声明 `maxBudgetUsd` 硬预算能力、心跳端点、任务拉取协议 |
| 提交客户端 | `agent-orchestrator.ts` | 新增 `submitToRuntime()` / `pollRuntimeTask()`：与现有 SDK 路径并行的轻量 HTTP 提交，复用渠道密钥解密与用量记录 |
| 跨包问题 | `apps/server` | 若坚持让 server 直接跑 Owner 任务，必须先抽共享包。**建议不要**——用阶段 3 的 sidecar 协议远程化即可，避免大重构 |

**验收**：任务在另一台机器的 sidecar 上执行完成，本机状态、用量、审计完整同步。

**风险**：失联时的租约回收（需租约过期 + 幂等续租）。这一步的价值只有在"多机"场景下才成立，单机用户不获益——**优先级排在阶段 5、6 之后**（见里程碑表 M6）。

### 阶段 5（原阶段 4）：确定性 verifier 自动返工

**目标**：verifier 判定失败后自动回到 rework，而不是立即 `needs_reconcile` 停机。

**真缺口**：verifier 本体已有（`owner-runtime-verification-command.ts`、`owner-runtime-browser-verifier.ts`、`owner-runtime-assertion-templates.ts` 553 行模板库），`reworkOrdinal` 也已在 scheduler 命令键里。缺的只是**失败分支的去向**。

| 改动点 | 模块 | 内容 |
|---|---|---|
| 失败分支 | `project-owner-autonomous-scheduler.ts` | executor 输出 → verifier 判定：通过 → reviewer 抽检（现状）；失败 → `reworkOrdinal + 1` 重跑（新），而非直接 `needs_reconcile` |
| 重跑上限 | `project-pilot-policy.ts` 的 `maxRework` 字段 | 已有字段，直接作为闸门；超限才升级人类 |
| 工作区重置 | `agent-workspace-manager.ts` | 隔离工作区 `{slug}/{session-id}/` 天然具备快照点：增加 `snapshotWorkspace()` / `resetWorkspace(snapshotId)` |
| 证据留存 | 审计 JSONL | verifier 每次判定的输入摘要与结果落审计，支持事后人类抽查 |

**验收**：向一个任务注入必失败验收（如断言测试通过而测试实际失败），观察其自动返工重跑 ≥2 次并留下每次 verifier 证据；超限后才升级人类。

**风险**：无限重跑防护——必须同时落地 `maxRework` 与预算双重闸门，且 reviewer 抽检不可被 verifier 替代（对齐现有 executor→reviewer 制衡）。

### 阶段 6（原阶段 5）：审批策略化

**目标**：策略命中时自动复核并留痕，减少运行期弹框。**不承诺零弹框。**

| 改动点 | 模块 | 内容 |
|---|---|---|
| 策略对象 | 项目配置 JSON（遵循"配置文件优先"约定） | 字段对齐 `dotApproval`：`approvalPolicy`（always / budget-breach / never）、`autoReviewer`（渠道 + 模型 + 提示词）、`maxBudgetUsd`、`escalation` |
| 审批评估 | `project-owner-autonomous-approval.ts` | 原生弹框仅在策略要求时弹出；策略内决策由 `autoReviewer` 自动复核。**不复用 Pilot 链路**——`assertPilotPolicyActive` 恒抛，复用成本高于重写 |
| 预算硬闸 | `project-owner-execution-launch.ts` | 按 runtime 能力强制 `maxBudgetUsd`；超预算即按 escalation 挂起并通知 |
| 前端 | 设置面板（复用 `settings/primitives/`） | 项目设置新增"自动执行策略"卡片；显示当前策略与最近自动复核记录 |

**验收**：策略配置后，命中策略的决策自动复核且审计完整；未命中的决策仍然弹框（**这是正确行为，不是缺陷**）；人为调低预算触发一次 escalation，验证挂起 + 通知 + 人类恢复链路。

**风险**：`autoReviewer` 本身也是模型，需在审计中完整留痕其复核输入输出，且策略变更必须重新确认一次（防"改策略绕过人类"）。

### 里程碑与依赖（修订）

| 里程碑 | 对应阶段 | 依赖 | 达成标志 | 状态 |
|---|---|---|---|---|
| M1 | 阶段 1 外部触发 | **无** | webhook/定时可唤醒 Owner 任务 | ✅ **已完成**（v0.14.9，22 用例） |
| M2 | 阶段 2 长期 profile | 无（可与 M1 并行） | 委托到期自动续签、漂移不续签 | ✅ **已完成**（v0.14.9，6 用例；原「重启零确认」前提已证伪） |
| M3 | 阶段 3 托盘常驻 | 无 | 关窗不退出、后台能力继续跑 | ✅ **已完成**（v0.14.25，3 用例；sidecar 方案因 safeStorage 隔离与重复派发被否决） |
| M4 | 阶段 5 verifier 返工 | M3 | verifier 失败自动返工重跑 | 待开始 |
| M5 | 阶段 6 审批策略 | M4 | 策略命中自动复核 + 预算硬闸生效 | 待开始 |
| M6 | 阶段 4 远端 runtime | M3 | 任务在另一台机器完成 | 待开始；单机用户不获益，**优先级最低** |

依赖关系的关键变化：**M1 从"依赖资源化"变成"无依赖"**，因为外部触发不需要 Owner 资源化；**远端 runtime 从第三顺位降为最后**，因为它的价值只在多机场景成立。

---

## 7. 附录

### 7.1 关键前端命名空间速查

| 命名空间 | 角色 | 代表性证据 |
|---|---|---|
| `orbit` | dot 管理 UI（创建/连接/电脑选择/数据使用声明） | `restricted.orbitIntroduction.*`、`restricted.orbitComputerOnboarding.*` |
| `aeonMessaging` | 与 dot 的聊天室 | `restricted.aeonMessaging.roomUi.*` |
| `hermes` | agent 资源管理 API | 见 2.2 端点表 |
| `flora` | 运行时：子代理 + 浏览器自动化 | 见 2.5 端点表 |
| `wham` | Codex 线程共享/个人资料 | `/wham/shared_threads/{id}`、`/wham/profiles/username/check` |
| `sharedDot` | 多人共享 dot | `sharedDot.connections.*`、`sharedDot.devices.warning` |

### 7.2 复现命令

```bash
# REA 全量重建（已跑完，结果在 .tmp/rea-chatgpt-analysis.json）
cd ~/.npm/_npx/9b9809298fe40d2c/node_modules/rea-agents
node scripts/rea.mjs analyze-javascript-application \
  /Users/chaihao/.codex/worktrees/opendesign-closure/project/.tmp/chatgpt-asar \
  --format json --full-output > rea-chatgpt-analysis.json

# 定向证据提取（脚本在 .tmp/，可改关键字复跑）
node .tmp/extract-dot-context.cjs <bundle.js>
node .tmp/extract2.cjs   # API 端点上下文
node .tmp/extract4.cjs   # 触发器上下文
```

### 7.3 局限性说明

- 分析对象是 ChatGPT 桌面应用 2026-11 时点的 asar；服务端（Hermes/Flora 实现本体）不可见，行为链路由客户端 API 面 + 内嵌脚本 + 官方文档交叉推断。
- 触发器的具体执行语义（去重、冷却、失败策略）在客户端不可见，需抓包或服务端文档补充。
- REA 全量图的 20,027 条 limitation 记录主要是动态求值与压缩代码的固有不可判定项，不影响本报告结论。
