# 前端 + IPC 代码安全/质量复审报告

- **审查时间**：2026-08-08
- **审查范围**：2026-08-06 ~ 08-08 agentic-os PH1/PH2·A-F 批次中前端与 IPC 相关改动
- **审查方式**：只读（Read / Grep / git log + git diff），未修改任何文件
- **审查对象**：preload、ProjectView、团队四面板（Mailbox/FileEvent/TodoEvent/AgentTeam）、ExtensionSettings、CostAuditPanel、CredentialHealthPanel，以及相关主进程 handler/数据层（work-module-ipc-handlers、project-sqlite-store、plugin-manager）

---

## 总体结论

**未发现可利用的 XSS / 直接 SQL 注入 / 未授权越权写入路径。** 主要原因：

- `contextIsolation: true / sandbox: true / nodeIntegration: false` 在所有窗口（主窗、quick-task、voice-dictation、detached-preview、web-bridge、screenshot）均已配置。
- 所有目标面板（含 ExtensionSettings 插件列表、团队四面板、两个 automation 面板）**全部使用 JSX 插值渲染，无处 `dangerouslySetInnerHTML`、`innerHTML`、`eval`、`new Function`、`document.write`**。任务/成员/插件名称等不可信文本均被 React 自动转义。
- `project-sqlite-store.ts` 中 sql.js 的 `StmtCompat.get/all/run` 全部使用 `?` 占位符参数绑定，动态值（task 标题、memberId、manifest 字段等）均经 bind 传入，`conditions.join(' AND ')` 只拼接固定片段，**无用户可控 SQL 片段拼接**。
- `readColumnNames` 里 `${table}` 插值仅内部 migrate 用硬编码表名，无注入面。
- 未发现 `window.open`/`href=`/`linkTo` 接收不可信 URL 的路径；Mailbox 打开会话走 `openSession`（Jotai 状态更新），无协议/XSS 注入。

**主要遗留风险集中在「IPC 入参运行时类型/结构校验缺失」与「轮询无 in-flight 防护的竞态」两大类，严重度多为 Low-Medium（健壮性/防御性缺陷，本地单用户场景下可利用性低）。**

---

## 逐文件漏洞清单（按严重程度排序）

### 1. apps/electron/src/main/lib/plugin-manager.ts — 第三方 manifest 校验过弱

- **严重程度**：Medium（设计性风险，当前内存化存储限制了实际危害）
- **函数**：`registerPlugin()` / `importPluginFromManifest()`（约 135 行）
- **问题**：
  - 导入 IPC（`ipc.ts:3872` 直接 `importPluginFromManifest(manifest)`）→ `registerPlugin` 仅校验 `manifest.id`、`manifest.name` 为真值，**未校验类型、长度、id 字符集、`surfaces`/`subscriptions`/`permissions`/`entrypoints` 结构**。
  - 恶意/畸形 manifest 可携带任意结构字段进入 `IMPORTED_RUNTIMES`，此后 `runtimeToView` 会把 `permissions`、`surfaces` 原样透出渲染（渲染转义安全，但结构无上限）。若未来 PH2 启用 `entrypoints` 执行能力（当前未执行，见代码），将成为第三方代码注入面。
  - `importPluginFromManifest(null)` 无空值 guard，会走到 `registerPlugin` 的 `manifest.id` 抛 TypeError，返回未处理 rejection（不崩主进程，但属健壮性隐患）。
- **修复建议**：
  - 对 manifest 做白名单校验：`id` 必须为字符串且匹配 `/^[a-zA-Z0-9._-]{1,128}$/`；`name/version/publisher` 必须为字符串且限长；`surfaces`/`subscriptions` 逐一校验为已知枚举；`permissions` 只接受布尔键。
  - `importPluginFromManifest` 入口加 `typeof manifest === 'object' && !Array.isArray(manifest)` 守卫。
  - 明确约定：在 `entrypoints` 真正被加载执行前，必须叠加 manifest 结构白名单 + 沙箱/权限门（与 PH2-D 审批门一致的收敛）。

