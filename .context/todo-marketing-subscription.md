# 营销订阅打通到 main + 按订阅细分（TODO）

## 目标
把营销订阅打通到 main，使促销注入按订阅联动；并按 influencer/paid-media 细分工具集与指令。

## 进度（2026-08-14 完成）
- [x] A1-A5：订阅打通 main（settings.json + marketing-atoms + isMarketingEnabled）✅
- [x] **细分注入（本次）**：
  - `marketing-plugin.ts`：MA_TOOL_GROUPS 按 domain 分组（influencer 8 / paid-media 7）
  - `ma-tool-prompts.ts`：每个条目加 domain 字段（7 paid / 8 influencer）
  - `subscribedDomains()`：订阅集合 → 注入域（shared 固定随任一订阅）
  - `allMarketingToolDefinitions(subscribed)` / `contributePromptsForSubscribed(subscribed)` 按订阅过滤
  - runtime contributeTools/contributePrompts 经 `readSubscribedCapabilities()` 读订阅并过滤
- [x] 更新测试：13 pass（细分三态 + 指令过滤 + 默认订阅 influencer 行为）
- [x] electron typecheck exit 0
- [x] localStorage 迁移：用户选不迁移（默认已是 influencer，影响极小）

## 归属映射（用户确认采纳）
- influencer：match-ai / connect-bot / creative-pilot / kol-search / kol-crm / kol-portal / content-audit / script-studio
- paid-media：strategy-iq / campaign-agent / campaign-optimizer / campaign-tester / budget-forecast / content-tracker / ma-phase-reviewer
- shared（随任一订阅）：storyboard（分镜/素材）

## 验证
- 默认订阅 influencer → 只注入达人域工具+指令 + storyboard（投放策略/预算不注入）
- 只 paid-media → 只投放；两域同订 → 全部
- 全部测试通过；typecheck exit 0

## 关键文件
- main/lib/plugins/marketing-plugin.ts（细分逻辑）
- marketing/ma-tools/ma-tool-prompts.ts（domain 字段）
- renderer/atoms/marketing-atoms.ts（订阅来源）

## 备注
- 默认订阅 influencer 意味着策略/投放工具默认不注入（细分决策的预期行为）。用户订阅 paid-media 后才有投放工具。
