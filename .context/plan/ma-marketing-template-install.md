# MAPro 营销工作流模板安装 + 能力预检报告

> 日期：2026-08-12
> 模板：`template-ma-marketing` (v1.0.0, 16 节点 / 15 边 DAG)

## 一、能力预检结果

### 1. Skill 依赖检查

模板引用 11 个 skill slug：

| Skill Slug | proma-mit WS | paa WS | ma-proma WS | Gravitas project WS |
|---|---|---|---|---|
| ma-market-analysis | ❌ | ❌ | ❌ | ✅ |
| ma-competitor-analyzer | ✅ | ✅ | ✅ | ✅ |
| ma-ta-portrait | ✅ | ✅ | ✅ | ✅ |
| ma-brand-dna | ✅ | ✅ | ✅ | ✅ |
| ma-brand-house | ❌ | ❌ | ❌ | ✅ |
| ma-campaign-optimizer | ❌ | ❌ | ❌ | ✅ |
| ma-creative-concept | ✅ | ✅ | ✅ | ✅ |
| ma-platform-role-mapper | ✅ | ✅ | ✅ | ✅ |
| ma-kol-pyramid | ✅ | ✅ | ✅ | ✅ |
| ma-creative-pilot | ❌ | ❌ | ❌ | ✅ |
| ma-campaign-tester | ❌ | ❌ | ❌ | ✅ |
| **合计** | **6/11** | **6/11** | **6/11** | **11/11** |

**结论**：proma-mit 所有工作区都缺少 5 个 skill，需要从 Gravitas project 工作区拷贝。

### 2. MCP / 工具依赖检查

| 依赖 | 用途 | 状态 | 影响步骤 |
|---|---|---|---|
| `web_search` (内置) | 品牌信息核实 | ✅ 就绪 | step 5: brand_fact_check |
| `kol-data/search_kols` MCP | 搜索筛选达人 | ❌ 未配置 | step 11: search_kols |
| `ma-campaign-agent` MCP | 达人入候选池 | ❌ 未配置 | step 12: add_to_pool |
| `境外投放MCP` | 广告投放数据 | ⚠️ personal WS 已启用 | step 14: ab_test (可选增强) |
| `境内投放MCP` | 广告投放数据 | ⚠️ personal WS 已启用 | step 14: ab_test (可选增强) |

### 3. 外部环境依赖

| 依赖 | 用途 | 状态 | 降级方案 |
|---|---|---|---|
| Chrome CDP (port 9222) | KOL 数据采集 | ⚠️ 需用户手动启动 | ma-kol-scraper 无法运行 |
| 蒲公英平台登录 | KOL 数据源 | ⚠️ 需用户在 Chrome 登录 | 同上 |
| KIMI_API_KEY | 图片审核 | ⚠️ 可选 | 降级为纯文字审核 |

### 4. 预检总结

| 类别 | 就绪 | 缺失 | 可选 |
|------|------|------|------|
| Skills (11) | 6 | **5** | — |
| MCP (3 必需) | 1 | **2** | 2 (投放数据) |
| 外部环境 (3) | 0 | — | 3 |

**阻断项**：5 个 skill 缺失 + 2 个 MCP 未配置

## 二、执行结果

### 2.1 模板安装 ✅ 已完成

工作流定义已存在于 `~/.proma-mit/workflows/ma-marketing/definition.json`：
- **状态**：published（已发布）
- **工作区**：ma-proma (4daba73a-db13-4584-bc29-d6b011f3318f)
- **节点**：16 个（start + 14 步 + end），15 条边
- **触发方式**：manual

### 2.2 Skill 补齐 ✅ 已完成

从 Gravitas project 工作区拷贝 4 个 skill + 从原 ma-proma Chat Tool 新建 1 个 skill：

