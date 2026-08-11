# Computer Use 插件化 + 分档配置门控实施方案

借鉴 Codex 的 `computer-use@openai-bundled` 插件 + enterprise requirements 分档门控设计，
把 Gravitas 当前硬编码的 Computer Use 能力改造为「插件化 + 分档配置门控 + 注册期平台过滤」。

## 现状要点（已勘察确认）
- **工具注册**：Computer Use 15 工具在 `apps/electron/src/main/lib/agent-runtime/tool-registry.ts` 的
  `createCoreTools()` (L218-232) 无条件硬编码注册；`CreateCoreToolsOptions` 仅 `workspaceSlug`。
- **权限门控**：`agent-permission-service.ts` 的 `isComputerUseTool()` (L505-507) 把除 Status 外所有 CU 工具判为
  「逐次确认」；`isHighRiskTool()` (L499) 硬编码；safe/plan 模式 `ai-sdk-runtime-core.ts` (L419-507) 内只放行只读。
- **插件系统**（骨架）：`packages/shared/src/types/plugin.ts`
  - `PluginPermissions` **无 computerUse 字段**（仅注释"默认禁止"）(L52-73)
  - `PluginSurfaceType` **无工具类 surface**（仅 overlay/notification/.../bridge-connector）(L20-35)
  - `entrypoints.runtime` **无人读取**（所有内置插件 entrypoints={}）(L109-119)
  - `plugin-manager.ts`：`BuiltinPluginRuntime` 仅 isEnabled/setEnabled/isSupported，**无"贡献工具"**；仅灵动岛一个内置
- **工具注入 Agent**：`agent-orchestrator.ts` L658-668/759 通过 `ProviderAgnosticAgentQueryOptions.extraTools` 注入
  （目前仅 collaboration 用）
- **平台**：`computer-use-service.ts` 运行时已按 darwin 区分；构建脚本 `build-computer-use-helper.ts` 也判断 darwin

## 设计决策
平台注册期过滤用 `process.platform === 'darwin'`（与 computer-use-service 现有判断一致）。

## 分阶段实施

### 阶段 A — 升级插件系统到"能贡献工具"
1. **`plugin.ts` 类型扩展**：
   - `PluginPermissions` 新增 `computerUse?: ComputerUsePluginPermissions`（分档）
     ```ts
     export interface ComputerUsePluginPermissions {
       enabled?: boolean      // 是否启用 Computer Use（总开关）
       readOnly?: boolean     // 仅只读子集（Status/Capabilities/Frontmost*/Displays）
       allowWrite?: boolean   // 是否允许写操作（Screenshot/Click/Type/Scroll/Drag/KeyCombo/Takeover）
     }
     ```
   - `PluginSurfaceType` 新增 `'agent-tools'`（插件贡献 Agent 工具）
2. **`plugin-manager.ts` 扩展 `BuiltinPluginRuntime`**：
   - 新增可选 `contributeTools?: () => RuntimeToolDefinition[]`（声明式贡献工具）
   - 注意安全：contributeTools 由**主进程安全代码**实现（内置插件提供闭包）；第三方插件不直接加载任意 JS，
     仅通过 `registerPlugin` 提供的受管 runtime 句柄（保持"第三方不能注入主进程"约束）
3. **新增"插件→Agent 工具注入桥"** `plugin-tool-contributor.ts`：
   - 收集所有 `enabled && isSupported()` 插件 `contributeTools()` 的产物 → 返回统一工具数组
   - 供 `agent-orchestrator.ts` 汇入 `extraTools`

### 阶段 B — 把 Computer Use 抽成第一个工具插件
1. 新增 `apps/electron/src/main/lib/plugins/computer-use-plugin.ts`：
   - manifest 声明 `surface: ['agent-tools']`、`platforms: ['darwin']`、`permissions: { computerUse: {...} }`
   - `contributeTools()` 返回现有 15 个 CU 工具（从 tool-registry 抽出逻辑，经 computerUseService 转发）
   - `isSupported()` = `process.platform === 'darwin'`
2. `plugin-manager.ts` 的 `BUILTIN_RUNTIMES` 注册 `com.gravitas.computer-use`
3. **`tool-registry.ts` 移除硬编码 CU 注册**，改由插件贡献；`CORE_TOOL_NAMES` 中 CU 名称保留（白名单仍校验）
4. `agent-orchestrator.ts` 把插件贡献工具并入 `extraTools`（与 collabExtraTools 并列）

### 阶段 C — 分档配置门控
1. 注册期：插件 `enabled=false` 或 `!isSupported()`(非 darwin) 或 `computerUse.enabled=false` → 不贡献工具
2. 权限层 `isComputerUseTool()` / `isHighRiskTool()` 接入分档：
   - `computerUse.readOnly && tool ∈ 只读子集` → 允许（免逐次确认）
   - `computerUse.allowWrite && tool ∈ 写操作` → 允许（仍建议保留逐次确认兜底，见 C4）
   - 其他 → 维持现状（逐次确认）
3. `ai-sdk-runtime-core.ts` safe/plan 白名单跟随 readOnly 子集
4. **安全性底线**：分档只"放宽到插件声明的级别"，`isHighRiskTool` 的写操作逐次确认默认保留（插件不声明则不放开），避免绕过安全锁

