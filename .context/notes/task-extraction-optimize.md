# 2026-08-09 任务提取模块优化 — 区分「动作描述」与「真实 To-do」

> 背景：拉取飞书文档（学习/战略文档）后，提取模块爆出 35 个 to-do，
> 但文档里**真实可执行的 to-do 实际只有 7 个**。根因是把"策略步骤/背景描述"
> （如"商品运营：定期进行产品线更新"）也误提取成了任务。

## 根因
1. 旧 Prompt 没有引导 LLM 区分「动作描述/策略说明」与「真实 To-do/行动项」。
2. 旧解析器对每个编号/列表点都视为任务标题 → 动作描述全被当作任务。
3. 负责人 mentions（`@用户664170`）没被识别为 assignee，混在标题里。
4. 没有章节分组，35 个任务平铺。

## 改动（`project-agent-service.ts`，Prompt + 解析器层）

### Prompt（`buildTaskExtractionPrompt`）
- 显式指引区分「动作描述」（策略/认知，不提取）与「真实 To-do」（去执行、有负责人、To-do/todo/待办字样）。
- 要求标题精炼（动作+对象，20 字内）、从 `@某人` 提取负责人、判断所属章节、填优先级/截至日。
- 输出改为 **JSON 数组**（`[{title, description, assignee, priority, category, dueDate}]`），无任务输出 `[]`。

### 解析器（`parseTaskExtractionResponse`）
- 优先尝试解析 JSON 数组（含 ```json``` fence 兼容）；失败回退到原 Markdown 编号路径。
- 新增 `category`（章节）字段；章节作为纯章节标题时记录为上下文、不作为任务（`extractAssigneeAndTitle` 的 `isCategoryOnly`）。
- mentions 清洗：`@某人`/`XX牵头` → 纯人名（`cleanAssignee`）；标题尾部"待定/后续/再议"移除（`cleanTitle`）。
- Markdown 路径新增"字段行先行拦截"（`isFieldLine`），避免 `- 描述:` 类字段行被误判为任务标题（关键修复）。

### 落地
- `extractedTaskToDraftInput`：章节前缀 `【章节】` 写入 description（Task 无独立 category 字段，用前缀不破坏 schema），以便前端分组展示。

## 新增测试（`project-agent-service.test.ts`，10 用例）
JSON 解析（章节/负责人/优先级）、空数组、fence 兼容、mentions 清洗、标题待定后缀移除、
Markdown 回退路径、无 Action Items、Prompt 内容断言、draft input 章节前缀、无章节不加前缀。

## 关键决策（用户确认）
1. 无显式 To-do 标注时，**交给 LLM 判断**（Prompt 引导区分，不只靠关键词）。
2. **保留章节分组**（category 字段返回 + 描述前缀落地）。
3. 改动限定在 **Prompt + 解析器**层，不碰数据库 schema / 前端。

## 注意点
- LLM 输出 JSON 是关键假设；解析器对非 JSON 输出回退 Markdown，保证了向后兼容。
- 章节识别的启发式（短标题 + `优化/建设/能力` 等尾缀）较保守，可能出现少量误判，但回调余地大。
- assignee 目前只是从 mentions 提取的人名字符串，尚未映射到真实成员 userId（`{userId, displayName}` 中 userId 暂时=人名）。如需精确指派需结合用户映射（`user_mappings` 表）。
