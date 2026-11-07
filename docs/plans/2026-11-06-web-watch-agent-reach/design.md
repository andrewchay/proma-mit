# 项目外网扫描接入 Agent-Reach — 设计稿

日期：2026-11-06
状态：草案（待评审）
范围：`project-web-watch-service` 采集层扩展；不动判断/观察/通知流水线。

## 1. 背景与动机

项目外网扫描（`project-web-watch-service.ts`）目前的唯一信息源是
`searchWebResults()`（Tavily / MetaSo 通用网页搜索）。对「盯一个项目的外部动态」
这个任务，通用搜索够不着的地方恰恰是高价值信息所在：

- 竞品的 GitHub 仓库动态（release、issue 讨论）
- B站 UP 主新视频、关键词新投稿
- V2EX 节点新帖与热议
- 小红书上的用户反馈（二期，需登录）

Agent-Reach 已在本机提供这些能力：一个 `agent-reach` CLI，14 个渠道，统一
一行 JSON 输出（envelope），语义化错误码，内置速率纪律与后端健康记录。
本设计把它作为**采集层的一个新来源**接入外网扫描，不改动其余链路。

### 为什么场景化接入而不是全域插件

1. **登录态依赖**：全域挂载后模型随时可能命中 `NEED_LOGIN`，对话被登录引导
   打断；后台扫描可以把登录渠道排除或静默降级。
2. **速率纪律**：CLI 内置同站并发 2、搜索间隔 10s、限流冷却 1h。交互场景里
   用户会觉得「怎么又 BUSY」；每日异步扫描对延迟不敏感。
3. **工具选择稀释**：全域加一个「什么都能查」的工具会与 WebSearch / WebFetch /
   Web Bridge 形成四选一，模型选路变差。

结论：Agent-Reach 在渠道、频率、错误处理都可预期的受控场景里体验最好；
项目外网扫描是当前最契合的场景。

## 2. 总体方案

```
调度（不变：60s tick + isProjectWebWatchDue）
  ↓
预算门禁（不变：isOwnerBudgetExhausted）
  ↓
采集层（扩展点）
  ├── topics × searchWebResults()        ← 现有， Tavily/MetaSo
  └── sources × agentReachCollect()      ← 新增， spawn CLI
  ↓
统一 WatchSourceItem[]（URL 去重 + snippet 版本比较，逻辑不变）
  ↓
LLM 观察判断（不变：buildWebObservationPrompt / judgeAndRecordWebObservation）
  ↓
观察投递与通知（不变）
```

关键决策：

- **只扩展采集层**。run 流水、观察记录、反馈、通知全部复用，新增字段全部可选，
  旧数据零迁移。
- **spawn CLI，不移植代码**。Python 与 TS 之间用 JSON envelope 做契约，Agent-Reach
  的错误码体系就是为这个设计的。
- **单源失败不掀翻整轮**。与 `seedDefaultSkills` 的「单 skill 失败不影响其他」
  哲学一致；只有所有采集路径都失败才把整轮记为 `failed`。
- **一期只用免登录渠道**：github / bilibili / v2ex / web。登录渠道（小红书、雪球）
  等 `NEED_LOGIN` 引导体验在扫描场景验证过再开。

## 3. 监控源配置模型

`ProjectWebWatchConfig` 新增可选字段（旧配置无此字段 → 读为空数组，不写盘）：

```ts
/** 一条结构化监控源：绑定 agent-reach 的某个渠道动作。 */
export interface ProjectWebWatchSource {
  id: string                    // randomUUID
  /** 一期白名单：github | bilibili | v2ex | web */
  channel: 'github' | 'bilibili' | 'v2ex' | 'web'
  /** 该渠道的动作名，一期白名单见 §4 */
  action: string
  /** 动作参数（query / node_name / limit 等），保存前按渠道模板校验 */
  params: Record<string, string | number>
  /** 用户可读的备注名，面板展示用 */
  label: string
  enabled: boolean
  addedAt: number
}

export interface ProjectWebWatchConfig {
  // ……既有字段不变……
  sources?: ProjectWebWatchSource[]
}
```

约束：

- `sources` 上限 10 条（`MAX_SOURCES_PER_PROJECT`）；`topics` 上限 8 不变。
- 启用扫描时 `topics` 与 `sources` 至少其一非空（放宽现有「必须填主题」校验，
  有监控源即可）。
- `saveProjectWebWatchConfig` 按渠道模板校验 `channel/action/params` 三元组，
  非法组合直接拒绝（对应 CLI 的 `BAD_INPUT`，前置到保存时）。
