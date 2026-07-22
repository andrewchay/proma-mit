# 安全与稳定性审查修复计划（2026-07）

> 创建时间：2026-07-17
> 状态：待执行（修复时逐项勾选，并同步更新本文档状态）
> 范围：全仓安全审查 + 主进程健壮性 + 渲染进程性能 + 构建/CI 配置四个方向发现的 17 项问题
> 基线：审查时 typecheck ✅ / bun test 107 pass ✅ / biome lint ✅，所有问题均为深层逻辑/配置问题，非表面错误

## 1. 背景

2026-07-17 对全仓做了一次系统性审查（四路并行：安全面 / 主进程缺陷模式 / 渲染进程状态与性能 / 依赖与构建配置），发现的问题按"波次"组织修复。

**系统性根因**：大部分高危问题源于同一模式 —— **防护策略不一致**。同一文件里 A 路径做对了、B 路径忘了（finally 用 generation 精确匹配而 catch 用存在性检查；fork/rewind 有活跃检查而 delete 没有；agent-service 处处 isDestroyed 而 chat-service 一处没有；索引文件有原子写而 JSONL 消息体没有）。修复时应注意成对检查同类路径，而非只修单点。

## 2. 修复总览

| 波次 | 主题 | 项数 | 预估 |
|------|------|------|------|
| 第一波 | 安全止血 | 4 项 | 1-2 天 |
| 第二波 | 数据安全与并发 | 4 项 | 2-3 天 |
| 第三波 | 发布可信度 | 3 项 | 1 天 |
| 第四波 | 性能与体验回归 | 3 项 | 1-2 天 |
| 第五波 | 结构性减负（长期） | 3 项 | 按需 |

每项修复完成后需运行：`bun run typecheck && bun test && bun run lint`。
涉及打包配置的修复需额外验证：`CSC_IDENTITY_AUTO_DISCOVERY=false bun run dist:fast` 后用真实产物测试。

---

## 3. 第一波：安全止血

### FIX-01 【高】safe 权限模式在 Claude SDK 路径完全失效

- **位置**：`apps/electron/src/main/lib/agent-orchestrator.ts:1741-1778`
- **问题**：`canUseTool` 的 switch 只处理 `bypassPermissions` / `plan` / `auto`，`safe` 落入 `default` 分支被**无条件 allow**。用户选"安全模式" + Claude 渠道后，Agent 可自由执行任意 Bash/Write，与 UI 承诺（`packages/shared/src/types/agent.ts:1166-1170` "只放行只读工具与命令，默认拒绝写操作"）完全相反。provider-agnostic 路径（`adapters/provider-agnostic-agent-adapter.ts:437-465`）有 safe 兜底，证明 SDK 路径是疏漏。
- **修复方案**：
  1. 在 switch 中增加 `case 'safe':` 分支，拒绝所有写工具（Write/Edit/NotebookEdit）与 Bash 非只读命令，允许只读工具。可参考 plan 分支结构 + `isBashCommandReadOnly()`，或复用 provider-agnostic adapter 437-465 行的判定逻辑（注意两边语义对齐）。
  2. 同步修正同文件 1799-1800 行过期注释（"canUseTool 已完整处理所有权限模式（plan/auto/bypassPermissions）" 列举缺 safe）。
  3. 检查 `agent-permission-service.ts:140-152`：`isWhitelisted()` 命中即放行位于 safe 检查**之前**，导致"始终允许"过的工具在 safe 模式下依然放行。将会话白名单判断移到 safe 拒绝之后（safe 模式不应尊重历史白名单）。
  4. 检查子代理路径：`agent-orchestrator.ts:766-767`（provider-agnostic 子代理硬编码 bypassPermissions）与 `agent-permission-service.ts:135-138`（SDK Worker `if (options.agentID) return allow()`）—— 确认子代理权限是产品决策还是疏漏，至少在文档/注释中明确语义。
- **验证**：单元测试覆盖四种模式 × 读/写工具的判定矩阵；手动用 Claude 渠道 + safe 模式让 Agent 执行 `Write`，应被拒绝。

