# 2026-09-30 Pilot UI／离线场景续验（零付费）

## 冻结对象与授权
- 用户确认继续零付费固定构建／离线场景，未授权真实 ai-sdk Provider 请求。沿用干净隔离 worktree `/private/tmp/pilot-g1-fixed-f2252170`、HEAD `f22521704df5130e7feeca1f5984706a7a1b2184`；打包应用 `app.asar` SHA-256 见 `note-pilot-g1-fixed-20260930.md`。主树并行未提交源码不入本次测试。
- GUI 运行的临时根 `/private/tmp/pilot-ui-f2252170-biyPxw`，启动参数 `HOME=<root>/home PROMA_TEST_CONFIG_DIR=<root>/config PROMA_ALLOW_MULTI_INSTANCE=1 GRAVITAS_PACKAGE_SMOKE=0`，固定目录包 `Gravitas.app/Contents/MacOS/Gravitas`。未输入真实凭据、未发行 Pilot 活动授权，未运行 Pilot Runtime。普通窗口路径没有 package-smoke 的显式 `app.setPath('userData',...)`，不能保证所有 Electron profile 都在配置根；初始弹出 macOS Keychain Not Found，用户自行处理。日志中渠道 safeStorage 不可用并降级明文，故**不得在该环境录入真实 Key**。

## 可核验的结果
- 固定包主进程 PID 84266 启动存活、创建窗口（System Events 可见窗口 `proma-mit`），日志显示项目管理 IPC 注册、工作区监听启动、自动更新模块初始化且自动检查停用；`settings.json` 等落在隔离配置根。欢迎引导完成并写 `onboardingCompleted`。这仅证明真实打包进程/窗口启动；不是 Pilot 页面可达性证明。
- 启动日志有 `startBriefCallbackServer` 监听 8765 端口 EADDRINUSE（与现有进程冲突，safeAwait 隔离，不阻止窗口）；Electron service worker storage IO error；`safeStorage` 不可用。它们均需作为固定包验收环境限制记录，不能忽略。
- 本次续验：用户将隔离实例切前台后，`ComputerUseFrontmostApplication` 返回 PID **84266**，`lsof` 验证同 PID 打开固定包 `app.asar` 和 `/private/tmp/pilot-ui-f2252170-biyPxw/config/projects/paa.db`。再次请求 `ComputerUseScreenshot` 结果为**操作已中止**；尊重授权结果，不再读取/控制桌面。此前截图只显示日常进程 PID 54112，不用于隔离 UI 判定。未视觉验证 Pilot 项目概览、策略编辑、预览/审批/暂停按钮；当前不判 Pilot UI PASS。
- 在修正 workspace 包链接的干净 HEAD worktree 另跑 `ProjectPilotPolicyEditor/control/readiness/approval/background-e2e/native-crash` 六文件：**33 PASS/0 fail、175 assertions**。其中 PolicyEditor 仅候选筛选纯函数，不是组件渲染、点击或打包 UI；其余为独立主进程逻辑夹具。未调用 Provider。
- 干净 worktree `bun test apps/electron/src/main/lib/project-pilot-*.test.ts apps/electron/src/renderer/components/projects/ProjectPilotPolicyEditor.test.ts`：**245 PASS/0 fail、1105 assertions，31 文件**。追加 `agent-development-execution`、`development-review-fixture`、`agent-orchestrator.projectdir`、`knowledge-tool`、`project-workspace-bindings` 五文件：**43 PASS/0 fail、153 assertions**。测试使用隔离临时数据库与固定 HEAD 源码，无 Provider 调用；其中 Runtime/评审结论/部分 readiness 为替身。

## A01–A07/A09a 对照（均非完整 G1 通过）
| 场景 | 已有离线证据 | 固定包 UI/端到端缺口 |
|---|---|---|
| A01/A02 | G1 fixture 与 background-e2e：页面未挂载时后台事件推进、并行排队、依赖解除续派 | 未在打包 UI 中从目标生成结构化计划/员工角色并离开页面观察真实执行 |
| A03 | fixture 与后台测试：executor→reviewer→有限返工→再审 | 评审缺陷/结算由测试注入；未证明真实模型识别或实际代码评审 |
| A04/A05 | approval 与 inbox 局部：版本化答复、拒绝、重复/旧版本不重放及重启续派 | UI 人工答复与主动通知未验；续派命令不等于 Runtime 续跑 |
| A06 | grant-pause/control：预览、逐项待停止与保守对账、预算/过期阻断 | 打包 UI 确认链、真实终止凭据、人工消解未验；stop 接受≠终止 |
| A07 | Git worktree cwd、知识读取跨项目拒绝、正式工作区绑定局部 | Pilot 命令实际启动 Runtime 后的文件/知识隔离未验，不是系统沙箱 |
| A09a | Node/Electron run-as-node WAL SIGKILL 重开，审批事件丢失后同库排队恰一 | 非打包主进程强杀/断电/外部副作用与会话真实重启矩阵；审批活动记录缺失 |

## 用户手动截图补证（2026-09-30）
- 用户先提交隔离项目 Pilot 概览截图，随后提交两张下拉框局部图，说明执行员工和技术评审员工列表为空。执行员工原生选择列表仅见「请选择」；技术评审员工当前显示「请选择」，用户确认下拉无候选。图片本身不含进程 ID/构建哈希，仅与此前已核验的隔离固定包会话关联；据此只能判「界面可达、候选缺失」，不能判 UI 完整场景通过。
- 源码 `ProjectPilotPolicyEditor.tsx` 从 `paa.agentEmployees.list()` 加载并过滤：enabled、development、safe、非 workflow、runtime 为 proma/ai-sdk、channelId 和 modelId 均非空；共同 Git 工作区依赖两名不同且同渠道/模型的员工并共享已配置 rootPath 的工作区。空下拉可能是隔离配置没有符合条件的员工，也可能是加载失败（需查看页面是否有加载错误）；不能据截图断定 UI 缺陷。无需填写真实 Key；不要发行活动授权或启动 Runtime。