### 2. apps/electron/src/main/lib/work-module-ipc-handlers.ts — IPC 入参缺少运行时类型校验

- **严重程度**：Medium（健壮性 / 防御性；会随调用在 sql.js bind、`.toLowerCase`、`.startsWith` 处抛异常）
- **函数**：`PROJECT_IPC_CHANNELS.*` 与 `AGENT_EMPLOYEE_IPC_CHANNELS.*` 系列 handler（约 272-760 行）
- **问题**：
  - contextBridge + `ipcRenderer.invoke` 会序列化参数，**Symbol/Function 无法跨越边界**（这部分安全），但**对象/数组/布尔等「非期望类型」可以**原样抵达主进程。
  - 所有 handler 都以 `(_, id: string, patch)` 的 TypeScript 标注为准，但**无运行时 `typeof id === 'string'` 校验**。若渲染端（或被改动的本地页面）传入 `{...}` 或数组作为 `id`，会直接流入 `project-sqlite-store.ts` 的 `prepare(sql).get(id)` → `StmtCompat.get(...)` → `statement.bind([object])`，sql.js 抛 `Wrong API use: bind unknown value type`，该次调用 rejection，不崩主进程。
  - `importMeetingNoteAndExtractTasks`、`importDingTalkDocAndExtractTasks`、`FETCH_DINGTALK_DOC` 直接消费来自钉钉/网络 + LLM 提取的内容，其中 `\`创建任务「${input.title}」\`` 等只进 summary/activity，未直接拼接 SQL，安全；但 title 未做长度/类型校验。
- **修复建议**：
  - 在 handler 边界做轻量 `guard`:对 `id/taskId/projectId` 类参数断言 `typeof === 'string' && length <= N`；对 `input/patch` 断言为普通对象（`typeof === 'object' && !Array.isArray`）。
  - 在 `StmtCompat.get/all/run` 内对绑定参数做 `typeof` 白名单（string/number/null/undefined），遇到其他类型直接抛业务异常，避免 sql.js 底层 JSON 化后混淆错误信息。

### 3. apps/electron/src/main/lib/project-sqlite-store.ts — CREATE_TASK_DEPENDENCY 的 `type` 自由字符串

- **严重程度**：Low
- **函数**：`createTaskDependency(taskId, dependsOnTaskId, type)`（约 1003 行）/ handler 538 行
- **问题**：`type` 走 bind 参数（无 SQL 注入），但**未约束为已知枚举**（`TaskDependencyType`），可存入任意字符串；与 2 同源，缺类型守卫。
- **修复建议**：对 `type` 做枚举白名单校验；对 `dependsOnTaskId` 校验为有效 task id 且非自身（防自环依赖）。

### 4. apps/electron/src/renderer/components/projects/ProjectView.tsx — 项目详情双重触发刷新/轮询竞态

- **严重程度**：Low（状态一致性，非安全）
- **函数**：`ProjectDetail` 中 `useEffect`（约 804 行，`fd476ca2` 新增 5min 兜底轮询）
- **问题**：
  - `onProjectActivityChanged` 订阅 + `window.setInterval(loadData, 5min)` 两条路径都直接 `void loadData()`，**无 in-flight 去重/防重入**。慢查询时可能并发触发两次 `loadData`，导致看板/任务列表短暂闪烁或旧的慢响应覆盖新的快响应（stale clobber）。
  - 6s 兜底轮询（`7a38844b`）额外加重同视图刷新频率，与本 5min 轮询语义有重叠但方向一致，属于「双保险」设计；可接受，但建议合并为受控方式。
- **修复建议**：为 `loadData` 加 `useRef` 的 in-flight 保护（或 AbortController / 递增 seq 忽略过期响应）；轮询与订阅 refresh 用同一个带防抖的调度入口。

