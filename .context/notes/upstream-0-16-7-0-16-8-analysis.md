# 官方 Proma v0.16.7 / v0.16.8 更新理解与 proma-mit 差距（2026-08-03）

> 官方 Proma 版本：0.16.8（2026-08-03），proma-mit 版本：0.10.21。
> 数据来源：官方 GitHub Release Notes（proma-ai/Proma）。

## v0.16.8 更新

### 新功能
1. **Proma 企业版：Skills 分发与协作** — 组织级 Skills 下发/版本/范围管理（企业版能力，本地个人版不涉及）。
2. **Vision Relay** — 文本型 Pi 模型图片请求中转给视觉模型，纯文本模型也能"看图"；加固文件访问/图像解码/上传，依赖 `sharp`（曾因打包缺失修复）。
3. **外部拖入文件接入 `@` 引用** — Finder 拖入普通文件 → 复制到会话私有目录 → 插入 `@file` 引用（非附件 chip）；超大/无项目/保存失败回退附件；修复路径含空格编码。
4. **Todo 描述草稿式自动保存** — 停顿 800ms 自动保存、失焦即存、关闭面板 flush；"保存中…/✓ 已保存"提示。

### Bug 修复
1. **Pi 上下文溢出恢复** — 溢出后可自动恢复继续对话。
2. **64K 输出上限只对真正 Claude 生效** — 修复 `includes('claude')` 误判（自定义 fork / gateway 代理别名被误注入 `CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000`）；改为按 Claude 家族名判断（claude-sonnet-4-6 / claude-3-5-sonnet-20241022）。
3. Scratch Pad 底部编辑缓冲保留。
4. 浅色主题选中文字前景色。
5. Vision Relay sharp 运行时打包。
6. OAuth 授权请求统一走应用代理。
7. macOS 26 前禁用灵动岛。

## v0.16.7 更新

### 新功能
1. **xAI 订阅（Grok OAuth）渠道** — 渠道设置直接授权 xAI，接入 Grok 系列模型，Pi 运行时可用。
2. **灵动岛收起态显示渠道额度** — 收起时直接展示活跃渠道额度摘要；多渠道标注数量。
3. **Windows 灵动岛交互优化** — 展开/收起/点击交互，恢复 Todo/日程提醒展示。

### Bug 修复
1. **Windows 剪贴板复制统一走主进程** — 规避 renderer 剪贴板权限限制。
2. Windows 规划窗口标题栏拖拽重叠修复。
3. 灵动岛"完成但未查看"状态同步修复。

## proma-mit 差距分析

### 已具备 / 已覆盖
- 灵动岛（Agent Island）：proma-mit 已有 `dynamic-island-service`（v0.9.x 引入）。
- 渠道额度展示：proma-mit 已有 ChannelPlanQuotaBadge（DeepSeek/Kimi 余额）。
- @ 文件引用：proma-mit 已有 file-path-chip / rich-text-input @ 引用基础能力。

### 值得借鉴 / 需要评估
1. **64K 输出上限误注入（官方 0.16.8 修复）** — ⚠️ proma-mit 同样存在：
   - `agent-orchestrator.ts:1110` `CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000'` **无条件注入**（不区分 provider）
   - `agent-orchestrator.ts:2156` `claudeAvailable = (modelId).toLowerCase().includes('claude')` 误判 fork/代理别名
   - 建议：改为按 Claude 家族名判断（复用 thinking-capability.ts 的识别逻辑）
2. **Pi 上下文溢出恢复** — proma-mit 未确认是否有等价处理；官方修复了溢出后无法恢复的问题。
3. **Todo 草稿自动保存** — proma-mit Todo 详情编辑未确认是否有防丢失保护。
4. **Vision Relay** — proma-mit 是否支持纯文本模型"看图"未确认。
5. **xAI/Grok 渠道** — proma-mit 未确认是否有 Grok 渠道。
6. **Windows 剪贴板主进程复制** — proma-mit 的复制实现未确认是否受 renderer 限制影响。

### 备注
- 官方版本线（0.16.x）与 proma-mit（0.10.x）已分叉；官方 release notes 不直接对应 proma-mit 功能集。
- 本项目有 `scripts/sync-upstream-assets.sh` 同步官方 Proma 资产（skills/CLAUDE.md 等），与版本功能跟踪是两条线。