### FIX-02 【高】外部 IM 桥接以 bypassPermissions 执行消息，无发送者白名单

- **位置**：`apps/electron/src/main/lib/feishu-bridge.ts:1230`、`bridge-command-handler.ts:617`（钉钉 `dingtalk-bridge.ts:124`、微信 `wechat-bridge.ts:393` 复用同一 handler）
- **问题**：所有桥接消息 `permissionModeOverride: 'bypassPermissions'` 免审批执行，仅过滤 `sender_type === 'user'`，**任何群成员**发消息即可驱动 Agent 在用户机器执行任意命令。群聊还注入群历史与成员列表（`feishu-bridge.ts:1176-1207`），扩大间接提示注入面。全库无 `allowedUsers` 机制。
- **修复方案**（需产品决策，先与 owner 确认方向）：
  1. **最小改动**：桥接会话默认 `permissionModeOverride` 改为 `'auto'`（只读自动放行、写操作走权限服务），bypass 仅对显式配置的可信发送者开放。
  2. **完整方案**：桥接配置增加发送者白名单（飞书 open_id / 钉钉 userId / 微信 wxid），非白名单消息只读响应或忽略。
  3. 群聊历史注入的内容用明确边界标记包裹（如 `<untrusted-group-context>`），并在 prompt 中声明不可信。
- **验证**：模拟群成员消息触发 Agent 写操作，应进入权限审批流而非直接执行。

### FIX-03 【高】附件服务路径穿越（任意文件读写删）

- **位置**：`apps/electron/src/main/lib/config-paths.ts:147-149`（`resolveAttachmentPath` 无 `..` 校验）；暴露面 `ipc.ts:843-848`（READ_ATTACHMENT）、`ipc.ts:920-925`（DELETE_ATTACHMENT）、`ipc.ts:835-840`（SAVE_ATTACHMENT 的 conversationId 穿越）、`ipc.ts:936-941`（EXTRACT_ATTACHMENT_TEXT）
- **问题**：`join(getAttachmentsDir(), localPath)` 直接拼接，`'../../channels.json'` 可逃逸。绝对路径分支校验也有弱点（`attachment-service.ts:159-166`：`startsWith(configDir)` 无尾部 sep 可被 `.proma-evil` 绕过，且无 realpath 解析符号链接）。
- **修复方案**：
  1. `resolveAttachmentPath` 改为：normalize → 拒绝绝对路径与含 `..` 的相对路径 → resolve 后校验 `startsWith(attachmentsDir + sep)` → realpath 二次校验（防符号链接）。
  2. 绝对路径分支同样补尾部 sep + realpath（对齐 `ipc.ts:268-348` 的 `isPathAllowed` 现有实现，可直接复用该工具函数）。
  3. SAVE_ATTACHMENT 的 `conversationId` 参数校验为 UUID 格式。
- **验证**：单元测试构造 `../../`、绝对路径、符号链接三类 payload 全部拒绝；正常附件读写回归。

### FIX-04 【高】TEST_MCP_SERVER 命令注入 + Bash 只读判定绕过

- **位置 A**：`apps/electron/src/main/ipc.ts:1476-1486` → `mcp-validator.ts:113`（`execSync(\`${whichCommand} ${command}\`)` 拼接渲染进程输入）
- **位置 B**：`packages/shared/src/constants/permission-rules.ts:22-48`（`hasDangerousStructure` 不检测 `\n`，`"ls\nrm -rf ~"` 在 auto 模式被误判只读放行；`git branch -D` / `git remote set-url` 命中只读白名单；`head`/`grep` 可读 `~/.ssh/id_rsa` 送入 LLM 上下文）
- **修复方案**：
  1. A：`execSync` 改 `execFileSync(whichCommand, [command])` 数组参数形式，消除 shell 拼接。
  2. B-1：`hasDangerousStructure` 增加 `/[\n\r]/` 检测。
  3. B-2：git 白名单收紧 —— `branch`/`tag`/`remote` 带子命令判定（只允许无参列表形式），或直接移出白名单。
  4. B-3：`isDangerousCommand` 的 `startsWith` 改为 basename 归一化后比较（`env rm`、`/bin/rm` 当前可绕过 ⚠️ 标记，仅影响 UI 提示，顺带修）。
  5. B-4（可选，产品决策）：`head`/`tail`/`grep`/`env` 是否留在只读白名单 —— 与 `cat` 被排除的理由（"可读取敏感文件"）存在自相矛盾，建议统一标准。
