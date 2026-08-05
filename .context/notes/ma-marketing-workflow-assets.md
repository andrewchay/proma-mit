# MAPro 营销工作流资产索引

> 记录时间：2026-08-05
> 状态：资产已提取并落地，模板可导入，skills 已补齐

## 背景与目标

proma-mit（PAA Workflow 运行时）需引入 MAPro（ma-proma）的**社交营销 Campaign 工作流**（14 步标准流程）。本笔记是这次资产提取的**唯一入口索引**，定位所有落地物。

## 资产落地位置

| 类别 | 位置 | 说明 |
|------|------|------|
| 提取报告（总入口） | `~/.proma-mit/workflows/ma-marketing-workflow/README-extraction-report.md` | 流程+脚本代码提取的完整说明 |
| 流程定义（权威 JSON） | `~/.proma-mit/workflows/ma-marketing-workflow/workflow-definition.json` | 14 步完整定义（含 agentPrompt 10307 字） |
| 分步详解 | `~/.proma-mit/workflows/ma-marketing-workflow/steps/` | 14 个步骤 md + 概览 |
| 脚本文件包 | `~/.proma-mit/workflows/ma-marketing-workflow/scripts/` | chat-tools(20) + skills(22) + mcp + workflow-service |
| 脚本清单 | `~/.proma-mit/workflows/ma-marketing-workflow/scripts/scripts-manifest.md` | 每个脚本与 workflow 步骤的对应 |
| **PAA 可导入模板** | `~/.proma-mit/workflows/templates/template-ma-marketing.json` | 16 节点（start+14+end）DAG，已过 DSL 校验 |
| PAA 映射说明 | `~/.proma-mit/workflows/ma-marketing-workflow/paa-format/paa-mapping.md` | 14 步 → PAA DSL 映射与生成指引 |

## 营销工作流 14 步

```
market_analysis → competitor_analysis → user_analysis → brand_dna → brand_fact_check
→ brand_concept → goal_setting → creative_concept → platform_matrix → kol_pyramid
→ search_kols → add_to_pool → generate_briefs → ab_test
```

## 关键决策与注意事项

1. **PAA 格式**：`format: "paa.workflow"`, `formatVersion: "1.0"`。模板 Definition 已通过 proma-mit `WorkflowDefinitionSchema` 校验（16 节点、15 边、单 start/end、无环 DAG）。
2. **模板安装**：`installWorkflowTemplate('template-ma-marketing', workspaceId)` 会在目标工作区生成 Draft，需能力预检后发布才能 Run。
3. **凭证零落盘**：Definition 内严禁写入凭证；skill/mcp 凭证留在工作区配置。
4. **skill 依赖**：模板 skill 节点引用的 11 个 slug 已全部在 proma-mit 工作区就位（24 个 ma-* skill）。
5. **产物校验差异**：原流程用 `artifactRequirements`+`requiredFiles`（markdown 文件）；转换时保留在 agentPrompt 中，未强制 `outputSchema`（避免破坏原 markdown 落盘语义）。

## 本次补充创建的 Skill

proma-mit 工作区 `~/.proma/agent-workspaces/proma-mit/skills/` 现有 **24 个 `ma-*` skill**：
- 原有 11 个 + 补齐 11 个（ma-brand-house、ma-campaign-optimizer、ma-campaign-tester、ma-consumer-insight、ma-content-audit、ma-creative-roi、ma-kol-crm、ma-kol-history-review、ma-kol-portal、ma-kol-scraper、ma-script-studio）
- **新增 2 个**（原属 Chat Tool，为满足模板 skill 引用而补建）：`ma-market-analysis`、`ma-creative-pilot`

## 数据来源

- 流程：`/Users/chaihao/LLM/ma-proma/packages/server/src/campaign/campaign-workflow-service.ts` 的 `DEFAULT_WORKFLOW_STEPS`
- 脚本：`/Users/chaihao/LLM/ma-proma/apps/electron/default-skills/`、`apps/electron/src/main/lib/ma-tools/`、`apps/electron/mcp-servers/ma-kol/`