- 存储不变：`~/.gravitas/projects/web-watch/{projectId}.json`；runs 仍是
  `{projectId}.jsonl`，90 条轮转不变。

## 4. 一期渠道范围与监控源模板

面板以「模板」降低配置门槛，每个模板映射到一条 CLI 调用：

| 模板 | channel | action | params | CLI 等价 |
|---|---|---|---|---|
| GitHub 关键词搜仓库 | github | search | `query`, `limit≤10` | `agent-reach github search "<q>" --limit N` |
| GitHub 仓库/议题速览 | github | read | `target`(owner/repo 或链接) | `agent-reach github read <target>` |
| B站关键词新投稿 | bilibili | search | `query`, `limit≤10` | `agent-reach bilibili search "<q>" --limit N` |
| B站热门 | bilibili | hot | `limit≤10` | `agent-reach bilibili hot --limit N` |
| V2EX 节点新帖 | v2ex | node | `node_name`, `limit≤10` | `agent-reach v2ex node <node> --limit N` |
| V2EX 热议 | v2ex | hot | `limit≤10` | `agent-reach v2ex hot --limit N` |

说明：

- `read` 类模板一期只做「采集快照进判断」，不做页面级 diff；`github read` 的
  变化检测依赖现有 snippet 版本比较（见 §6）。
- `bilibili subtitle`、`web read`、登录渠道（xiaohongshu / xueqiu / boss /
  linkedin / reddit）与实验渠道（twitter / facebook / instagram）不进一期。
- `web search` 不接：与 topics 的 searchWebResults 重叠，避免同一查询双通道放大噪音。

## 5. 错误码 → 扫描策略映射

CLI envelope 的 `error.code` 翻译为扫描行为（全部记录进 run 的 `sourceErrors`，
单源失败不改变整轮状态）：

| error.code | 扫描策略 | 面板表现 |
|---|---|---|
| `NEED_SETUP` | 该渠道全部源跳过；本轮其余渠道照常 | 渠道徽标「未安装/缺依赖」，附 CLI hint |
| `NEED_LOGIN` | 一期不应出现（白名单不含登录渠道）；出现时该渠道标记不可用 | 「需要登录」+ 引导文案（二期接登录流） |
| `RATE_LIMITED` | 该源跳过，按 `retry_after_seconds` 记 `nextRetryAt`，到期前不再请求 | 源行显示「限流中，HH:mm 后恢复」 |
| `PLATFORM_BLOCKED` | 该渠道当日全部源跳过 | 渠道徽标「平台风控」，提示用户到官方页面处理 |
| `BUSY` | 该源跳过，本轮不重试 | 不提示（瞬时状态） |
| `TIMEOUT` | 该源跳过 | 运行历史里记一条 |
| `UPSTREAM_BROKEN` | 该源跳过（public-web 降级由 CLI 内部完成，外层不重复） | 运行历史里记一条 |
| `NOT_FOUND` / `BAD_INPUT` | 视为配置错误，该源跳过 | 源行标红，提示用户修正参数 |

整轮状态判定：所有采集路径（topics 搜索 + 全部源）都失败 → `failed`；部分失败
→ `success` 且 `sourceErrors` 非空；预算耗尽 → `skipped`（不变）。

## 6. 采集执行层

新文件 `apps/electron/src/main/lib/project-web-watch-agent-reach.ts`，对外只暴露
一个函数：

```ts
collectAgentReachSources(
  sources: ProjectWebWatchSource[],
  options: { timeoutPerSourceMs?: number },
): Promise<{ items: WatchSourceItem[]; errors: SourceError[] }>
```

要点：

- **CLI 探测**：启动时经 shell 环境解析 `agent-reach` 路径（复用 `shell-env.ts`
  的 PATH 修复），跑 `agent-reach version` 验证 JSON 输出；结果缓存到进程内，
  失败 5 分钟内不重试。未安装 → 全部源跳过，记一次 `NEED_SETUP`，topics 搜索
  不受影响（优雅降级）。
- **执行**：`spawn` CLI，拼接 `<channel> <action> --<param> <value>`；逐源串行
  （CLI 内部已有排队与节奏控制，外层不需要并发）；每源超时 45s，kill 后按
  `TIMEOUT` 记。单项目一轮最坏耗时 = 源数 × 45s，源数上限 10 保证有界。
- **输出解析**：读 stdout 一行 JSON，校验 `ok` 与 `items` 结构；解析失败按
  `UPSTREAM_BROKEN` 记，不把原始输出带进错误消息（可能含页面文本）。
- **Item 映射**：`{ title, url, snippet: text.slice(0,500), publishedAt, origin }`。
  `published_at` 非法时丢弃该字段。

