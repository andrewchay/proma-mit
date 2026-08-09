# 2026-08-09 飞书文档拉取会议纪要 — 实现记录

> 对齐已有「钉钉文档拉取」，为飞书增加同等能力（会议纪要 ← 飞书云文档 → AI 提取任务草稿）。
> 已实现，typecheck 全绿 + 单测通过。待真实链接实测。

## 文件改动

| 文件 | 改动 |
|------|------|
| `main/lib/feishu-doc-fetcher.ts`（新增） | 飞书文档拉取器，四种类型路由 |
| `main/lib/feishu-doc-fetcher.test.ts`（新增） | URL 解析单测 7 用例 |
| `main/lib/project-service.ts` | 新增 `importFeishuDocAndExtractTasks` |
| `shared/types/work-module.ts` | 新增 `FETCH_FEISHU_DOC` 常量 |
| `main/lib/work-module-ipc-handlers.ts` | 注册 FETCH_FEISHU_DOC handler |
| `preload/index.ts` | 新增 `fetchFeishuDoc` 桥接 + 类型 |
| `renderer/.../ProjectView.tsx` | MeetingNotesPanel「云文档拉取」入口 + 钉钉/飞书切换 |

## 飞书文档开放 API 关键路径（供复用）

- **新版文档 docx**：`GET /open-apis/docx/v1/documents/{document_id}/raw_content`
  → 响应 `content`（纯文本）。URL `feishu.cn/docx/{id}`。
- **电子表格 sheets**：`GET /open-apis/sheets/v3/spreadsheets/{token}/sheets/query`
  → `data.sheets[].sheet_id/title`；再 `GET /open-apis/sheets/v2/spreadsheets/{token}/values/{sheet_id}!A1:K{N}`
  → `data.valueRange.values[][]`。URL `feishu.cn/sheets/{token}`。
- **知识库 wiki**：`GET /open-apis/wiki/v2/spaces/get_node?token={node_token}`
  → `data.node.obj_type/obj_token/title`，再按 obj_type 路由。URL `feishu.cn/wiki/{node_token}`。
- **多维表格 bitable**（wiki 节点 obj_type=bitable 时）：`GET /open-apis/bitable/v1/apps/{app_token}/tables`
  → `data.items[].table_id`；再 `GET .../tables/{table_id}/records?page_size=N` → `data.items[].fields`。
- **token**：`POST /open-apis/auth/v3/tenant_access_token/internal`，body `{app_id, app_secret}`，
  响应顶层 `tenant_access_token/expire`（注意新版放顶层，SDK 的 resp.data 可能 undefined）。

## 关键设计决策（用户确认）

1. 支持 docx + sheets + wiki（含 bitable）三种类型
2. UI 与钉钉**合并**为「云文档拉取」单一入口，弹窗内切换钉钉/飞书
3. 支持完整 URL 输入，自动解析（正则 `/[.](docx|sheets|wiki)\/(id)`，兼容 `.feishu.cn` 与 `.larksuite.com`，忽略 query）

## 注意点

- token 缓存用 tenant_access_token，按单 bot 实例缓存（非全局 Map，够用）。
- `createFeishuDocFetcherFromConfig` 复用 `settings.feishuTodo`（需 enabled + botId），
  经 `getFeishuBotById` + `getDecryptedBotAppSecret` 取明文密钥（safeStorage 解密）。
  注意：`getDecryptedBotAppSecret` 是同步函数。
- 权限错误给出可读提示（code 99991672/91604/99991600 → "请在开放平台开通查看XX权限"）。
- sheets/bitable 简单实现：取第一个工作表/数据表，读前 200 行。后续如需选择工作表需增强。
- 未配置/无权限时抛可读错误，前端 alert 展示。