- **验证**：单元测试覆盖换行注入、git 写子命令、`env rm` 三个 payload。

---

## 4. 第二波：数据安全与并发

### FIX-05 【高】JSONL 单行损坏 → 整个会话历史静默消失

- **位置**：`apps/electron/src/main/lib/agent-session-manager.ts:172`、`conversation-manager.ts:120,151,157`（主读取路径 `lines.map(JSON.parse)` 一行坏全抛，catch 返回 `[]`）
- **问题**：JSONL 追加写在崩溃/断电时产生末尾半行是经典问题，当前后果是整个会话"失忆"（UI 空白 + 上下文回填丢失全部历史）。同项目的搜索路径（`conversation-manager.ts:457-461`、`agent-session-manager.ts:1031-1034`）已有逐行 try/catch，主读取路径反而最脆弱。
- **修复方案**：
  1. 主读取路径改逐行 try/catch，跳过坏行并 `console.warn` 记录行号（对齐搜索路径实现）。
  2. 同步修全量重写非原子问题：`agent-session-manager.ts:993`（truncateSDKMessages）、`conversation-manager.ts:208`（saveConversationMessages）改用 `writeJsonFileAtomic` 同款"临时文件 + rename"模式（JSONL 是文本不是 JSON，需抽一个 `writeFileAtomic` 通用实现）。
- **验证**：测试构造末尾半行的 JSONL，读取应返回全部完好行；重写中途 kill 进程不丢原文件。

### FIX-06 【高】stop() + 立即重发竞态：旧 run 复活并发写同一 JSONL

- **位置**：`apps/electron/src/main/lib/agent-orchestrator.ts:2212`（catch 块存在性检查）、`:1943`（重试等待后存在性检查）；对照 finally 块 `:2407` 用 generation 精确匹配
- **问题**：stop() 删槽位 → 立即重发 → 新 run 占位 → 旧 run abort 错误在 2212 检查为 false → 被当普通错误分类。最坏情况：abort 错误文本匹配 `TRANSIENT_NETWORK_PATTERN` → 旧 run 重试 → **两个并发 SDK query 写同一会话 JSONL**。一般情况：旧 run 把"执行错误"写进新 run 历史并向渲染进程发 onError/onComplete。
- **修复方案**：
  1. 2212、1943 两处改为 generation 比较：`this.activeSessions.get(sessionId) === runGeneration`（对齐 2407）。
  2. 顺带加固：`runGeneration = Date.now()`（`:1325,1367`）改为自增计数器或 `randomUUID()`，消除毫秒碰撞。
  3. `stoppedBySessions` 标记在竞态下残留（`:508,2213,2428`），run 结束时无条件清理。
- **验证**：测试模拟 stop 后 10ms 内重发，断言旧 run 不再写入任何消息/事件。

### FIX-07 【高】DELETE_SESSION 不停止、不检查运行中的会话

- **位置**：`apps/electron/src/main/ipc.ts:1281-1293`（无 `isAgentSessionActive` 检查、无 stopAgent）；`agent-session-manager.ts:414` 同样无检查；渲染进程 `LeftSidebar.tsx:652` 直接调删除
- **问题**：删除运行中会话 → SDK 子进程在已 `rmSync` 的目录下继续执行 → 后续 `appendSDKMessages` 重建幽灵 JSONL（索引中已无此会话）。fork/rewind（`agent-orchestrator.ts:2464,2487`）都有活跃检查，唯独 delete 遗漏。
- **修复方案**：DELETE_SESSION 处理器开头：若 `isAgentSessionActive(id)` → 先 `stopAgent(id)` 等待 run 退出（或拒绝删除并返回错误码让 UI 提示"会话运行中"）。渲染进程侧对应处理。
- **验证**：测试运行中删除会话，无幽灵文件重建。