| Skill | 操作 | 状态 |
|-------|------|------|
| ma-market-analysis | 从 Gravitas project 拷贝 | ✅ |
| ma-brand-house | 从 Gravitas project 拷贝 | ✅ |
| ma-campaign-optimizer | 从 Gravitas project 拷贝 | ✅ |
| ma-campaign-tester | 从 Gravitas project 拷贝 | ✅ |
| ma-creative-pilot | 从 creative-pilot.ts Chat Tool 新建（含 references/） | ✅ |

ma-proma 工作区现有 **17 个 ma-* skill**，覆盖模板全部 11 个 skill 依赖。

### 2.3 MCP 配置 ✅ 已解决

#### kol-data MCP（步骤 11: search_kols 依赖）

原 ma-proma 的 Python MCP server 依赖 `/Users/chaihao/LLM/ma/agent_core/`（本机不存在），
已创建**轻量替代 MCP Server**，直接用 `sqlite3` 读取 `~/.mapro/kol-database.sqlite`（已有 14 条 KOL 数据）。

- **MCP Server 代码**：`~/.proma-mit/agent-workspaces/ma-proma/mcp-servers/kol-data/mcp_server.py`
- **Python 环境**：`/opt/homebrew/bin/python3.11` + `mcp` SDK（已安装）
- **提供 4 个工具**：search_kols / get_kol_detail / get_kol_stats / sync_kol_data
- **数据库**：`~/.mapro/kol-database.sqlite`（14 条 KOL 记录）

#### ma-campaign-agent MCP（步骤 12: add_to_pool 依赖）

原 ma-proma 的 campaign-agent 是内置 Chat Tool（非 MCP），已创建**独立 MCP Server**，
在同一个 SQLite 数据库中管理 Campaign 候选池。

- **MCP Server 代码**：`~/.proma-mit/agent-workspaces/ma-proma/mcp-servers/ma-campaign-agent/mcp_server.py`
- **提供 5 个工具**：ma_campaign_get / ma_campaign_update / ma_campaign_kol_add / ma_campaign_kol_list / ma_campaign_kol_status
- **新建表**：`campaigns` + `campaign_kol_pool`（自动创建）
- **MCP 配置**：`~/.proma-mit/agent-workspaces/ma-proma/mcp.json`（两个 server 均已启用）

### 2.4 可选环境依赖

| 依赖 | 用途 | 状态 |
|------|------|------|
| Chrome CDP (port 9222) | KOL 数据采集 (ma-kol-scraper) | ⚠️ 运行时手动启动 |
| 蒲公英平台登录 | KOL 数据源 | ⚠️ 需在 Chrome 中登录 |
| KIMI_API_KEY | 图片审核 (ma-image-audit) | ⚠️ 可选，可降级为纯文字审核 |

## 三、预检结论

**✅ 核心阻断项已全部解决。** 工作流可以运行。

### 就绪项汇总

| 检查项 | 状态 | 详情 |
|--------|------|------|
| 工作流定义 | ✅ published | ma-proma 工作区，16 节点 / 15 边 |
| Skill 依赖 | ✅ 11/11 | 5 个拷贝 + 1 个新建（ma-creative-pilot） |
| kol-data MCP | ✅ 已创建 | 轻量 Python MCP，直接读 SQLite，4 个工具 |
| ma-campaign-agent MCP | ✅ 已创建 | 轻量 Python MCP，管理候选池，5 个工具 |
| KOL 数据库 | ✅ 14 条记录 | ~/.mapro/kol-database.sqlite |
| Python 环境 | ✅ python3.11 + mcp | /opt/homebrew/bin/python3.11 |

### 可选依赖（运行时按需）

| 依赖 | 用途 | 处理方式 |
|------|------|----------|
| Chrome CDP (9222) | KOL 采集 (ma-kol-scraper) | 运行时手动启动 |
| 蒲公英登录 | KOL 数据源 | Chrome 中登录 |
| KIMI_API_KEY | 图片审核 | 可选，可降级为纯文字 |
| 境外/境内投放 MCP | 广告投放数据 | personal 工作区已启用，可参考配置 |