`WatchSourceItem`（替换 run.sources/newSources 的元素类型，超集兼容）：

```ts
export interface WatchSourceItem extends WebSearchResultItem {
  /** 采集来源；缺省视为 websearch（旧记录兼容，读路径不迁移）。 */
  origin?: { type: 'websearch' } | { type: 'agent-reach'; channel: string; action: string; backend?: string }
}
```

`ProjectWebWatchRun` 新增可选字段：

```ts
/** 单源失败明细；空或缺省 = 全部成功或该轮无监控源。 */
sourceErrors?: Array<{ sourceId: string; channel: string; code: string; message: string }>
```

## 7. 去重与历史兼容

- 现有去重：`Map<url, item>` + `knownVersions`（url → snippet）比较。Agent-Reach
  的 `url` 直接进同一套逻辑，无需改动。
- 同一 URL 被两条路径命中：保留 agent-reach 版本（结构化更干净），`origin`
  标双来源无必要，只记 agent-reach。
- 历史 run 的 `sources` 元素无 `origin` 字段：读路径按 `websearch` 处理，不迁移、
  不回写。
- `publishedAt` 参与判断提示词的来源时间展示；agent-reach 渠道多数能给出真实
  发布时间，对 coverage 窗口（`coverageFrom` 起）内的增量判断质量有提升——
  这是接入的隐性收益，写进验收点。

## 8. 调度与预算边界

- 调度器、due 判断、补扫逻辑完全不变。
- **预算边界（显式声明）**：agent-reach 采集不消耗 LLM 额度，只消耗目标平台的
  访问配额（由 CLI 自己的限流纪律管理）。因此预算门禁保持现状——只挡
  searchWebResults + LLM 判断这条链。这一点写进面板文案，避免用户以为
  「预算耗尽 = 一切外部访问都停」。
- Dev 模式默认跳过自动调度的既有行为不变。

## 9. UI 变更（项目面板外网扫描设置）

- 现有「扫描主题」区块保持不变。
- 新增「监控源」区块：源列表卡片（渠道图标 + label + 状态徽标 + 启停开关 +
  删除），「添加监控源」按钮打开模板选择 → 参数表单（按 §4 模板生成）。
- 渠道状态徽标来自进程内缓存的探测结果（未安装 / 限流中 / 正常 / 需要登录），
  不在渲染进程直接调 CLI。
- 运行历史条目里，来源列表按 `origin` 显示渠道标签；`sourceErrors` 展示为
  可折叠的「本次部分源未成功」。

IPC：复用 `PROJECT_IPC_CHANNELS.SAVE_WEB_WATCH`，给现有 `saveWebWatch` 入参加可选
`sources` 字段而非新增通道——保存是同一个原子写操作，两条路径会互相覆盖；
`sources` 缺省时保留现有监控源，旧调用方不会静默清空。主进程处理器本就透传
`Parameters<typeof saveProjectWebWatchConfig>[0]`，主进程侧零改动。

## 10. 分期实施

- **P1（本设计落地）**：配置模型 + 采集层 + §4 六个免登录模板 + 错误映射 +
  面板基础 UI + 契约测试。
- **P2**：登录渠道（xiaohongshu / xueqiu）+ `NEED_LOGIN` 面板引导流
  （`agent-reach login <channel>` 打开窗口由用户本人登录）。
- **P3**：`read` 类定点监控升级（页面内容版本检测、GitHub release 专项模板）。

## 11. 明确不做

- 不做全域 WebFetch 降级链、不在 Chat 模式挂载 agent-reach 工具。
- 不动 LLM 观察判断、观察投递、通知、反馈链路。
- 不把 CLI 装进安装包：依赖用户本机已装 Agent-Reach，面板给安装引导
  （与 default-skills/agent-reach 的「安装检查」段落一致）。
- 不在主进程实现任何渠道逻辑；渠道增减跟着上游 CLI 版本走。

## 12. 测试计划（BDD）

- **CLI 契约测试**：mock spawn 输出各错误码 envelope → 断言 §5 的映射行为
  （跳过范围、nextRetryAt、整轮状态）。
- **映射单测**：items → WatchSourceItem（字段截断、published_at 非法、origin 标注）。
- **配置兼容**：无 `sources` 字段的旧配置读出为默认；非法 channel/action/params
  在保存时被拒。
- **整轮行为**：部分源失败时 run 记 `success` 且 `sourceErrors` 正确；全部路径
  失败才记 `failed`；CLI 未安装时 topics 搜索照常。
- **打包烟测**：`package-smoke.ts` 不需要改（不涉及 default-skills 内容变更）。
