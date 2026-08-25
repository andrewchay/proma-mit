# 营销订阅打通到 main：按订阅注入工具+指令

## 目标
方案 A：把营销订阅状态从 renderer localStorage 迁移到 main settings.json（权威），使 marketing-plugin 能按「用户是否启用营销」决定注入工具与指令，避免非营销会话 token 浪费。

## 已确认决策（用户）
- 选 A：打通订阅到 main（彻底）

## 现状（已探索确认）
- renderer `marketing-atoms.ts`：`enabledCapabilitiesAtom = atomWithStorage('proma-marketing-enabled-capabilities', ['influencer'])`（localStorage）。
- 消费方：`CapabilityCenterPanel`（读写）、`LeftSidebar`（导航显隐）——都经 `useAtom(enabledCapabilitiesAtom)`。
- settings IPC 已完备：`window.electronAPI.getSettings()` / `updateSettings()`（main handler 已注册，preload 已暴露）。
- renderer settings atom 范式：`XxxAtom`（内存）+ `initializeXxx(setFn)`（读 getSettings）+ `XxxInitializer` 组件（main.tsx 注册，useEffect 调 initialize）。
- AppSettings 在 `apps/electron/src/types/settings.ts`，可扩展。
- settings-service：`getSettings()` 读 settings.json；`updateSettings` 持久化 + `notifySettingsChange`。

## 实施步骤

### A1 类型：AppSettings 加营销订阅字段
- `apps/electron/src/types/settings.ts` `AppSettings` 加：
  `marketingCapabilities?: string[]`（已订阅业务包 id：influencer / paid-media）

### A2 renderer marketing-atoms.ts 重构
- `enabledCapabilitiesAtom` 从 `atomWithStorage` 改为 `atom<CapabilityId[]>`（内存态）
- 默认 `['influencer']`（保持现状默认启用）
- 新增 `initializeMarketingCapabilities(setFn)`：`getSettings().marketingCapabilities ?? ['influencer']`
- `toggleCapability` 仍是纯函数；CapabilityCenterPanel 在 toggle 后用 `updateSettings({ marketingCapabilities })` 持久化

### A3 renderer main.tsx 注册初始化
- 新增 `MarketingCapabilitiesInitializer` 组件（useSetAtom + useEffect 调 initializeMarketingCapabilities）
- 在既有 settings 初始化区渲染（仿 UiPreferencesInitializer/MarkdownFontSizeInitializer）

### A4 main marketing-plugin isEnabled 接订阅
- `marketingPluginRuntime().isEnabled` 改为：
  ```ts
  isEnabled: () => { const caps = getSettings().marketingCapabilities ?? ['influencer']; return caps.length > 0 }
  ```
  （延迟 require settings-service，防循环依赖；platform 全支持）
- 未订阅（marketingCapabilities 存空数组）→ isEnabled false → `collectContributingTools`/`collectContributingPrompts` 都不注入营销工具+指令

### A5 测试与验证
- electron typecheck exit 0
- marketing-plugin.test：isEnabled 反映订阅（mock settings）；未订阅时不 contribute
- 探测：默认订阅 influencer → 工具+指令仍注入；清空订阅 → 不注入

## 关键约束 / 风险
- **默认值一致性**：renderer（atom 初始化）与 main（isEnabled）都用 `?? ['influencer']`，保证首启/未设置时默认启用 influencer。
- **isEnabled 每次读 settings 文件**：collectContributingTools/Prompts 组装时多次调用 → 多次磁盘读。settings.json 很小，可接受；后续可加缓存。
- **持久化迁移**：首次迁移，localStorage 旧值不自动复制到 settings.json。可接受（默认值一致）；如需保留用户旧选择可加一次性迁移（可选，本轮不做）。
- **CapabilityCenterPanel 持久化点**：需确保每次 toggle 调用 updateSettings，否则刷新后丢失。

## 关键文件
- apps/electron/src/types/settings.ts
- apps/electron/src/renderer/atoms/marketing-atoms.ts
- apps/electron/src/renderer/main.tsx
- apps/electron/src/renderer/components/settings/CapabilityCenterPanel.tsx
- apps/electron/src/main/lib/plugins/marketing-plugin.ts

## 收货
- 营销工具+指令仅在用户启用营销时注入 → 非营销会话减 token
- 营销「领域业务包」订阅从 UI 门面升级为真实的运行时门控（对齐最初的「领域 vs 插件」边界判断）
