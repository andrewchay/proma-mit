# 服务端 Agent 可观测性 API（运行档案 / Signals / 评估数据集）

> 事实校准：2026-08-04
> 范围：`apps/server` 暴露的 Agent 运行时可观测相关 REST 端点。
> 前置：这些端点依赖 P-I（Runtime Span）、P-II（Signals）、P-IV（Eval Dataset）的存储与扫描能力，未初始化会自动建表。

## 1. 概览

服务端为一次 Agent 运行维护**运行档案（Run Profile）**：以 `taskId`（一个 run 的逻辑 traceId）为锚，把 **span 树 + usage（token/cost）+ audit** 关联成一份可下钻的记录。其上叠加两类消费：

| 模块 | 作用 | 端点前缀 |
|---|---|---|
| 运行档案 Run Profile | 一次 run 的 span 树 + 成本 + 审计 | `/agent/runs`、`/agent/traces` |
| Signals | 用「人话 + matcher」周期性扫描 span 表，命中落 hit | `/agent/signals` |
| Eval Dataset | 把运行采样/归档成评估样本（含截断 input/output） | `/agent/datasets` |

通用约定：
- 认证：Bearer token（`authorization: Bearer <token>`）或 `x-proma-tenant-id`/`x-proma-user-id`（`trustedHeaderAuth`）。
- 所有响应均为 JSON。
- 权限角色：`operator` / `admin` / `security-auditor` 可读；写操作需 `operator` / `admin`。

## 2. 运行档案 Run Profile

### `GET /agent/runs/{taskId}`
返回一次运行的综合档案：span 树 + usage + audit。

**响应 200**
```json
{
  "taskId": "…",
  "trace": [ { "spanId": "…", "kind": "provider", "name": "provider:openai:gpt-4o",
               "status": "ok", "startedAt": 1, "endedAt": 5,
               "meta": { "inputTokens": 10, "outputTokens": 20, "costMicroUsd": 1234 },
               "children": [ { "kind": "tool", "name": "tool:Bash", "status": "error", "error": "…", "children": [] } ] } ],
  "usage": { "inputTokens": 10, "outputTokens": 20, "cacheReadTokens": 0, "cacheWriteTokens": 0, "costMicroUsd": 1234 },
  "audit": [ { "action": "POST /agent/sessions/x/run", "resource": "…", "result": "success", "createdAt": 5 } ]
}
```
- `trace` 为嵌套 span 树（provider → tool/child task 层级），每层含 `latency`（由 startedAt/endedAt 推导）、token、costMicroUsd。
- 若 task 无任何记录返回 `{}` 语义（HTTP 200 空对象）；无 span 但 usage/audit 存在时返回 usage + audit。

### `GET /agent/traces?taskId={id}`
等价于 `GET /agent/runs/{taskId}` 的 span 树部分，仅返回 `trace`。

### span 数据模型（`proma_runtime_spans`）
| 列 | 说明 |
|---|---|
| trace_id | 逻辑 trace（= taskId） |
| task_id / parent_span_id | 树组织 |
| span_id | 稳定标识 |
| kind | `task`/`provider`/`tool`/`subtask` |
| name | `provider:{provider}:{model}` 或 `tool:{toolName}` |
| started_at / ended_at | latency |
| status | `ok`/`error` |
| meta | JSONB：inputTokens / outputTokens / cache / costMicroUsd / sample |

## 3. Signals

### `GET /agent/signals`
列出当前 scope 的 Signals。

**响应**：`{ "signals": [ { "signalId","description","matcher","enabled","hitCount","createdAt" } ] }`

### `POST /agent/signals`
创建一个 Signal（人话描述 + matcher）。**写操作需 operator/admin**。

**请求体**
```json
{
  "description": "如果 agent 卡在循环里提醒我",
  "matcher": { "type": "tool_repeat_failure", "namePrefix": "tool:Bash", "minFailures": 3, "windowMs": 600000 },
  "enabled": true
}
```