### FIX-08 【中】迁移导入：无备份、无回滚、非原子写

- **位置**：`apps/electron/src/main/lib/migration-service.ts`
  - `_importSessions` :938/:980、`_importChannels` :1047、`_importChatTools` :1070、`_importWorkspaceConfig` :1113 —— 裸 `writeFileSync` 覆盖索引/配置（channels.json 还含 API Key）
  - `confirmImport` :785-837 —— 无回滚，中途失败即部分导入不一致
  - `_importSkills` :991-995 —— overwrite 先 `rmSync` 再 `cpSync`，cpSync 失败用户原 Skill 永久丢失
  - `_importChannels` :1035-1036 —— safeStorage 不可用时明文落盘 API Key（静默降级）
  - 对照：`_importPersonalFiles` :1125 有 `.backup-{ts}` —— 策略不一致的证据
- **修复方案**：
  1. 所有索引/配置写入统一走 `writeJsonFileAtomic`。
  2. `confirmImport` 开头对将被覆盖的目标做整体 `.backup-{ts}`，任一步骤失败从备份回滚。
  3. `_importSkills` 改为"复制到临时名 → rename 替换"。
  4. safeStorage 不可用时在导入结果中显式警告用户（UI 提示），而非静默明文。
- **验证**：测试模拟导入中途失败，原数据完整恢复。

---

## 5. 第三波：发布可信度

### FIX-09 【高】CI mac 重试循环吞掉失败退出码

- **位置**：`.github/workflows/release.yml:80-85` 与 `:143-148`
- **问题**：`for i in 1 2 3; do npx electron-builder ... && break; echo ...; sleep 10; done` —— 3 次全失败时循环体最后是 `sleep`，退出码 0，**打包全挂也显示绿勾**。
- **修复方案**：改为 `npx electron-builder ... && break || { [ "$i" = "3" ] && exit 1; sleep 10; }`。
- **验证**：审查 diff 确认逻辑；下次发布观察。

### FIX-10 【高】pdf-parse 在打包产物中必坏

- **位置**：`apps/electron/src/main/lib/document-parser.ts:103`（`await import('pdf-parse')`）；`node_modules/pdf-parse/index.js:6-15` debug 块（`isDebugMode = !module.parent`）被 esbuild 原样打包进 `dist/main.cjs:283700`，wrapper 无 `module.parent` → 模块求值即 `readFileSync('./test/data/05-versions-space.pdf')` 抛 ENOENT
- **问题**：发布版 PDF 附件文本提取 100% 失败。
- **修复方案**（三选一，推荐 a）：
  a. 改导入子路径 `await import('pdf-parse/lib/pdf-parse.js')`（绕过 index.js 的 debug 块，改动 1 行）；
  b. 换用项目已内置的 `pdfjs-dist`（`file-preview-service.ts` 已在用），彻底移除 pdf-parse 依赖；
  c. pdf-parse 标记 external 并加入 electron-builder files（多背一个废弃包，不推荐）。
- **验证**：`bun run dist:fast` 打包后用真实产物上传 PDF 附件测试文本提取。

### FIX-11 【中】CI 无质量门禁 + 文档腐化止血

- **位置**：`.github/workflows/release.yml`
- **修复方案**：
  1. release.yml 增加前置 job 或步骤：`bun run typecheck && bun test && bun run lint`，失败阻断发布。
  2. 增加 tag ↔ `apps/electron/package.json` version 一致性校验（防止推 v0.9.61 而 package.json 还是 0.9.60）。
  3. 增加 `timeout-minutes`（建议 60-90），防 mac 公证卡死跑满 6 小时。
  4. 同步修正文档腐化（执行本波次时一并更新）：
     - `AGENTS.md`：shared 版本 0.1.15→实际 0.1.27、ui 0.1.3→0.1.4、electron 0.9.58→0.9.60；删除"shared 导出 `./constants/permission-rules` 子路径"的不实描述（实际从根导出）；删除"@proma/ui 依赖 Radix UI"的不实描述；补充 `@/types/*` 路径别名。
     - `agent-orchestrator.ts:213` 过期注释（"即便 Proma 当前 `asar: false`"，实际 asar: true）。
     - release-notes 落后 19 个版本（v0.9.41 vs 0.9.60）—— 至少补一个汇总说明或建立发版时同步的规矩。
     - 根目录 `index.ts`（`console.log("Hello via Bun!")` 脚手架残留）建议删除。