## 空候选阻断截图（image-3.png，2026-09-30）
- 用户按指引保持执行/技术评审员工及共同 Git 工作区均为「请选择」，点击「保存暂停草案」后，界面显示红色提示「请完整选择两名同渠道/模型的安全研发员工、共同 Git 工作区和有效额度」；上方仍显示「尚未保存 Pilot 策略草案」。与固定 HEAD `ProjectPilotPolicyEditor.tsx` 的 `save()` 参数校验提前返回一致。截图可支持“空候选被 UI 阻断、没有出现保存成功状态”，但不独立证明 IPC/数据库绝无写入、也无法单凭图片验证进程与包哈希；不等于正向草案保存、预检或完整 G1 验收。画面内 USD 2 是表单默认上限，并非付费许可。

## 正向零付费 UI 验收（2026-10-05，隔离根 pilot-ui-f2252170-v2）
- 10-02 重建固定 worktree 与打包（asar `1c96ab6e…`，与 9-30 `3a51d84f…` 不同：asar 含时间戳，重建哈希差异属预期）；10-05 发现 /tmp 均存活，主树 HEAD 仍 f2252170。
- 夹具：esbuild 打包临时脚本（external electron/better-sqlite3）+ Electron run-as-node 运行（bun 直接跑会因主树 electron 包 CommonJS 导出报语法错误）。生产函数创建：Git 仓库（初始提交）→ createAgentWorkspace（pilot-ui）→ 权威 channels.json 夹具（forward-channel-ui，`https://pilot.invalid/v1`+无效 Key）→ 生产 createAgentEmployee ×2（ai-sdk/development，permissionMode 落库 safe）→ createProject「Pilot UI 正向验收」→ bindWorkspaceToProject 成功；inspectPilotReadiness 仅报「尚未保存 Pilot 策略草案」。未建 grant/task/command，零 Provider 请求。临时脚本与 .cjs 已删除，worktree git status 干净。
- GUI 启动：PROMA_TEST_CONFIG_DIR+HOME 隔离 + PROMA_ALLOW_MULTI_INSTANCE=1（官方测试开关；不加会被日常实例的单实例锁拦截）。8765 端口 EADDRINUSE 已被应用隔离；safeStorage 不可用→渠道明文降级提示（渠道仅无效 Key，无风险）。
- **用户截图 image-4：保存暂停草案成功**——「策略草案已保存，需通过预检并另行确认活动授权」，策略版本 1，执行者/评审者 ID 与夹具员工一致，模型 forward-channel-ui/glm-5.3-flash，2.00 USD 上限·2 次，有效期 10/6 04:21（+24h）。
- **三方配对**：project-pilot-policies.json 回读 revision 1/state paused/workspaceId/employeeIds/executor/reviewer/modelId/channelId 与截图及夹具 DATA 完全一致；maxCostMicros 2,000,000=maxRuns 2/maxRework 1/expiresAt=updatedAt+86400s；无遗留 .lock。UI 文案与 PilotPolicy 结构（state 恒 paused、授权另发）一致。
- **重启持久化（已完成）**：kill 68515 → 重启 PID 71666 → 磁盘回读仍 revision 1/paused；用户截图确认重启后 UI 仍显示策略版本 1 与全部冻结字段。
- **预检预览（已完成）**：用户点「预览活动授权影响面」成功打开发行确认面板，完整列出工作区/执行/评审/模型/USD 2·2 次·返工 1/有效期——生产 readiness 在夹具上通过；用户点取消，`pilot_runtime_grants`=0、`pilot_intents`=0，未发行授权。
- **发现 UX 缺陷**：活动授权卡片（执行者/评审者）与发行确认面板（工作区/执行/评审）只显示 UUID 不显示名称，人工无法直接核对授权对象，违背人工验收闸门可用性要求；`ProjectPilotGrantControl.tsx:155/156/169` 三处直显 ID，该文件不在并行改动中可安全修改。
- 边界：渠道仍是夹具文件写入（非 GUI createChannel）；未发行授权、未启动执行；G1 仍未通过。

## 显示缺陷修复回验（2026-10-05，提交 8b0a4da8）
- 三处 UUID 直显改为 `resolveDisplayName`「名称 (8 位短 ID)」：授权卡片执行者/评审者、发行确认面板工作区/执行/评审；名称映射挂载时经 `paa.agentEmployees.list()`+`listAgentWorkspaces()` 加载，失败回退短 ID，不阻塞授权状态展示。
- 门禁：九包 typecheck、Biome 单文件、`git diff --check` 通过；提交 `8b0a4da8` 已推送，仅含 GrantControl 一个文件（不在并行改动中）。
- 固定 worktree checkout `8b0a4da8` 重建：build+electron-builder --dir 通过，asar SHA-256 `9374e614…`（替代修复前 `1c96ab6e…`）；kill 71666 → 重启 PID 77750，磁盘回读 revision 1/paused 正常。
- 用户在 PID 77750 验证显示「没问题」。台账 PILOT-20261005-79 同步。不能以总测试数取代单场景实际验收。未核实进程的网络日志并不能证明所有启动服务完全零外连，只能说没有配置真实 Key、没有调用 Pilot Provider。
