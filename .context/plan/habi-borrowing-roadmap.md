# Proma 生态化实施规划（源自 habi-proma-borrowing 分析）

> 制定时间：2026-08-01
> 来源：`.context/notes/habi-proma-borrowing.md`（habi 对 Proma 的可借鉴设计分析）
> 性质：产品/技术路线规划，非单次执行计划；每阶段完成时更新「完成状态」。
> 当前基线：灵动岛通知（会话状态机）、Workflow 模式、渠道额度查询已完成并合入。

## 0. 总目标

把 Proma 从「一组功能」收敛为「一套工作系统」，形成统一心智：

> Chat 用来探索，Agent 用来完成，Workflow 用来重复；Workspace 保存上下文，Extensions 扩展能力和触达面。

- 不照搬 habi 的企业基础设施规模（GPU/数据中台/垂直应用矩阵）
- 只借鉴「生态组织方式」：统一 Capability 契约、数据复利、入口分工、插件共建
- 分阶段推进，每阶段有可验证产物

## 1. 已完成盘点（当前基线）

| 项 | 状态 |
|---|---|
| Agent / Workflow / Chat 三模式并列 | ✅ 已合入（ModeSwitcher + WorkflowView） |
| macOS 灵动岛通知（会话状态机） | ✅ 已合入（NSPanel 260x40 胶囊 + phase/attention/pill） |
| 渠道订阅 Plan 额度查询 | ✅ 已合入（DeepSeek 余额 / Kimi 5H·周，模型选择徽标） |
| 设置界面统一（三入口一致） | ✅ 已合入 |
| 定时任务「新建会话执行」 | ✅ 已合入 |
| 应用身份统一（proma-mit） | ✅ 已合入 |
| 任务进度卡片默认收起 | ✅ 已合入 |
| 测试沙箱隔离（PROMA_TEST_CONFIG_DIR） | ✅ 已有，需强化（见 P0-1） |

## 2. 关键设计原则（贯穿所有阶段）

1. **主进程拥有产品状态，渲染层只画**（灵动岛已践行）
2. **事件统一 AppEventEnvelope**：started / progress / waiting_action / completed / failed
3. **能力分层心智**：Skill=方法、MCP=连接、Tool=动作、Workflow=编排、Extension=产品扩展包
4. **配置隔离**：扩展配置不写宿主 settings（除升级清理唯一例外）
5. **原生能力不进主进程**：fork 子进程 + JSONL 协议，不继承 TCC/凭据
6. **增量而非夺权**：不替代 IDE/IM/知识库，让它们可被 AI 操作

## 3. 阶段规划

### P0：收敛底座（当前重点）

目标：让既有零件形成统一契约，消除认知碎片。

| # | 任务 | 交付物 | 验收标准 | 状态 |
|---|---|---|---|---|
| P0-1 | 强化测试/运行沙箱隔离 | 测试不得污染真实配置目录；Workflow Run/会话沙箱目录不得出现在用户工作区 | `bun test` 全量绿；`~/.proma-mit/agent-workspaces` 无测试残留 | ⬜ 部分（已有 env 隔离，需查残留） |
| P0-2 | 定义统一 AppEventEnvelope | `packages/shared` 新增事件类型：started/progress/waiting_action/completed/failed | 灵动岛/飞书/托盘统一消费同一事件 | ⬜ |
| P0-3 | renderer 通知收口为主进程 NotificationCoordinator | 主进程通知中心 + 系统通知 fallback | renderer 不再直接 `new Notification`；开关/音效仍可配置 | ✅ 两步完成：① 主进程 SystemNotificationService ② 完整 Coordinator（订阅 AppEventBus 路由到系统通知/灵动岛优先 + 提示音 IPC，renderer 移除发通知） |
| P0-4 | 明确 Chat/Agent/Workflow 跨模式转换 | 转换动作（澄清→Agent、成功→Workflow、绑定 Automation） | UI 有入口；任务流转有记录 | 🟡 部分：Chat→Agent 已有（MigrateToAgentButton）；Agent→Workflow 草稿已加（SaveAsWorkflowButton）；Workflow→Automation schedule UI 待 Workflow 编辑器支持定时触发后补 |

### P1：第一方扩展验证

目标：以灵动岛为第一方样板，验证「扩展」的完整生命周期，暂不开放第三方。