- **验证**：推一个测试 tag 观察 CI 行为（或本地 act 验证）。

---

## 6. 第四波：性能与体验回归

### FIX-12 【高】流式完成后消息永不重载（refreshVersion 回归）

- **位置**：`apps/electron/src/renderer/components/chat/ChatView.tsx:120`（`_refreshVersion` 定义未使用，:165 加载 effect 依赖缺 refreshVersion）、`components/agent/AgentView.tsx:612-613`（同问题）
- **问题**：commit `1bc7d5c` 为消 useExhaustiveDependencies 警告删掉了依赖。设计契约是"全局监听器在流式完成/错误时递增版本号 → View 监听版本号重新加载消息 → 清理过渡流式状态"（`chat-atoms.ts:229-233`、`useGlobalAgentListeners.ts:900`）。当前后果：流式结束后持久化消息不进列表、过渡气泡不清理（复制/重试按钮不出现），只有切换对话再切回才恢复。
- **修复方案**：
  1. 把 refreshVersion 加回两个 View 加载 effect 的依赖数组（用 `// biome-ignore` 注释说明必要性，而非删变量名逃避 lint）。
  2. **复查 commit 1bc7d5c 的全部改动**，确认没有其他 effect 被同类手法破坏（如 `ChatView.tsx:123-142` "对话切换时重置状态" effect 依赖只剩 `[setPendingRecommendation]`，目前靠 `TabContent.tsx:38` 的 `key={tab.sessionId}` remount 碰巧正确，属隐式耦合，建议显式补回 conversationId 依赖或注释说明）。
- **验证**：手动测试 —— 发送消息流式完成后，消息列表立即出现持久化消息、过渡气泡消失、操作栏可用，无需切换对话。

### FIX-13 【中】派生 atom 引用不稳定 → 每个流式 token 触发侧边栏整树重渲染

- **位置**：`apps/electron/src/renderer/atoms/chat-atoms.ts:62-69`（streamingConversationIdsAtom）、`agent-atoms.ts:503-510,535-559`（agentRunningSessionIdsAtom / agentSessionIndicatorMapAtom）、`tab-atoms.ts:92-126`、`working-atoms.ts:33`
- **问题**：Jotai 用 `Object.is` 比较派生 atom 输出，这些 atom 每次重算返回新 Set/Map/对象 → 每个 chat chunk / agent 事件都通知订阅者（LeftSidebar 2032 行、TabBar）。子项有 memo 挡住，父组件 reconcile 成本仍在。
- **修复方案**：派生 atom 内做浅比较缓存（内容相同返回旧引用），或按 sessionId 用 atomFamily 切片（`agent-atoms.ts:216-223` 注释已正确阐述该模式，推广到集合型 atom）。
- **验证**：React DevTools Profiler 观察流式期间 LeftSidebar 渲染次数显著下降。

### FIX-14 【中】Agent 消息列表长会话 O(N²) + View 层订阅整个 Map

- **位置**：`components/agent/SDKMessageRenderer.tsx:1282`（MessageGroupRenderer 无 memo）、`AgentMessages.tsx:486-643`（每条 live 消息全量重分组+全量 render）、`AgentView.tsx:319`（订阅 liveMessagesMapAtom 整个 Map）、`ChatView.tsx:86`（同）
- **修复方案**：
  1. `MessageGroupRenderer` 加 `React.memo`（需配合稳定的 group 引用 —— groupIntoTurns 结果做结构共享）。
  2. View 层改为按当前 sessionId 切片的 atomFamily 订阅，后台会话流式不再重渲染当前视图。
  3. 几千条消息的虚拟滚动列为后续可选优化（当前先 memo 止血）。
- **验证**：Profiler 观察流式期间渲染范围收敛到当前 turn。