### 阶段 D — 同步 + 测试 + 文档
1. `CORE_TOOL_NAMES`、`permission-rules.ts` SAFE_TOOLS、ai-sdk-runtime-core 白名单随抽离/分档同步
2. 测试：
   - plugin-manager 新能力（contributeTools 收集、启停联动）
   - computer-use-plugin（platform 过滤、enabled/分档矩阵）
   - tool-registry（CU 工具不再硬编码）
   - 权限层分档矩阵
3. 回归：现有 agent/权限测试
4. `CLAUDE.md` 沉淀插件贡献工具架构

## 实施状态（2026-08-11）
### 阶段 A — 插件系统升级 ✅
- `plugin.ts`：`PluginSurfaceType` 新增 `'agent-tools'`；`PluginPermissions` 新增 `computerUse?: ComputerUsePluginPermissions`（enabled/readOnly/allowWrite）
- `plugin-manager.ts`：`BuiltinPluginRuntime`（已导出）新增 `contributeTools?: () => RuntimeToolDefinition[]`；`registerPlugin` 透传；新增 `collectContributingTools()`（仅收 enabled+supported 插件工具）+ `_resetPluginManagerForTests`
- 安全：`contributeTools` 只由内置插件闭包/受管句柄提供，第三方不加载任意 JS

### 阶段 B — Computer Use 抽成插件 ✅
- 新增 `apps/electron/src/main/lib/plugins/computer-use-plugin.ts`：manifest surface=['agent-tools','settings']，platforms=['darwin']，permissions.computerUse={enabled,readOnly,allowWrite:true}；`isSupported()=darwin`；`contributeTools()` 返回全部 CU 工具（按宿主配置裁剪）
- `BUILTIN_RUNTIMES` + `BUILTIN_PLUGINS` 注册 `com.gravitas.computer-use`
- `tool-registry.ts`：移除硬编码 CU 注册，改由 `appendPluginTools()`（name 去重）从插件收集；`CORE_TOOL_NAMES` 保留 CU 名称（白名单校验）
- `agent-orchestrator.ts`：结构校验冲突已修复（run 前验证），未改注入（沿用 createCoreTools 合并路径）

### 阶段 C — 分档配置门控 ✅
- `AppSettings` 新增 `computerUse?: { enabled?, readOnlyOnly? }`（host-level gate，`apps/electron/src/types/settings.ts`）
- 插件 `contributeTools()` 读取 host 配置：`enabled=false`→不贡献；`readOnlyOnly=true`→仅只读子集；默认全量（保持现状）
- 分档语义：manifest 声明上限 + 宿主门控实际放行，取交集；写操作逐次确认安全底线保留在权限层（未绕过）

### 阶段 D — 同步 + 测试 + 文档 ✅
- 测试：`computer-use-plugin.test.ts`（manifest/platform/collect 5 用例）+ plugin-manager 既有测试通过
- 回归：26 个相关测试全过（plugin + CU 工具 + MCP）；shared/electron tsc + biome 通过
- 已确认：`runtime-routing-agent-adapter.test.ts` 的 1 个失败为**既有失败**（DEFAULT_AGENT_RUNTIME='pi' 与测试期望 'claude' 不符，与本次改动无关，git diff 无该文件）

## 风险与边界
- **安全**：第三方插件不能注入主进程/加载任意 JS——本方案通过"内置插件闭包贡献 + 第三方仅受管句柄"保持约束。
- **行为变更**：默认 `computerUse.enabled=true` 保持现状可用（插件默认 enabled），非 darwin 不再注册工具（原为执行期报错）。
- **影响面**：plugin.ts/plugin-manager/tool-registry/computer-use-plugin/settings.ts/agent-orchestrator。

## 风险加固（第二轮，2026-08-11）✅
依据 code-review 发现补以下缺陷：
1. **僵尸开关修复**：插件 `isEnabled/setEnabled` 由恒 true 改为委托 host `settings.computerUse.enabled`；`setEnabled` 写 settings 并返回是否有变化。消除"插件启停 UI 无效"。
2. **分档门控接通 UI**：新增 IPC 通道 `GET/SET_COMPUTER_USE_SETTINGS` + preload 桥；`AutomationSettings` 新增"启用级别"三档（关闭/只读/完整）写 `settings.computerUse.{enabled,readOnlyOnly}`。默认仍 full（保持现状），但用户现在可收紧。
   - 涉及：`packages/shared/src/types/agent.ts`（通道常量）、`apps/electron/src/main/ipc.ts`、`src/preload/index.ts`、`renderer/components/settings/AutomationSettings.tsx`
3. **prompt 条件注入**：`AUTOMATION_TOOL_GUIDE` 拆为 `WEB_AND_MEMORY_GUIDE`（恒注入）+ `COMPUTER_USE_GUIDE`（仅 darwin 且 enabled 时注入）；消除非 darwin/disabled 时 prompt 引导调用不存在工具的问题。
   - 涉及：`apps/electron/src/main/lib/agent-runtime/prompt-builder.ts`（含测试随结构调整）
- 验证：38 个相关测试全过（新增 settings/prompt 结构用例调整）；shared/electron tsc + biome 通过。