| # | 任务 | 交付物 | 验收标准 | 状态 |
|---|---|---|---|---|
| P1-1 | PluginManifest + 权限模型 + 生命周期 | `plugin.ts` 类型 + 安装/启停/故障/更新/回滚 | 支持安装→启用→停用→卸载；权限按需申请 | ✅ 类型骨架 + PluginManager（内置插件启停） |
| P1-2 | 设置「扩展」中心 | 权限、启停、故障、版本 UI | 与灵动岛配置并置；第三方不可见 | ✅ 扩展 tab（列表/启停/权限/surfaces/订阅） |
| P1-3 | 灵动岛落地为第一方扩展 | 事件订阅 + surface + 平台降级（已具备核心，需扩展化） | macOS 原生 / 无刘海退化 / 非 mac 系统通知 | ✅ manifest 声明 + 启停联动灵动岛开关 |
| P1-4 | 统一能力发现体验 | Skills/MCP/Tools/Extensions 统一入口 | 普通用户不需区分 MCP 与 runtime 差异 | ✅ 侧边栏能力指示器统一展示 MCP·Skills·扩展 |

### P2：形成复利

目标：让使用频率转化为产品复利。

| # | 任务 | 交付物 | 验收标准 | 状态 |
|---|---|---|---|---|
| P2-1 | 本地 Context Hub / Work Graph | 关联 Workspace/Session/Run/Task/Calendar/Artifact，带来源/时效/权限 | 高质量结构化事实可查询；不从全量文件向量化开始 | ⬜ |
| P2-2 | 统一 Run Center | Agent/Workflow/Automation 运行记录统一视图 | 一处查看全部运行历史/状态/重试 | ⬜ |
| P2-3 | 飞书/钉钉交互式状态卡片 | 运行、审批、重试、结果卡片 | Bridge 会话内可直接操作 | ⬜ |
| P2-4 | 签名第三方插件 SDK | 脚手架、兼容性测试、更新回滚 | 开放前先稳定契约与安全边界 | ⬜ |

## 4. 不建议做（明确不照搬）

- ❌ 自建公司级 GPU Inference 平台（优先多模型路由/成本/隐私/企业部署策略）
- ❌ Coding/Knowledge/PM/AIGC 新增为一级模式（优先 Workflow Pack / Extension）
- ❌ 全量企业人员画像和集中数据采集（与本地优先冲突）
- ❌ 先做插件市场（先用少量第一方插件稳定契约与安全边界）

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 只有「能力中心」新名称，无统一运行契约 | P0-2 先定义事件与 manifest，再谈 UI |
| 插件任意执行主进程代码，继承 TCC/凭据 | 强制 fork 子进程 + JSONL；默认禁 Shell/FS/凭据 |
| 插件 API 过早膨胀 | P1 只开放少量稳定事件与 surface，样板验证后再扩展 |
| Context Hub 变隐式监控/积累错误事实 | 显式来源、时效、权限、删除导出；用户确认过的事实优先 |
| macOS 特效主导路线 | 每项原生能力提供非 mac 降级路径 |
| 持续增加一级入口致产品退化 | 新垂直场景一律先做 Pack/Extension，不进一级模式 |

## 6. 立即建议的下一步（P0 优先）

1. **P0-1**：全量跑一次 `bun test` 并检查 `~/.proma-mit/agent-workspaces` 是否有测试残留（此前已清过一次，需固化）
2. **P0-2**：定义 AppEventEnvelope 类型并让灵动岛先接入（已有 phase 状态机，映射成本低）
3. **P0-3**：评估 renderer `notifications.ts` 收口到主进程的改动面（涉及 useGlobalAgentListeners）
4. **P1-1**：以灵动岛为第一方扩展样板，先补 PluginManifest 类型与生命周期骨架

## 7. 相关代码入口

- Agent 事件总线：`apps/electron/src/main/lib/agent-event-bus.ts`
- Agent 事件 IPC：`apps/electron/src/main/lib/agent-service.ts`
- 灵动岛服务（状态机样板）：`apps/electron/src/main/lib/dynamic-island/dynamic-island-service.ts`
- 当前 renderer 通知：`apps/electron/src/renderer/atoms/notifications.ts`
- 渠道额度（第一方能力样板）：`apps/electron/src/main/lib/channel-manager.ts`
- 透明置顶窗口参考：`apps/electron/src/main/lib/quick-task-window.ts`
- 系统托盘：`apps/electron/src/main/tray.ts`