---

## 7. 第五波：结构性减负（长期，不阻塞发版）

| 项 | 内容 |
|----|------|
| REFACTOR-01 | 拆分 `agent-orchestrator.ts`（2647 行，一个 try-catch 500+ 行，thinking-signature 恢复块逐字重复两次 :2018-2040 vs :2237-2258）：按并发守卫 / 重试策略 / 消息持久化 / 标题生成 / rewind-fork 分模块 |
| REFACTOR-02 | 错误边界扩展：当前仅 `TabErrorBoundary` 覆盖 Tab 内容区，App 顶层（LeftSidebar/TabBar/SettingsDialog 区域）无边界，渲染抛错即整 app 白屏 |
| REFACTOR-03 | 清理死代码与调试残留：`unstable_batchedUpdates`（React 18 no-op，多处）、遗留 `console.log`（useGlobalAgentListeners.ts:716,792 等）、`packages/core/tsconfig.json` 不继承根配置导致严格度不一致、win32-arm64 SDK 子包死配置（target 只打 x64）、Linux 打包配置半成品（有 dist:linux 脚本无 yml linux 段） |

## 8. 本计划未覆盖但已记录的低风险项

- `migration:cancelImport` 用子串匹配递归删目录（`ipc.ts:3246`）—— 改 resolve 后校验位于 `os.tmpdir()` 下。
- `channels.json` 写入非原子、损坏静默丢全部渠道（`channel-manager.ts:54-63`）—— 对齐原子写 + .bak。
- `runAgentHeadless` 取 `BrowserWindow.getAllWindows()[0]` 可能发错窗口（`agent-service.ts:176`）—— 改按主窗口标记查找。
- MermaidBlock 的 SVG 未 DOMPurify 二次清洗（`packages/ui/src/mermaid-block/MermaidBlock.tsx:279`）—— 与项目其他渲染处策略对齐。
- MCP OAuth DeepLink 回调缺 state 校验（`mcp-oauth-pending.ts`）—— 本机应用可注入授权码，OAuth CSRF。
- chat-service 无并发守卫 + 9 处 send 无 isDestroyed 防护（`chat-service.ts:206-509`）。
- Chat 待发送附件 blob URL 在 Tab 关闭路径泄漏（`useCloseTab.tsx:111-118` 只清了 Agent 的）。
- watcher 重复启动无防护、chat-tools-watcher 无 error 自愈（`workspace-watcher.ts:50`、`chat-tools-watcher.ts:26`）。
- `fs.watch recursive` 在 Linux 不支持 → Linux 无工作区文件监听（`workspace-watcher.ts:64,152`）。
- `setInterval(runAutoArchive, 24h)` 无句柄且 bootstrap 重试会重复注册（`ipc.ts:3229`、`index.ts:586`）。
- 重试等待不可中断，stop() 最长延迟 15s 才生效（`agent-orchestrator.ts:1940`）。
- 工具 API Key 明文落盘 `~/.proma/chat-tools.json`（`chat-tool-config.ts:75`）+ DECRYPT_KEY IPC 无确认裸暴露（`ipc.ts:626`）+ safeStorage 降级仅 console.warn（多处）—— 密钥面一致性整改可单独立项。
- `TutorialViewer.tsx:89` 启用 rehypeRaw（当前内容内置可信，教程内容远程化前必须移除）。
- `Date.now()` 作 generation token 毫秒碰撞（已在 FIX-06 顺带修）。

## 9. 验收标准

每波次完成后：

1. `bun run typecheck && bun test && bun run lint` 全绿。
2. 新增/修改的逻辑有对应单元测试（项目已有 16 个测试文件的惯例，BDD 风格）。
3. 涉及安全的修复需在 PR 描述中写明攻击场景与防护方式。
4. 第三波涉及打包的项需 `bun run dist:fast` 真实产物验证。
5. 每波次完成后更新本文档状态 + 按 AGENTS.md 约定递增受影响包 patch 版本；若改动涉及 AGENTS.md 已描述的架构行为，同步更新 AGENTS.md（需 owner 确认）。