**matcher 类型**
| type | 字段 | 判定 |
|---|---|---|
| `task_failure_rate` | minFailRate(0..1), windowMs | 窗口内任务失败率 |
| `tool_repeat_failure` | namePrefix, minFailures, windowMs | 同一 task 内工具连续失败数（循环检测） |
| `task_cost_threshold` | thresholdMicroUsd, windowMs | 单 task 累计成本超阈值 |
| `stale_task` | staleAfterMs | 失去租约的任务 |
| `provider_error` | namePrefix, minErrors, windowMs | provider span 错误次数 |

错误：`400`（description 为空 / matcher 无效），`201` 成功。

### `DELETE /agent/signals/{signalId}`
删除一个 Signal。写操作需 operator/admin。返回 `204` / `404`。

### `GET /agent/signals/hits?signalId=&from=&to=&limit=`
列出命中记录。**响应**：`{ "hits": [ { "hitId","signalId","message","evidence","createdAt" } ] }`
- `message` 为每类 matcher 生成的人话命中说明。
- 命中默认不主动触发 webhook；可选在 `operations` 配置 `alertWebhookUrl` 时以 `kind='signal_hit'` 告警。

## 4. 评估数据集 Eval Dataset

### `GET /agent/datasets`
列出数据集。**响应**：`{ "datasets": [ { "datasetId","name","sampleRate","windowMs","count","createdAt" } ] }`

### `POST /agent/datasets`
从窗口采样创建数据集。**写操作需 operator/admin**。

**请求体**
```json
{ "name": "回归集", "description": "可选", "windowMs": 3600000, "sampleRate": 1 }
```
- `windowMs`（毫秒，≥1000）、`sampleRate`（0..1，默认 1）。
- 返回 `201` + dataset；样本 `count` 为该窗口命中的 task 数。

### `POST /agent/datasets/from-run`
把指定 run 归档为样本。**写操作需 operator/admin**。
```json
{ "datasetId": "…", "taskId": "…" }
```
返回 `201` + sample / `404`（数据集不存在或无对应 span）。

### `GET /agent/datasets/{datasetId}/samples?limit=`
查看某数据集样本。**响应**：
```json
{ "samples": [ { "sampleId","taskId","kind","name","status","durationMs",
                 "inputTokens","outputTokens","costMicroUsd","input","output","error","rootedAt" } ] }
```
- `input`/`output` 仅在 **采样开启** 且该 run 命中采样时存在（截断字符串）；默认不采集内容快照。

### `DELETE /agent/datasets/{datasetId}`
删除数据集（连同样本）。写操作需 operator/admin。返回 `204` / `404`。

## 5. 采样配置（env）

默认关闭，且 span 始终只存轻量 meta 以守住 local-first；仅在需消费真实 input/output 评估样本时开启。

| env | 默认 | 说明 |
|---|---|---|
| `PROMA_WEB_SPAN_SAMPLING` | 未设置=关 | `1`/`true` 开启输入输出采样 |
| `PROMA_WEB_SPAN_SAMPLE_RATE` | `0.1` | 采样命中率 0..1 |
| `PROMA_WEB_SPAN_SAMPLE_MAX_BYTES` | `512` | 单段内容截断上限字符 |

## 6. 工作台 UI

`GET /agent/ui` 返回无构建依赖的 Agent 工作台（`dashboard.ts`），包含本组 API 的可视化 tab：**运行档案**（span 树）、**Signals**（列表/新建/命中）、**评估数据集**（列表/采样/样本）。

## 7. 关联表（自动建表）

| 表 | 归属 |
|---|---|
| `proma_runtime_spans` | P-I 运行档案 |
| `proma_runtime_signals` / `proma_runtime_signal_hits` | P-II Signals |
| `proma_runtime_eval_datasets` / `proma_runtime_eval_samples` | P-IV 数据集 |
| `proma_runtime_usage`（已有） | 成本来源（回填 span.cost） |
| `proma_runtime_audit_log`（已有） | 审计（按 taskId 关联 run） |