### 5. 团队三面板 — setInterval 轮询无 in-flight 防护 + limit/slice 冗余

- **严重程度**：Low（状态一致性 / 轻微资源浪费）
- **函数**：
  - `MailboxPanel.load`（5s setInterval，`c3911c26`/PH2-C）
  - `FileEventPanel.load`、`TodoEventPanel.load`（挂载时单次，无轮询，较安全）
  - `AgentTeamPanel`（无自动轮询，手动刷新）
- **问题**：
  - Mailbox 面板 5s 轮询直接 `setInterval(() => void load(), 5000)`，未在上一次请求未完成时跳过，慢请求下可能重叠覆盖 `items` 状态。
  - `FileEventPanel`/`TodoEventPanel` 取 `{limit:100}`再 `slice(0,50)`，limit 与展示上限不一致，属资源冗余（轻微）。
- **修复建议**：轮询 tick 内先判断 `loadingRef` 或加最小间隔去重；统一后端已 limit 不必再 slice(0,50)（或前端直接依赖 limit）。

### 6. apps/electron/src/renderer/components/settings/ExtensionSettings.tsx — 导入 toast / 状态合并细节

- **严重程度**：Low
- **函数**：`handleImport`、`handleToggle`、`handleDelete`、`load`
- **问题**：
  - 插件名/描述直接 JSX 插值渲染（已被转义，安全）；**无 `dangerouslySetInnerHTML`**（已确认）。
  - 但 `window.electronAPI.importPlugin(manifest)` 直接把解析后的任意 JSON 透传主进程——结合插件导入的宽松校验（见 #1），单凭渲染转义无法兜底未来 `entrypoints` 执行能力，需在主进程收紧 manifest 白名单。
  - `handleToggle` 用 `setPlugins(prev => prev.map(...{ ...updated as PluginStateView }))`，若主进程 `setPluginEnabled` 返回 `null` 则 `updated` 为 null，`{...null}` 展开为 `{}` 会把该条目覆盖为空对象 → 列表项坍塌。但调用处已先判 `if(updated)`，故实际不会进入分支，属防御性冗余（提示符级）。
- **修复建议**：把 manifest 白名单校验前移到主进程（同 #1）；`handleToggle` 增加 `if(!updated || typeof updated !== 'object') return` 类型守卫。

### 安全过关项（确认无问题）

- **preload/index.ts**：全部 IPC 仅作参数转发，`contextIsolation/sandbox` 保证 Symbol/Function 无法跨边界；未发现被泄露可调用系统能力的外部访问面（仅通过 `window.electronAPI` 白名单桥接）。新增的 `listAgentWorkspaces`、`paa.project.*`、`paa.agentEmployees.*` 均走白名单通道。
- **XSS**：8 个目标文件全文无 `dangerouslySetInnerHTML/innerHTML/eval/new Function`。
- **AgentTeamPanel / CostAuditPanel / CredentialHealthPanel**：成员名、员工名、审计告警、凭据 label 全部 JSX 转义渲染；`confirm()` 原生；无 URL 注入；凭据面板不显示明文密钥。
- **SQL 注入**：`StmtCompat` 全参数化绑定；`updateTask/createTask` 等所有动态值均走 `?` 占位符。

---

## 建议优先修复顺序

1. **(P1)** plugin-manager manifest 白名单校验 + import null 守卫（堵未来第三方代码执行入口）。
2. **(P1)** IPC handler 边界统一加 `typeof` 字符串/普通对象守卫（防止对象/数组流入 sql.js bind 抛错、提高可诊断性）。
3. **(P2)** ProjectView 数据刷新加 in-flight 去重，梳理 6s 与 5min 双轮询语义。
4. **(P2)** Mailbox 轮询加 in-flight 防护；FileEvent/Todo 统一 limit 语义。
5. **(P3)** createTaskDependency 的 type/自环校验。
