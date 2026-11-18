# Owner 研发任务中断恢复与失败证据 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一次「规格已完成、评审已完成、研发失败」的真实 Owner 批次能从失败现场安全恢复，并把失败原因、费用、工作树状态完整暴露给用户。

**Architecture:** 在主进程新增一个不可变的「终端证据」账本（`project_owner_execution_terminal_evidence`），由 Owner 命令终态回调在同一事务里写入；恢复侧新增「混合批次接替」服务，复用既有 grant 撤权、质量验收、开发快照与应用原语，不重跑已验收步骤；研发工作区门禁从单一字符串异常升级为结构化阻塞项，并提供显式重新核对入口；渲染层把「执行阻塞」提升为与「需要你决定」同源的单一提示。

**Tech Stack:** TypeScript / Bun test / Electron 主进程 / Jotai / React / sql.js（测试）/ better-sqlite3（生产）/ Git worktree。

---

## 现状与关键事实（实现前必读）

- Owner 命令终态回调在 `apps/electron/src/main/lib/agent-employee-service.ts`：
  - `handleExecutionComplete`（约 1538 行）与 `handleExecutionError`（约 1704 行）都持有 `runtimeResult`，
    但调用 `handleOwnerCommandRunCallback`（约 1394 行）时**丢弃了 `runtimeResult`**，只传了一句拼接文案。
  - `finalizeOwnerCommandRunCallback`（约 1422 行）因此拿不到 `subtype` / `finish_reason` / `provider_request_id` /
    `provider_response_id` / `toolCallBatchIntegrity` —— 这正是「只有 `error_during_execution`、`finish_reason=other`，
    无法判断原因」的根因。
- 命令视图 `OwnerExecutionCommandView` 由 `listOwnerExecutionCommands`（`project-owner-execution-command.ts` 约 394 行）
  从 `agent_executions` 单表拼装，没有结构化终态证据。
- 恢复入口 `supersedeFailedBatch`（`project-owner-execution-start-intent.ts` 约 185 行）要求**所有**命令
  `state==='settled' && actual_cost_micros!==null && execution_status==='failed'`，混合批次必然返回 `false`，
  随后 `recoverPendingOwnerExecutionStartIntents` 把启动意图置为 `needs_attention`。
- 研发工作区门禁在 `agent-development-worktree.ts` 的 `createDevelopmentWorktree`，脏仓库直接抛
  `仓库存在未提交改动...`，没有区分已跟踪/未跟踪文件，也没有重新核对入口。
- 事实核对 `project-owner-claim-audit.ts` 只匹配「正在/已在/后台/稍后自动」等现在时说法，不覆盖
  「我将在后台重新安排」这类将来时承诺；且 `runningExecutions` 只统计 `state='running'`，不含 `queued`。
- 界面矛盾根因：`OwnerManagementConversation.tsx` 第 391 行的「暂无待你决定的事项」只在本地若干 flag 为假时渲染，
  而执行阻塞状态由兄弟组件 `ProjectOwnerExecutionConversation` 从 `ownerCommandProgressAtom` 推导，两者不共享。

## 文件结构（先定边界，再拆任务）

```
apps/electron/src/main/lib/
├── project-owner-terminal-evidence.ts        # 新增：终端证据分类 + 读写 + 脱敏（纯函数 + 仓储）
├── project-owner-mixed-batch-recovery.ts     # 新增：混合批次接替（核对/接替/关联）
├── project-owner-development-recovery.ts     # 新增：失败工作树盘点与可信快照交接
├── development-workspace-blocker.ts          # 新增：研发工作区结构化阻塞项 + 重新核对
├── project-owner-execution-command.ts        # 修改：视图挂载 terminalEvidence
├── agent-employee-service.ts                 # 修改：终态回调传 runtimeResult 并写证据
├── project-owner-execution-start-intent.ts   # 修改：接入混合批次接替
├── project-owner-claim-audit.ts              # 修改：将来时说法 + queued 事实
├── project-owner-execution-ipc.ts            # 修改：新增重新核对 IPC
└── project-sqlite-store.ts                   # 修改：新增证据/接替表

packages/shared/src/types/
├── project-owner.ts                          # 修改：OwnerTerminalEvidence / 视图字段 / 重新核对 API
└── work-module.ts                            # 修改：IPC 通道常量

apps/electron/src/renderer/components/projects/
├── OwnerExecutionTerminalEvidence.tsx        # 新增：证据展示（工作记录 + 命令面板共用）
├── OwnerExecutionBlockerNotice.tsx           # 新增：统一的执行阻塞提示（原因/影响/操作）
├── project-owner-execution-attention.ts      # 新增：跨组件共享的阻塞选择器
├── OwnerManagementConversation.tsx           # 修改：空状态与阻塞提示同源
├── ProjectOwnerExecutionConversation.tsx     # 修改：复用统一提示
└── ProjectOwnerConversationProgress.tsx      # 修改：挂载证据与重新核对入口
```

---

## Task 1: 终端证据类型与分类器（纯函数）

**Files:**
- Create: `apps/electron/src/main/lib/project-owner-terminal-evidence.ts`
- Modify: `packages/shared/src/types/project-owner.ts`（在 `OwnerExecutionCommandView` 定义之后追加类型）
- Test: `apps/electron/src/main/lib/project-owner-terminal-evidence.test.ts`

- [ ] **Step 1: 写失败测试（真实案例：`error_during_execution` + `finish_reason='other'` + 工具调用已完成 + 费用已结算）**

```ts
import { expect, test } from 'bun:test'
import { classifyOwnerTerminalEvidence } from './project-owner-terminal-evidence'

const messages = [
  { type: 'assistant', message: { content: [
    { type: 'text', text: '先读取现有页面结构。' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'index.html' } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '开始实现。' }] } },
]

test('Given Provider异常终态 When分类 Then保留原始终止原因且不把过程说明当成果', () => {
  const evidence = classifyOwnerTerminalEvidence({
    executionId: 'exec-1', commandId: 'cmd-1', role: 'executor', executionStatus: 'failed', stopped: false,
    runtimeResult: { type: 'result', subtype: 'error_during_execution', finish_reason: 'other',
      provider_request_id: 'req-abc', provider_response_id: 'resp-def', usage: { input_tokens: 0, output_tokens: 0 } },
    messages, error: 'Owner模型未完整结束（error_during_execution），过程说明不能作为成果',
    cost: { state: 'settled', actualCostMicros: 12345, requestCount: 2 }, development: null, capturedAt: 1_700_000_000_000,
  })
  expect(evidence.reason).toBe('provider_stop')
  expect(evidence.provider).toEqual({ subtype: 'error_during_execution', finishReason: 'other', requestId: 'req-abc', responseId: 'resp-def' })
  expect(evidence.tools).toEqual({ calls: 1, results: 1, lastToolName: 'Read', lastResultStatus: 'ok', incompleteBatch: true })
  expect(evidence.cost).toEqual({ state: 'settled', actualCostMicros: 12345, requestCount: 2 })
  expect(evidence.detail).not.toContain('sk-')
})

test('Given输出达到上限 When分类 Then归为output_limit而不是网络错误', () => {
  const evidence = classifyOwnerTerminalEvidence({
    executionId: 'e', commandId: 'c', role: 'executor', executionStatus: 'failed', stopped: false,
    runtimeResult: { type: 'result', subtype: 'error_during_execution', finish_reason: 'length', usage: { input_tokens: 1, output_tokens: 2 } },
    messages, error: '', cost: { state: 'unknown', actualCostMicros: null, requestCount: 1 }, development: null, capturedAt: 1,
  })
  expect(evidence.reason).toBe('output_limit')
  expect(evidence.cost.state).toBe('unknown')
})

test('Given工具批次不完整 When分类 Then优先报告未完成调用', () => {
  const evidence = classifyOwnerTerminalEvidence({
    executionId: 'e', commandId: 'c', role: 'executor', executionStatus: 'failed', stopped: false,
    runtimeResult: { type: 'result', subtype: 'success', finish_reason: 'tool-calls', usage: { input_tokens: 1, output_tokens: 2 },
      toolCallBatchIntegrity: { version: 1, complete: false, reasons: ['finish_reason:length'], unexecutedMandatory: false } },
    messages, error: '', cost: { state: 'settled', actualCostMicros: 1, requestCount: 1 }, development: null, capturedAt: 1,
  })
  expect(evidence.reason).toBe('tool_call_incomplete')
  expect(evidence.tools.incompleteBatch).toBe(true)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/electron && bun test src/main/lib/project-owner-terminal-evidence.test.ts`
Expected: FAIL — `Cannot find module './project-owner-terminal-evidence'`

- [ ] **Step 3: 在 shared 类型中定义证据结构**

在 `packages/shared/src/types/project-owner.ts` 的 `OwnerExecutionCommandView` 之后追加：

```ts
/** Owner命令终态证据：只含本地回执与脱敏摘要，不含正文、参数或凭据。 */
export interface OwnerTerminalEvidence {
  schemaVersion: 1
  executionId: string
  commandId: string
  role: 'executor' | 'reviewer'
  executionStatus: string
  /** Provider 原始终止原因；只来自 Runtime 回执。 */
  provider: { subtype: string | null; finishReason: string | null; requestId: string | null; responseId: string | null } | null
  /** 归一化原因；用于界面文案与恢复判定。 */
  reason: 'provider_stop' | 'output_limit' | 'tool_call_incomplete' | 'runtime_error' | 'stopped_by_user' | 'no_output' | 'unknown'
  /** 脱敏后的简短说明（≤300 字符）。 */
  detail: string
  tools: { calls: number; results: number; lastToolName: string | null; lastResultStatus: 'ok' | 'error' | 'missing' | null; incompleteBatch: boolean }
  cost: { state: 'settled' | 'unknown'; actualCostMicros: number | null; requestCount: number }
  /** 研发执行的工作树现场；非研发或不可核验时为 null。 */
  development: { worktreePath: string | null; baseCommit: string | null; changedFiles: string[]; untrackedFiles: string[] } | null
  capturedAt: number
}
```

并在 `OwnerExecutionCommandView` 内追加字段：

```ts
  /** 终态证据；旧命令可能没有。 */
  terminalEvidence?: OwnerTerminalEvidence
```

- [ ] **Step 4: 实现分类器**

```ts
/** Owner命令终态证据：只做本地确定性归因，不推断账单、不改授权、不重放请求。 */
import type { OwnerTerminalEvidence } from '@gravitas/shared'

interface TerminalEvidenceInput {
  executionId: string
  commandId: string
  role: 'executor' | 'reviewer'
  executionStatus: string
  stopped: boolean
  runtimeResult?: {
    subtype?: string
    finish_reason?: string
    provider_request_id?: string
    provider_response_id?: string
    toolCallBatchIntegrity?: { complete?: boolean }
  } | null
  messages: readonly unknown[]
  error: string
  cost: OwnerTerminalEvidence['cost']
  development: OwnerTerminalEvidence['development']
  capturedAt: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 与 Owner 恢复提示同口径的脱敏：不得泄漏凭据、绝对路径或正文。 */
export function sanitizeOwnerDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi, '[凭证已隐藏]')
    .replace(/(api[_-]?key|authorization|access[_-]?token)\s*[:=]\s*[^,;\s]+/gi, '$1=[已隐藏]')
    .replace(/(?:\/Users\/[^\s:]+|\/tmp\/[^\s:]+|[A-Z]:\\[^\s:]+)/g, '[本地路径]')
    .replace(/\s+/g, ' ').trim().slice(0, 300)
}

function toolStats(messages: readonly unknown[]): OwnerTerminalEvidence['tools'] {
  let calls = 0, results = 0
  let lastToolName: string | null = null
  let lastResultStatus: OwnerTerminalEvidence['tools']['lastResultStatus'] = null
  for (const item of messages) {
    const body = record(record(item)?.message)
    if (!Array.isArray(body?.content)) continue
    for (const blockValue of body.content) {
      const block = record(blockValue)
      if (block?.type === 'tool_use') { calls += 1; lastToolName = typeof block.name === 'string' ? block.name : null }
      if (block?.type === 'tool_result') { results += 1; lastResultStatus = block.is_error === true ? 'error' : 'ok' }
    }
  }
  if (calls > results) lastResultStatus = 'missing'
  return { calls, results, lastToolName, lastResultStatus, incompleteBatch: calls !== results }
}

function classify(input: TerminalEvidenceInput, tools: OwnerTerminalEvidence['tools']): OwnerTerminalEvidence['reason'] {
  if (input.stopped) return 'stopped_by_user'
  if (input.runtimeResult?.finish_reason === 'length') return 'output_limit'
  if (input.runtimeResult?.toolCallBatchIntegrity?.complete === false) return 'tool_call_incomplete'
  if (input.runtimeResult && input.runtimeResult.subtype !== 'success') return 'provider_stop'
  if (tools.incompleteBatch) return 'tool_call_incomplete'
  const hasOutput = input.messages.some(item => record(item)?.type === 'assistant')
  if (!hasOutput) return 'no_output'
  if (input.error.trim()) return 'runtime_error'
  return 'unknown'
}

export function classifyOwnerTerminalEvidence(input: TerminalEvidenceInput): OwnerTerminalEvidence {
  const tools = toolStats(input.messages)
  const result = input.runtimeResult ?? null
  return {
    schemaVersion: 1,
    executionId: input.executionId,
    commandId: input.commandId,
    role: input.role,
    executionStatus: input.executionStatus,
    provider: result ? {
      subtype: typeof result.subtype === 'string' ? result.subtype : null,
      finishReason: typeof result.finish_reason === 'string' ? result.finish_reason : null,
      requestId: typeof result.provider_request_id === 'string' ? result.provider_request_id : null,
      responseId: typeof result.provider_response_id === 'string' ? result.provider_response_id : null,
    } : null,
    reason: classify(input, tools),
    detail: sanitizeOwnerDiagnostic(input.error || '未记录失败说明'),
    tools,
    cost: input.cost,
    development: input.development,
    capturedAt: input.capturedAt,
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/electron && bun test src/main/lib/project-owner-terminal-evidence.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 6: 递增版本并提交**

```bash
cd packages/shared && npm pkg set version=0.2.161 && cd ../..
git add packages/shared/src/types/project-owner.ts apps/electron/src/main/lib/project-owner-terminal-evidence.ts apps/electron/src/main/lib/project-owner-terminal-evidence.test.ts packages/shared/package.json
git commit -m "feat(owner): 归因Owner命令终态并保留Provider原始终止原因"
```

---

## Task 2: 证据持久化与命令视图挂载

**Files:**
- Modify: `apps/electron/src/main/lib/project-sqlite-store.ts`（`migrate()` 内，紧跟 `project_owner_execution_preparations` 之后）
- Modify: `apps/electron/src/main/lib/project-owner-terminal-evidence.ts`（新增 `writeOwnerTerminalEvidence` / `readOwnerTerminalEvidence`）
- Modify: `apps/electron/src/main/lib/project-owner-execution-command.ts`（`listOwnerExecutionCommands` 挂载字段）
- Test: `apps/electron/src/main/lib/project-owner-terminal-evidence.test.ts`（追加仓储用例）

- [ ] **Step 1: 写失败测试（同一命令重复写入必须幂等，篡改必须抛错）**

在 `project-owner-terminal-evidence.test.ts` 末尾追加（沿用同文件顶部已有的 `PROMA_TEST_CONFIG_DIR` 隔离方式；若文件当前是纯函数测试，则新开 `project-owner-terminal-evidence-store.test.ts` 并在文件头用与 `project-owner-execution-file-failure.test.ts` 相同的 `mkdtempSync + mock.module('electron', ...)` 初始化）：

```ts
test('Given同一命令重复写入 When证据一致 Then幂等且不改写；内容不同则拒绝', async () => {
  const store = await import('./project-sqlite-store')
  const repo = await import('./project-owner-terminal-evidence')
  await store.initProjectDb()
  const project = store.createProject({ title: '终端证据', description: '' })
  const evidence = {
    schemaVersion: 1 as const, executionId: 'exec-1', commandId: 'cmd-1', role: 'executor' as const,
    executionStatus: 'failed', provider: { subtype: 'error_during_execution', finishReason: 'other', requestId: 'r', responseId: null },
    reason: 'provider_stop' as const, detail: 'Owner模型未完整结束', tools: { calls: 1, results: 1, lastToolName: 'Read', lastResultStatus: 'ok' as const, incompleteBatch: false },
    cost: { state: 'settled' as const, actualCostMicros: 10, requestCount: 1 },
    development: { worktreePath: '/tmp/w', baseCommit: 'a'.repeat(40), changedFiles: ['index.html'], untrackedFiles: [] },
    capturedAt: 1,
  }
  expect(repo.writeOwnerTerminalEvidence(project.id, evidence)).toEqual(evidence)
  expect(repo.writeOwnerTerminalEvidence(project.id, evidence)).toEqual(evidence)
  expect(() => repo.writeOwnerTerminalEvidence(project.id, { ...evidence, detail: '不同说明' })).toThrow('不一致')
  expect(repo.readOwnerTerminalEvidence('cmd-1')).toEqual(evidence)
  store.closeProjectDb()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/electron && bun test src/main/lib/project-owner-terminal-evidence-store.test.ts`
Expected: FAIL — `writeOwnerTerminalEvidence is not a function`

- [ ] **Step 3: 建表**

在 `apps/electron/src/main/lib/project-sqlite-store.ts` 的 `migrate()` 中，紧跟 `project_owner_execution_preparations` 建表语句之后追加：

```ts
  database.exec(`CREATE TABLE IF NOT EXISTS project_owner_execution_terminal_evidence (
    command_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, execution_id TEXT NOT NULL,
    payload TEXT NOT NULL, integrity_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  )`)
  database.exec('CREATE INDEX IF NOT EXISTS idx_owner_terminal_evidence_project ON project_owner_execution_terminal_evidence(project_id)')
```

- [ ] **Step 4: 实现仓储**

在 `project-owner-terminal-evidence.ts` 顶部加入 `import { ownerExecutionHash } from './project-owner-execution-hash'` 与 `import * as store from './project-sqlite-store'`，文件末尾追加：

```ts
interface EvidenceRow { payload: string; integrity_hash: string; project_id: string; execution_id: string }

/** 证据结构里没有 projectId；出现即视为被篡改，拒绝读取。 */
const EVIDENCE_KEYS = ['schemaVersion', 'executionId', 'commandId', 'role', 'executionStatus', 'provider', 'reason', 'detail', 'tools', 'cost', 'development', 'capturedAt'].sort()

function parseEvidenceRow(row: EvidenceRow, commandId: string): OwnerTerminalEvidence {
  const value: unknown = JSON.parse(row.payload)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Owner终端证据结构无效')
  if (ownerExecutionHash(value) !== row.integrity_hash) throw new Error('Owner终端证据完整性无效')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('|') !== EVIDENCE_KEYS.join('|')) throw new Error('Owner终端证据夹带未授权字段')
  const evidence = value as OwnerTerminalEvidence
  if (evidence.schemaVersion !== 1 || evidence.commandId !== commandId || evidence.executionId !== row.execution_id) throw new Error('Owner终端证据身份无效')
  return evidence
}

/** 同一命令只允许一份证据；重复写入必须逐字节一致，避免终态回调竞争产生两个说法。 */
export function writeOwnerTerminalEvidence(projectId: string, evidence: OwnerTerminalEvidence): OwnerTerminalEvidence {
  if (!projectId.trim() || !evidence.commandId.trim() || !evidence.executionId.trim()) throw new Error('Owner终端证据主体无效')
  const database = store.getProjectDb()
  const existing = database.prepare('SELECT payload, integrity_hash, project_id, execution_id FROM project_owner_execution_terminal_evidence WHERE command_id=?')
    .get(evidence.commandId) as EvidenceRow | undefined
  const integrityHash = ownerExecutionHash(evidence)
  if (existing) {
    if (existing.project_id !== projectId || existing.execution_id !== evidence.executionId || existing.integrity_hash !== integrityHash)
      throw new Error('Owner终端证据与已有记录不一致，保留原件核查')
    return evidence
  }
  database.prepare('INSERT INTO project_owner_execution_terminal_evidence(command_id,project_id,execution_id,payload,integrity_hash,created_at) VALUES(?,?,?,?,?,?)')
    .run(evidence.commandId, projectId, evidence.executionId, JSON.stringify(evidence), integrityHash, evidence.capturedAt)
  return evidence
}

export function readOwnerTerminalEvidence(commandId: string): OwnerTerminalEvidence | null {
  const row = store.getProjectDb().prepare('SELECT payload, integrity_hash, project_id, execution_id FROM project_owner_execution_terminal_evidence WHERE command_id=?')
    .get(commandId) as EvidenceRow | undefined
  return row ? parseEvidenceRow(row, commandId) : null
}
```

> 注意：`OwnerTerminalEvidence` 没有 `projectId` 字段，`evidence.projectId !== undefined` 这一句用于拒绝夹带未授权字段；`parseEvidenceRow` 中的判断请保留。

- [ ] **Step 5: 命令视图挂载**

在 `project-owner-execution-command.ts` 的 `listOwnerExecutionCommands` 中，仿照 `technicalReviews` 的写法：

1. 顶部导入：`import { readOwnerTerminalEvidence } from './project-owner-terminal-evidence'`
2. 在 `return rows.map(row => {` 之前加入：

```ts
  const terminalEvidence = new Map<string, NonNullable<OwnerExecutionCommandView['terminalEvidence']>>()
```

3. 在 `return {` 对象字面量里，`...(technicalReview ? { technicalReview } : {}),` 之后追加：

```ts
      ...(() => {
        if (!terminalEvidence.has(row.command_id)) {
          const evidence = readOwnerTerminalEvidence(row.command_id)
          if (evidence) terminalEvidence.set(row.command_id, evidence)
        }
        const evidence = terminalEvidence.get(row.command_id)
        return evidence ? { terminalEvidence: evidence } : {}
      })(),
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd apps/electron && bun test src/main/lib/project-owner-terminal-evidence-store.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
cd packages/shared && npm pkg set version=0.2.162 && cd ../..
git add apps/electron/src/main/lib/project-sqlite-store.ts apps/electron/src/main/lib/project-owner-terminal-evidence.ts apps/electron/src/main/lib/project-owner-execution-command.ts apps/electron/src/main/lib/project-owner-terminal-evidence-store.test.ts packages/shared/package.json
git commit -m "feat(owner): 持久化并展示Owner命令终端证据"
```

---

## Task 3: 终态回调写入证据（含研发工作树现场）

**Files:**
- Modify: `apps/electron/src/main/lib/agent-employee-service.ts`
- Test: `apps/electron/src/main/lib/project-owner-execution-launch.test.ts`（复用既有 `textDeliveryRun({ truncated: true })` 夹具）

- [ ] **Step 1: 写失败测试**

在 `project-owner-execution-launch.test.ts` 的「已结算用量但正文截断」用例后追加：

```ts
test('Given研发执行被截断 When读取命令视图 Then带可核对的终端证据与工作树现场', async () => {
  const r = await textDeliveryRun({ truncated: true, profile: 'development' })
  const commands = (await import('./project-owner-execution-command')).listOwnerExecutionCommands(r.f.subject)
  const evidence = commands[0]?.terminalEvidence
  expect(evidence).toBeDefined()
  expect(evidence).toMatchObject({
    reason: 'output_limit',
    provider: { subtype: 'error_during_execution', finishReason: 'length' },
    cost: { state: 'settled' },
  })
  expect(evidence!.executionId).toBe(commands[0]!.executionId!)
  // 研发现场必须来自真实绑定，而不是从摘要拼装。
  expect(evidence!.development?.worktreePath ?? '').not.toBe('')
})
```

> 若 `textDeliveryRun` 的开发档在截断用例下不建 worktree，先运行看实际报错，再在 `textDeliveryRun` 里补 `profile: 'development'` 的 fixture 参数——**不要**改成断言 `development === null`，那会掩盖需求。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/electron && bun test src/main/lib/project-owner-execution-launch.test.ts -t "研发执行被截断"`
Expected: FAIL — `evidence` 为 `undefined`

- [ ] **Step 3: 让回调携带 runtimeResult**

在 `agent-employee-service.ts` 中：

1. 导入证据模块：

```ts
import { classifyOwnerTerminalEvidence, writeOwnerTerminalEvidence } from './project-owner-terminal-evidence'
```

2. 修改 `handleOwnerCommandRunCallback` 签名与调用：

```ts
function handleOwnerCommandRunCallback(execution: AgentExecution, messages: AgentMessage[] | undefined, stopped: boolean, error?: string, runtimeResult?: SDKResultMessage): boolean {
```

```ts
  const pending = finalizeOwnerCommandRunCallback(execution, messages, stopped, error, runtimeResult)
```

3. 修改 `finalizeOwnerCommandRunCallback` 签名与内部：

```ts
async function finalizeOwnerCommandRunCallback(execution: AgentExecution, messages: AgentMessage[] | undefined, stopped: boolean, error?: string, runtimeResult?: SDKResultMessage): Promise<boolean> {
```

4. 在 `database.transaction(() => {` 内、`settleOwnerCommandUsage(commandId, usage, completedAt, { deferSchedulerWake: true })` **之前**追加：

```ts
      writeOwnerTerminalEvidence(execution.projectId, classifyOwnerTerminalEvidence({
        executionId: execution.id, commandId, role: command.role as 'executor' | 'reviewer',
        executionStatus: nextStatus, stopped, runtimeResult: runtimeResult ?? null,
        messages: messages ?? [], error: error ?? '',
        cost: { state: usage.source === 'unknown' ? 'unknown' : 'settled', actualCostMicros: usage.source === 'unknown' ? null : usage.costMicros, requestCount: rows.length },
        development: readOwnerDevelopmentSnapshotState(execution, command.role === 'executor'),
        capturedAt: completedAt,
      }))
```

5. 在同文件新增只读采集函数（放在 `finalizeOwnerCommandRunCallback` 之前）：

```ts
/** 只读取已绑定 worktree 的现场；任何核验失败都退化为 null，不阻断终态。 */
function readOwnerDevelopmentSnapshotState(execution: AgentExecution, executor: boolean): OwnerTerminalEvidence['development'] {
  if (!executor) return null
  try {
    const meta = getAgentSessionMeta(execution.sessionId)
    const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
    if (!workspace?.rootPath || !execution.sessionId) return null
    const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, execution.sessionId)
    const worktreePath = resolveDevelopmentWorktree(workspace.rootPath, sessionDirectory)
    if (!worktreePath) return null
    const binding = JSON.parse(readFileSync(join(sessionDirectory, 'development-worktree.json'), 'utf8')) as { baseCommit?: unknown }
    const baseCommit = typeof binding.baseCommit === 'string' && /^[a-f0-9]{40,64}$/.test(binding.baseCommit) ? binding.baseCommit : null
    const status = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8', timeout: 30_000 }).split('\n').filter(Boolean)
    return {
      worktreePath,
      baseCommit,
      changedFiles: status.filter(line => !line.startsWith('?? ')).map(line => line.slice(3)).slice(0, 50),
      untrackedFiles: status.filter(line => line.startsWith('?? ')).map(line => line.slice(3)).slice(0, 50),
    }
  } catch { return null }
}
```

6. 补导入（若尚未存在）：`import { readFileSync } from 'node:fs'`、`import { join } from 'node:path'`、`import { execFileSync } from 'node:child_process'`、`import type { OwnerTerminalEvidence } from '@gravitas/shared'`、`import { getAgentSessionWorkspacePath } from './config-paths'`、`import { getAgentWorkspace } from './agent-workspace-manager'`、`import { resolveDevelopmentWorktree } from './agent-development-worktree'`。

> 关键点：`finalizeOwnerCommandRunCallback` 只在 `execution.status === 'running'` 时执行，证据与 `status` 更新同事务；若事务回滚，证据一起回滚，不会出现「有证据无终态」。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/electron && bun test src/main/lib/project-owner-execution-launch.test.ts -t "研发执行被截断"`
Expected: PASS

- [ ] **Step 5: 回归既有 Owner 终态用例**

Run: `cd apps/electron && bun test src/main/lib/project-owner-execution-stage-b.test.ts src/main/lib/project-owner-execution-launch.test.ts`
Expected: 全部 PASS（若出现既有失败，用 `git stash push -u -m <tag>` + `git stash apply <sha>` 对比基线，不要直接改断言）

- [ ] **Step 6: 提交**

```bash
cd packages/shared && npm pkg set version=0.2.163 && cd ../..
git add apps/electron/src/main/lib/agent-employee-service.ts apps/electron/src/main/lib/project-owner-execution-launch.test.ts packages/shared/package.json
git commit -m "feat(owner): 终态回调保存Provider终止原因与工作树现场"
```

---

## Task 4: 混合批次接替（核心恢复）

**Files:**
- Create: `apps/electron/src/main/lib/project-owner-mixed-batch-recovery.ts`
- Modify: `apps/electron/src/main/lib/project-sqlite-store.ts`（新增接替关联表）
- Modify: `apps/electron/src/main/lib/project-owner-execution-start-intent.ts`
- Test: `apps/electron/src/main/lib/project-owner-mixed-batch-recovery.test.ts`

- [ ] **Step 1: 写失败测试（真实案例：规格完成 + 评审通过 + 研发失败）**

```ts
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-mixed-batch-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))

const store = await import('./project-sqlite-store')
const recovery = await import('./project-owner-mixed-batch-recovery')

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

function row(overrides: Record<string, unknown>) {
  return {
    id: 'cmd', role: 'executor', state: 'settled', execution_id: 'exec', rework_ordinal: 0,
    actual_cost_micros: 100, usage_evidence: JSON.stringify({ source: 'request_settled' }), execution_status: 'failed',
    task_id: 'task-dev',
    ...overrides,
  }
}

test('Given规格与评审已通过、研发失败 When评估接替 Then允许且列出需保留的已完成步骤', () => {
  const result = recovery.assessMixedBatch({
    commands: [
      row({ id: 'spec', role: 'executor', task_id: 'task-spec', execution_status: 'completed' }),
      row({ id: 'spec-review', role: 'reviewer', task_id: 'task-spec', execution_status: 'completed' }),
      row({ id: 'dev', role: 'executor', task_id: 'task-dev', execution_status: 'failed' }),
    ],
    pendingRequestReservations: 0,
    acceptedByTask: new Map([['task-spec', 'a'.repeat(64)]]),
    taskArtifactHash: new Map([['task-spec', 'a'.repeat(64)], ['task-dev', null]]),
    grantState: 'paused',
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.retainedTaskIds).toEqual(['task-spec'])
  expect(result.failedCommandIds).toEqual(['dev'])
})

test('Given仍有活动执行 When评估接替 Then拒绝并给出具体阻断项', () => {
  const result = recovery.assessMixedBatch({
    commands: [row({ id: 'dev', execution_status: 'running', state: 'running' })],
    pendingRequestReservations: 0, acceptedByTask: new Map(), taskArtifactHash: new Map([['task-dev', null]]), grantState: 'paused',
  })
  expect(result.ok).toBe(false)
  if (result.ok) return
  // 运行中的命令同时命中“未结算”规则，断言必须按包含关系而不是全等。
  expect(result.blockers).toContain('仍有运行中或排队的命令，不能接替')
})

test('Given费用未知 When评估接替 Then拒绝并保留占额说明', () => {
  const result = recovery.assessMixedBatch({
    commands: [row({ id: 'dev', actual_cost_micros: null, usage_evidence: null })],
    pendingRequestReservations: 0, acceptedByTask: new Map(), taskArtifactHash: new Map([['task-dev', null]]), grantState: 'paused',
  })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.blockers.join()).toContain('费用未知')
})

test('Given已完成任务缺少验收依据 When评估接替 Then拒绝以免重复执行', () => {
  const result = recovery.assessMixedBatch({
    commands: [row({ id: 'spec', execution_status: 'completed', task_id: 'task-spec' }), row({ id: 'dev' })],
    pendingRequestReservations: 0, acceptedByTask: new Map(), taskArtifactHash: new Map([['task-spec', 'b'.repeat(64)], ['task-dev', null]]), grantState: 'paused',
  })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.blockers.join()).toContain('缺少可核对的验收依据')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/electron && bun test src/main/lib/project-owner-mixed-batch-recovery.test.ts`
Expected: FAIL — `Cannot find module './project-owner-mixed-batch-recovery'`

- [ ] **Step 3: 实现纯评估 + 落库接替**

```ts
/** 混合批次接替：保留已验收成果与费用记录，只为失败步骤建立新批次。 */
import type { ProjectOwnerGoalSubject } from '@gravitas/shared'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { confirmOwnerExecutionGrantRevoke, getOwnerExecutionGrant, previewOwnerExecutionGrantRevoke } from './project-owner-execution-grant-issue'
import { readOwnerQualityAction } from './project-owner-quality-actions'
import * as store from './project-sqlite-store'

export interface MixedBatchCommand {
  id: string
  role: 'executor' | 'reviewer'
  state: string
  execution_id: string | null
  rework_ordinal: number
  actual_cost_micros: number | null
  usage_evidence: string | null
  execution_status: string | null
  task_id?: string
}

export interface MixedBatchInput {
  commands: readonly MixedBatchCommand[]
  pendingRequestReservations: number
  /** 已完成任务 -> 已验收的 artifactHash */
  acceptedByTask: ReadonlyMap<string, string>
  /** 任务 -> 当前冻结成果哈希；失败任务为 null */
  taskArtifactHash: ReadonlyMap<string, string | null>
  grantState: string
}

export type MixedBatchAssessment =
  | { ok: true; retainedTaskIds: string[]; failedCommandIds: string[]; supersededCommandIds: string[] }
  | { ok: false; blockers: string[] }

export function assessMixedBatch(input: MixedBatchInput): MixedBatchAssessment {
  const blockers: string[] = []
  if (input.commands.some(command => ['queued', 'running', 'reserved'].includes(command.state))) blockers.push('仍有运行中或排队的命令，不能接替')
  if (input.pendingRequestReservations > 0) blockers.push('仍有未结的请求占额，不能接替')
  if (input.commands.some(command => command.state !== 'settled' || command.actual_cost_micros === null || !command.usage_evidence))
    blockers.push('存在费用未知或未结算的命令，不能接替')
  if (!input.commands.some(command => command.execution_status === 'failed')) blockers.push('没有失败命令需要恢复')
  // 授权处于 needs_reconcile 时费用与停止状态都未收敛，必须先由用户对账，不能自动接替。
  if (input.grantState === 'needs_reconcile') blockers.push('授权处于待对账状态，需要先核对费用与停止结果')
  if (blockers.length) return { ok: false, blockers }
  // 同一任务可能同时有 executor 与 reviewer 两条已完成命令；按任务去重，避免把同一步骤重复计入保留清单。
  const retained = new Set<string>(), supersededCommandIds: string[] = []
  for (const command of input.commands) {
    const taskId = command.task_id
    if (!taskId) continue
    supersededCommandIds.push(command.id)
    if (command.execution_status !== 'completed' || retained.has(taskId)) continue
    const artifact = input.taskArtifactHash.get(taskId) ?? null
    const accepted = input.acceptedByTask.get(taskId) ?? null
    if (!artifact || !accepted || artifact !== accepted) blockers.push(`任务 ${taskId} 已完成但缺少可核对的验收依据，不能接替以免重复执行`)
    else retained.add(taskId)
  }
  if (blockers.length) return { ok: false, blockers }
  return { ok: true, retainedTaskIds: [...retained], failedCommandIds: input.commands.filter(c => c.execution_status === 'failed').map(c => c.id), supersededCommandIds }
}

export interface MixedBatchSupersession {
  id: string
  projectId: string
  previousMaterializationId: string
  previousGrantId: string
  nextMaterializationId: string
  retainedTaskIds: string[]
  failedCommandIds: string[]
  createdAt: number
}

/** 接替前必须先暂停旧授权；返回后续写关联记录所需的事实。 */
export interface MixedBatchSupersessionPlan {
  projectId: string
  previousMaterializationId: string
  previousGrantId: string
  retainedTaskIds: string[]
  failedCommandIds: string[]
}

/** 读取并核对旧批次：命令、逐请求占额、验收依据与失败工作树。 */
export function readMixedBatchAssessment(subject: ProjectOwnerGoalSubject, previousMaterializationId: string): MixedBatchAssessment {
  const projectId = subject.projectId
  const database = store.getProjectDb()
  const commands = database.prepare(`SELECT c.id, c.role, c.state, c.execution_id, c.rework_ordinal, c.actual_cost_micros, c.usage_evidence,
      c.source_task_id AS task_id, e.status AS execution_status
    FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    LEFT JOIN agent_executions e ON e.id=c.execution_id
    WHERE c.project_id=? AND g.materialization_id=?`).all(projectId, previousMaterializationId) as MixedBatchCommand[]
  const pending = database.prepare(`SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations r
    JOIN project_owner_execution_commands c ON c.id=r.command_id
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    WHERE g.project_id=? AND g.materialization_id=? AND r.state!='settled'`).get(projectId, previousMaterializationId) as { count: number }
  const acceptedByTask = new Map<string, string>(), taskArtifactHash = new Map<string, string | null>()
  for (const command of commands) {
    if (!command.task_id || command.role !== 'reviewer') continue
    try {
      const action = readOwnerQualityAction(command.id)
      if (action?.state === 'accepted') acceptedByTask.set(command.task_id, action.artifactHash)
    } catch { /* 验收记录不可核验时按缺失处理，由 assessMixedBatch 拒绝。 */ }
    taskArtifactHash.set(command.task_id, taskArtifactHash.get(command.task_id) ?? acceptedByTask.get(command.task_id) ?? null)
  }
  return assessMixedBatch({
    commands, pendingRequestReservations: pending.count, acceptedByTask, taskArtifactHash,
    // 主体可能带 taskId；grant 查询必须用同一主体，否则会读到项目级授权。
    grantState: getOwnerExecutionGrant(subject)?.state ?? 'missing',
  })
}

/**
 * 接替第一步：核对旧批次并暂停旧授权。旧授权若仍为 active，必须经撤权预览确认无阻断；
 * 不允许绕过授权状态直接改库。此函数只产出现场事实，不写关联记录。
 */
export function planMixedBatchSupersession(subject: ProjectOwnerGoalSubject, previousMaterializationId: string): MixedBatchSupersessionPlan {
  const assessment = readMixedBatchAssessment(subject, previousMaterializationId)
  if (!assessment.ok) throw new Error(`混合批次暂不能接替：${assessment.blockers.join('；')}`)
  const grant = getOwnerExecutionGrant(subject)
  if (!grant) throw new Error('混合批次缺少原执行授权')
  if (grant.state === 'active') {
    const preview = previewOwnerExecutionGrantRevoke(subject, { grantId: grant.grantId })
    if (preview.blockers.length) throw new Error(`旧批次仍有未收敛的执行或费用，不能接替：${preview.blockers.join('；')}`)
    const closed = confirmOwnerExecutionGrantRevoke(subject, { grantId: grant.grantId, confirmedFingerprint: preview.fingerprint })
    if (closed.state !== 'paused') throw new Error('旧授权未能安全暂停；接替未开始')
  } else if (!['paused', 'archived'].includes(grant.state)) {
    throw new Error(`旧授权处于 ${grant.state}，需要先核对原授权`)
  }
  return {
    projectId: subject.projectId,
    previousMaterializationId,
    previousGrantId: grant.grantId,
    retainedTaskIds: assessment.retainedTaskIds,
    failedCommandIds: assessment.failedCommandIds,
  }
}

/** 接替第二步：新批次材料化成功后写入关联记录，让用户能追溯恢复过程。 */
export function recordMixedBatchSupersession(subject: ProjectOwnerGoalSubject, plan: MixedBatchSupersessionPlan, nextMaterializationId: string): MixedBatchSupersession {
  if (!nextMaterializationId.trim() || nextMaterializationId.startsWith('pending:')) throw new Error('接替关联必须指向已材料化的新批次')
  const body = {
    schemaVersion: 1 as const, projectId: subject.projectId, ...(subject.taskId ? { taskId: subject.taskId } : {}),
    previousMaterializationId: plan.previousMaterializationId, previousGrantId: plan.previousGrantId, nextMaterializationId,
    retainedTaskIds: plan.retainedTaskIds, failedCommandIds: plan.failedCommandIds, createdAt: Date.now(),
  }
  const id = `owner-mixed-supersession-${ownerExecutionHash(body).slice(0, 32)}`
  const record: MixedBatchSupersession = { ...body, id }
  store.getProjectDb().prepare(`INSERT OR IGNORE INTO project_owner_execution_batch_supersessions
    (id, project_id, previous_materialization_id, next_materialization_id, payload, integrity_hash, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, subject.projectId, plan.previousMaterializationId, nextMaterializationId, JSON.stringify(record), ownerExecutionHash(record), record.createdAt)
  return record
}

export function listMixedBatchSupersessions(projectId: string): MixedBatchSupersession[] {
  return (store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_execution_batch_supersessions WHERE project_id=? ORDER BY created_at')
    .all(projectId) as Array<{ payload: string; integrity_hash: string }>).map(row => {
    const value = JSON.parse(row.payload) as MixedBatchSupersession
    if (ownerExecutionHash(value) !== row.integrity_hash) throw new Error('混合批次接替记录完整性无效')
    return value
  })
}
```

- [ ] **Step 4: 建表**

在 `project-sqlite-store.ts` 的 `migrate()` 中，紧跟终端证据表之后追加：

```ts
  database.exec(`CREATE TABLE IF NOT EXISTS project_owner_execution_batch_supersessions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, previous_materialization_id TEXT NOT NULL,
    next_materialization_id TEXT NOT NULL, payload TEXT NOT NULL, integrity_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  )`)
  database.exec('CREATE INDEX IF NOT EXISTS idx_owner_batch_supersessions_project ON project_owner_execution_batch_supersessions(project_id)')
```

- [ ] **Step 5: 在启动意图中接入**

在 `project-owner-execution-start-intent.ts`：

1. 导入：`import { planMixedBatchSupersession, recordMixedBatchSupersession, type MixedBatchSupersessionPlan } from './project-owner-mixed-batch-recovery'`
2. 在 `resumeOwnerExecutionStartIntent` 中，把原来的 `replacingPreviousBatch` 判定替换为「先尝试混合接替、失败再走既有四条专用规则」：

```ts
    // 混合批次：只暂停旧授权并记录现场，关联记录等新批次材料化成功后再写。
    let mixedPlan: MixedBatchSupersessionPlan | null = null
    if (previousMaterialization && previousMaterialization.input.requestId !== `owner-start:${intent.intentId}`) {
      try { mixedPlan = planMixedBatchSupersession(subject, previousMaterialization.id) }
      catch (cause) { console.warn('[Owner执行] 混合批次接替条件不满足，保留原记录', subject.projectId, cause instanceof Error ? cause.message : cause) }
    }
    const replacingPreviousBatch = Boolean(previousMaterialization && (mixedPlan || (
      supersedeDeliveredFeedbackBatch(subject, plan, previousMaterialization.id)
      || supersedePreviousGoalBatch(subject, plan, previousMaterialization)
      || supersedeEscalatedBatch(subject, plan, previousMaterialization)
      || supersedeFailedBatch(subject, plan, previousMaterialization, intent.input.executionKind === 'development'))))
```

> 注意括号：`supersedeDeliveredFeedbackBatch` 的第三个参数是 `previousMaterialization.id`，其余三条仍传 `previousMaterialization` 对象——保持现有调用形态，不要统一改参。

3. 在 `if (!materialization) { ... materializeOwnerTasks(...) }` 的闭合大括号之后、`const grant = await dependencies.launch(...)` 之前追加：

```ts
    if (mixedPlan && materialization) recordMixedBatchSupersession(subject, mixedPlan, materialization.id)
```

> 设计理由：接替记录一旦写入就带完整性哈希；用占位符再改列会让哈希失效并破坏追溯。拆成「暂停旧授权」与「写关联」两步，既保证授权状态转换显式，又保证记录不可变。

- [ ] **Step 6: 运行测试确认通过**

Run: `cd apps/electron && bun test src/main/lib/project-owner-mixed-batch-recovery.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 7: 递增版本并提交**

```bash
cd packages/shared && npm pkg set version=0.2.164 && cd ../..
git add apps/electron/src/main/lib/project-owner-mixed-batch-recovery.ts apps/electron/src/main/lib/project-owner-mixed-batch-recovery.test.ts apps/electron/src/main/lib/project-sqlite-store.ts apps/electron/src/main/lib/project-owner-execution-start-intent.ts packages/shared/package.json
git commit -m "feat(owner): 支持规格完成、研发失败的混合批次安全接替"
```

---

## Task 5: 失败研发工作树的可信交接

**Files:**
- Create: `apps/electron/src/main/lib/project-owner-development-recovery.ts`
- Modify: `apps/electron/src/main/lib/agent-employee-service.ts`（`seedOwnerDevelopmentRework` 之前接入）
- Test: `apps/electron/src/main/lib/project-owner-development-recovery.test.ts`

- [ ] **Step 1: 写失败测试（有改动则交接、无改动则放行、越界则拒绝）**

```ts
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-dev-recovery-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const recovery = await import('./project-owner-development-recovery')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

function repo(): string {
  const root = mkdtempSync(join(directory, 'repo-'))
  git(root, 'init')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'user.name', 'test')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'base')
  return root
}

test('Given失败工作树留有改动 When盘点 Then返回可核对的相对路径与基线', () => {
  const root = repo()
  const worktree = join(root, '..', 'wt')
  git(root, 'worktree', 'add', '-b', 'employee/exec-1', worktree, 'HEAD')
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src', 'game.ts'), 'export const x = 1\n')
  writeFileSync(join(worktree, 'README.md'), 'changed\n')
  const inventory = recovery.inspectFailedDevelopmentWorktree(worktree, root)
  expect(inventory.baseCommit).toBe(git(root, 'rev-parse', 'HEAD'))
  expect(inventory.changedFiles).toEqual(['README.md'])
  expect(inventory.untrackedFiles).toEqual(['src/game.ts'])
})

test('Given工作树干净 When盘点 Then明确报告没有可交接内容', () => {
  const root = repo()
  const worktree = join(root, '..', 'wt2')
  git(root, 'worktree', 'add', '-b', 'employee/exec-2', worktree, 'HEAD')
  expect(recovery.inspectFailedDevelopmentWorktree(worktree, root)).toMatchObject({ changedFiles: [], untrackedFiles: [], hasChanges: false })
})

test('Given工作树属于其他仓库 When盘点 Then拒绝而不是静默继续', () => {
  const root = repo(), other = repo()
  expect(() => recovery.inspectFailedDevelopmentWorktree(other, root)).toThrow('不属于当前仓库')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/electron && bun test src/main/lib/project-owner-development-recovery.test.ts`
Expected: FAIL — `Cannot find module './project-owner-development-recovery'`

- [ ] **Step 3: 实现盘点与快照交接**

```ts
/** 失败研发工作树的只读盘点与可信交接；不提交、不丢弃、不覆盖用户文件。 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DevelopmentSnapshot, DevelopmentTaskScope } from '@gravitas/shared'
import { applyOwnerDevelopmentSnapshot } from './project-owner-development-handoff'
import { createDevelopmentSnapshotAsync, developmentWorktreeMatchesSnapshotAsync, readDevelopmentSnapshotContentsAsync } from './development-snapshot-service'

export interface FailedDevelopmentInventory {
  worktreePath: string
  baseCommit: string
  changedFiles: string[]
  untrackedFiles: string[]
  hasChanges: boolean
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function inspectFailedDevelopmentWorktree(worktreePath: string, repository: string): FailedDevelopmentInventory {
  const worktree = realpathSync(worktreePath), repo = realpathSync(repository)
  const top = realpathSync(git(worktree, 'rev-parse', '--show-toplevel'))
  if (top !== worktree) throw new Error('失败研发工作树路径不是仓库根目录')
  if (realpathSync(resolve(worktree, git(worktree, 'rev-parse', '--git-common-dir'))) !== realpathSync(resolve(repo, git(repo, 'rev-parse', '--git-common-dir'))))
    throw new Error('失败研发工作树不属于当前仓库')
  const baseCommit = git(worktree, 'rev-parse', 'HEAD')
  const status = git(worktree, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean)
  const changedFiles = status.filter(line => !line.startsWith('?? ')).map(line => line.slice(3))
  const untrackedFiles = status.filter(line => line.startsWith('?? ')).map(line => line.slice(3))
  return { worktreePath: worktree, baseCommit, changedFiles, untrackedFiles, hasChanges: status.length > 0 }
}

/**
 * 把失败工作树的改动冻结成快照并应用到新工作树。
 * 无改动时返回 null（新工作树保持干净）；快照不可核验时抛错，绝不静默丢弃半成品。
 * `repository` 必须是主仓库根，只用于校验 worktree 归属，不参与写入。
 */
export async function seedFailedDevelopmentWorktree(input: {
  repository: string
  failedWorktreePath: string
  failedSessionDirectory: string
  failedExecutionId: string
  workspaceId: string
  targetWorktreePath: string
  targetSessionDirectory: string
  scope: DevelopmentTaskScope
}): Promise<DevelopmentSnapshot | null> {
  const inventory = inspectFailedDevelopmentWorktree(input.failedWorktreePath, input.repository)
  if (!inventory.hasChanges) return null
  const snapshot = await createDevelopmentSnapshotAsync({
    worktreePath: input.failedWorktreePath, sessionDirectory: input.failedSessionDirectory,
    executionId: input.failedExecutionId, workspaceId: input.workspaceId, scope: input.scope,
  })
  if (snapshot.baseCommit !== inventory.baseCommit)
    throw new Error('失败工作树基线与快照不一致，已停止交接')
  if (!await developmentWorktreeMatchesSnapshotAsync(input.failedWorktreePath, snapshot, input.scope))
    throw new Error('失败工作树在冻结后发生变化，已停止交接')
  const files = await readDevelopmentSnapshotContentsAsync(input.failedSessionDirectory, input.failedExecutionId)
  applyOwnerDevelopmentSnapshot(input.targetWorktreePath, input.targetSessionDirectory, snapshot, files, input.scope.allowedPaths)
  return snapshot
}
```

> 注意 `inspectFailedDevelopmentWorktree(worktreePath, repository)` 的第二个参数是**主仓库根**（用于比较 `--git-common-dir`），不是 worktree 路径。

- [ ] **Step 4: 在员工启动链中接入（失败步骤恢复）**

在 `agent-employee-service.ts` 的 `development` 分支（约 1002 行）中，`createDevelopmentWorktree` 之后、`prepareOwnerTargetDirectories` 之前追加：

```ts
      if (ownerExecution?.role === 'executor') {
        const recoveries = (require('./project-owner-mixed-batch-recovery') as typeof import('./project-owner-mixed-batch-recovery'))
          .listMixedBatchSupersessions(execution.projectId)
        const recovery = recoveries.at(-1)
        if (recovery) {
          const previous = store.getProjectDb().prepare(`SELECT c.execution_id, e.session_id FROM project_owner_execution_commands c
            JOIN agent_executions e ON e.id=c.execution_id WHERE c.id=?`).get(recovery.failedCommandIds[0] ?? '') as { execution_id: string; session_id: string } | undefined
          if (previous?.session_id) {
            const { seedFailedDevelopmentWorktree } = await import('./project-owner-development-recovery')
            await seedFailedDevelopmentWorktree({
              failedWorktreePath: resolveDevelopmentWorktree(workspace.rootPath!, getAgentSessionWorkspacePath(workspace.slug, previous.session_id))!,
              failedSessionDirectory: getAgentSessionWorkspacePath(workspace.slug, previous.session_id),
              failedExecutionId: previous.execution_id,
              workspaceId: workspace.id,
              targetWorktreePath: worktree.path,
              targetSessionDirectory: sessionDirectory,
              scope: validateDevelopmentScope(frozenScope(ownerExecution.commandId), { getWorkspace: getAgentWorkspace }),
            })
          }
        }
      }
```

其中 `frozenScope` 是本地小工具（同文件内）：

```ts
function frozenScope(commandId: string) {
  const { source, taskId } = readOwnerCommandFrozenSource(commandId)
  const scope = source.tasks.find(item => item.taskId === taskId)?.developmentScope
  if (!scope) throw new Error('Owner研发执行缺少冻结文件范围')
  return scope
}
```

并把原有的 `prepareOwnerTargetDirectories` 调用改为复用同一 `scope`（避免重复读取）。交接失败时**不得**继续启动：让异常走已有的 `catch` 分支，写 `Owner认领前准备失败` 并保留预留。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/electron && bun test src/main/lib/project-owner-development-recovery.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 6: 提交**

```bash
cd packages/shared && npm pkg set version=0.2.165 && cd ../..
git add apps/electron/src/main/lib/project-owner-development-recovery.ts apps/electron/src/main/lib/project-owner-development-recovery.test.ts apps/electron/src/main/lib/agent-employee-service.ts packages/shared/package.json
git commit -m "feat(owner): 失败研发工作树按快照安全交接，不丢弃半成品"
```

---

## Task 6: 研发工作区阻塞项可处理

**Files:**
- Create: `apps/electron/src/main/lib/development-workspace-blocker.ts`
- Modify: `apps/electron/src/main/lib/agent-development-worktree.ts`
- Modify: `apps/electron/src/main/lib/agent-employee-service.ts`（prestart catch 分支）
- Modify: `apps/electron/src/main/lib/project-owner-execution-ipc.ts`、`packages/shared/src/types/work-module.ts`、`preload/index.ts`
- Test: `apps/electron/src/main/lib/development-workspace-blocker.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectDevelopmentWorkspaceBlocker } from './development-workspace-blocker'

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-blocker-'))
  execFileSync('git', ['-C', root, 'init'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@e.invalid'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 't'])
  writeFileSync(join(root, 'a.txt'), 'a\n')
  execFileSync('git', ['-C', root, 'add', '.'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'base'])
  return root
}

test('Given干净仓库 When检查 Then没有阻塞项', () => {
  const root = repo()
  try { expect(inspectDevelopmentWorkspaceBlocker(root, 'ws-1', '产品仓')).toEqual({ kind: 'ready' }) }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given已跟踪与未跟踪改动 When检查 Then分别列出安全相对路径与处理方式', () => {
  const root = repo()
  try {
    writeFileSync(join(root, 'a.txt'), 'changed\n')
    writeFileSync(join(root, 'new.txt'), 'new\n')
    expect(inspectDevelopmentWorkspaceBlocker(root, 'ws-1', '产品仓')).toMatchObject({
      kind: 'dirty_worktree', workspaceId: 'ws-1', workspaceName: '产品仓',
      trackedFiles: ['a.txt'], untrackedFiles: ['new.txt'],
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/electron && bun test src/main/lib/development-workspace-blocker.test.ts`
Expected: FAIL — `Cannot find module './development-workspace-blocker'`

- [ ] **Step 3: 实现阻塞项**

```ts
/** 研发工作区门禁的结构化结果：只读、可展示、可重新核对。 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

export type DevelopmentWorkspaceBlocker =
  | { kind: 'ready' }
  | { kind: 'not_git_root'; workspaceId: string; workspaceName: string; repository: string; detail: string }
  | { kind: 'dirty_worktree'; workspaceId: string; workspaceName: string; repository: string; trackedFiles: string[]; untrackedFiles: string[]; detail: string; remedy: string }

const MAX_LISTED = 30

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function inspectDevelopmentWorkspaceBlocker(repository: string, workspaceId: string, workspaceName: string): DevelopmentWorkspaceBlocker {
  let root: string
  try { root = realpathSync(repository) } catch { return { kind: 'not_git_root', workspaceId, workspaceName, repository, detail: '工作区目录不存在或不可读' } }
  let top: string
  try { top = realpathSync(git(root, 'rev-parse', '--show-toplevel')) } catch { return { kind: 'not_git_root', workspaceId, workspaceName, repository: root, detail: '工作区不是 Git 仓库' } }
  if (top !== root) return { kind: 'not_git_root', workspaceId, workspaceName, repository: root, detail: `工作区不是仓库根目录（仓库根为 ${top}）` }
  const status = git(root, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean)
  if (!status.length) return { kind: 'ready' }
  const trackedFiles = status.filter(line => !line.startsWith('?? ')).map(line => line.slice(3)).slice(0, MAX_LISTED)
  const untrackedFiles = status.filter(line => line.startsWith('?? ')).map(line => line.slice(3)).slice(0, MAX_LISTED)
  return {
    kind: 'dirty_worktree', workspaceId, workspaceName, repository: root, trackedFiles, untrackedFiles,
    detail: `已跟踪文件有 ${trackedFiles.length} 处修改，未跟踪文件有 ${untrackedFiles.length} 个`,
    remedy: '请先提交、暂存或移走这些文件，然后点击“重新核对工作区”。系统不会自动提交或丢弃你的改动。',
  }
}
```

- [ ] **Step 4: 门禁改抛结构化异常**

`agent-development-worktree.ts` 的 `createDevelopmentWorktree` 中，把第 29 行替换为：

```ts
  const blocker = inspectDevelopmentWorkspaceBlocker(root, 'workspace', root)
  if (blocker.kind === 'dirty_worktree')
    throw new DevelopmentWorkspaceBlockedError(blocker)
  if (blocker.kind === 'not_git_root') throw new Error(blocker.detail)
```

并在同文件顶部新增：

```ts
import { inspectDevelopmentWorkspaceBlocker, type DevelopmentWorkspaceBlocker } from './development-workspace-blocker'

export class DevelopmentWorkspaceBlockedError extends Error {
  constructor(readonly blocker: Extract<DevelopmentWorkspaceBlocker, { kind: 'dirty_worktree' }>) {
    super(`仓库存在未提交改动，请先保存当前迭代，再派发研发任务；不会自动提交或丢弃变更`)
    this.name = 'DevelopmentWorkspaceBlockedError'
  }
}
```

> 调用方若要展示工作区名称，在 `agent-employee-service.ts` 的 prestart catch 中用 `getAgentWorkspace(workspaceId)` 补名后写入活动 payload，不要改这里的方法签名。

- [ ] **Step 5: 持久化并展示**

在 `agent-employee-service.ts` 的 `if (ownerExecution) { store.getProjectDb().transaction(...) }` 分支中，把 `reason: message` 改为：

```ts
          payload: { commandId: ownerExecution.commandId, executionId, reason: message,
            ...(error instanceof DevelopmentWorkspaceBlockedError ? { workspaceBlocker: { ...error.blocker, workspaceName: getAgentWorkspace(workspaceId!)?.name ?? '' } } : {}) }
```

并把 `summary` 改为：

```ts
        summary: error instanceof DevelopmentWorkspaceBlockedError
          ? `研发工作区阻止启动：${error.blocker.detail}。${error.blocker.remedy}`
          : 'Owner认领前准备失败，保留准备成果与费用预留，暂停重复派发。'
```

同时在同一个事务里写一条 `attention` 消息（`appendOwnerManagementMessage`，事件 id 用 `owner-development-blocked:${executionId}`），内容包含工作区名、已跟踪/未跟踪文件列表与「重新核对工作区」按钮说明。

- [ ] **Step 6: 新增重新核对入口**

1. `packages/shared/src/types/work-module.ts` 的 `PROJECT_IPC_CHANNELS` 中追加：

```ts
  RECHECK_OWNER_DEVELOPMENT_WORKSPACE: 'project:recheck-owner-development-workspace',
```

2. `packages/shared/src/types/project-owner.ts` 的 `ProjectOwnerExecutionCommandApi` 中追加：

```ts
  recheckOwnerDevelopmentWorkspace: (request: ProjectOwnerGoalSubject & { executionId: string }) => Promise<ProjectOwnerGoalResult<{ state: 'clean' | 'blocked'; blocker?: { kind: string; detail: string; trackedFiles: string[]; untrackedFiles: string[]; remedy: string } }>>
```

3. `project-owner-execution-ipc.ts` 中注册：

```ts
  ipc.handle(PROJECT_IPC_CHANNELS.RECHECK_OWNER_DEVELOPMENT_WORKSPACE, (_, request) => result(() => {
    const value = ownerExecutionObject(request, ['projectId', 'taskId', 'executionId'])
    const subject = parseOwnerExecutionSubject({ projectId: value.projectId, ...(value.taskId === undefined ? {} : { taskId: value.taskId }) })
    const execution = store.getAgentExecution(String(value.executionId))
    if (!execution || execution.projectId !== subject.projectId) throw new Error('执行不属于当前项目')
    const meta = getAgentSessionMeta(execution.sessionId)
    const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
    if (!workspace?.rootPath) throw new Error('执行工作区已失效，无法重新核对')
    const blocker = inspectDevelopmentWorkspaceBlocker(workspace.rootPath, workspace.id, workspace.name)
    if (blocker.kind === 'ready') {
      // 只恢复「从未认领」的排队准备；已认领或已有会话的执行仍需人工核对，不在这里重放。
      recoverUnclaimedOwnerCommandPreparations(Date.now(), execution.id)
      return { state: 'clean' as const }
    }
    if (blocker.kind === 'not_git_root') return { state: 'blocked' as const, blocker: { kind: blocker.kind, detail: blocker.detail, trackedFiles: [], untrackedFiles: [], remedy: '请把工作区指向 Git 仓库根目录后重试。' } }
    return { state: 'blocked' as const, blocker: { kind: blocker.kind, detail: blocker.detail, trackedFiles: blocker.trackedFiles, untrackedFiles: blocker.untrackedFiles, remedy: blocker.remedy } }
  }))
```

4. `preload/index.ts` 中按现有 `PROJECT_IPC_CHANNELS.*` 模式暴露 `recheckOwnerDevelopmentWorkspace`。

- [ ] **Step 7: 运行测试确认通过**

Run: `cd apps/electron && bun test src/main/lib/development-workspace-blocker.test.ts src/main/lib/agent-development-worktree.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
cd packages/shared && npm pkg set version=0.2.166 && cd ../..
git add apps/electron/src/main/lib/development-workspace-blocker.ts apps/electron/src/main/lib/development-workspace-blocker.test.ts apps/electron/src/main/lib/agent-development-worktree.ts apps/electron/src/main/lib/agent-employee-service.ts apps/electron/src/main/lib/project-owner-execution-ipc.ts apps/electron/src/preload/index.ts packages/shared/src/types/work-module.ts packages/shared/src/types/project-owner.ts packages/shared/package.json
git commit -m "feat(owner): 研发工作区阻塞项可核对、可重新检查"
```

---

## Task 7: 说法与真实动作一致 + 单一阻塞提示

**Files:**
- Modify: `apps/electron/src/main/lib/project-owner-claim-audit.ts`
- Create: `apps/electron/src/renderer/components/projects/project-owner-execution-attention.ts`
- Create: `apps/electron/src/renderer/components/projects/OwnerExecutionBlockerNotice.tsx`
- Modify: `apps/electron/src/renderer/components/projects/OwnerManagementConversation.tsx`
- Modify: `apps/electron/src/renderer/components/projects/ProjectOwnerExecutionConversation.tsx`
- Test: `apps/electron/src/main/lib/project-owner-claim-audit.test.ts`、`apps/electron/src/renderer/components/projects/project-owner-execution-attention.test.ts`

- [ ] **Step 1: 写失败测试（主进程侧）**

在 `project-owner-claim-audit.test.ts` 追加：

```ts
test('Given只有建议没有安排 WhenOwner说将重新安排 Then判为无事实支撑', () => {
  const facts: OwnerClaimFacts = { pendingEvents: 0, runningExecutions: 0, queuedCommands: 0, awaitingUserDecisions: 0 }
  const content = '我将在后台重新安排这次研发任务。'
  expect(findOwnerClaimViolations([{ role: 'assistant', kind: 'reply', content, createdAt: 1 }], facts)).toHaveLength(1)
})

test('Given确有排队命令 WhenOwner说将重新安排 Then不判违规', () => {
  const facts: OwnerClaimFacts = { pendingEvents: 0, runningExecutions: 0, queuedCommands: 1, awaitingUserDecisions: 0 }
  expect(findOwnerClaimViolations([{ role: 'assistant', kind: 'reply', content: '我将在后台重新安排这次研发任务。', createdAt: 1 }], facts)).toHaveLength(0)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/electron && bun test src/main/lib/project-owner-claim-audit.test.ts`
Expected: FAIL — `queuedCommands` 不存在 / 将来时说法未被标记

- [ ] **Step 3: 扩展事实与说法模式**

在 `project-owner-claim-audit.ts` 中：

1. `OwnerClaimFacts` 增加：

```ts
  /** 已排队但尚未启动的 Owner 命令数；这是“已安排”的事实依据。 */
  queuedCommands: number
```

2. `BACKGROUND_CLAIM_PATTERNS` 增加：

```ts
  /(?:我)?(?:会|将|马上|立即)(?:在后台)?(?:重新)?(?:安排|派发|启动|执行|推进)/,
  /(?:已|正在)(?:在后台)?(?:安排|派发)/,
```

3. `stripUnsupportedClaims` 与 `findOwnerClaimViolations` 的事实判定改为：

```ts
  const hasBackgroundWork = facts.pendingEvents > 0 || facts.runningExecutions > 0 || facts.queuedCommands > 0
```

4. `readOwnerClaimFacts` 增加：

```ts
    queuedCommands: (db.prepare("SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE project_id=? AND state='queued'").get(projectId) as { count: number }).count,
```

5. 同步修正既有测试里的 `OwnerClaimFacts` 字面量（`project-owner-claim-audit.test.ts` 中 4 处），补 `queuedCommands: 0`。

- [ ] **Step 4: 写失败测试（渲染侧共享选择器）**

```ts
import { expect, test } from 'bun:test'
import { deriveOwnerExecutionAttention } from './project-owner-execution-attention'

test('Given授权暂停且有失败命令 When推导 Then给出阻塞原因与可用操作', () => {
  const state = deriveOwnerExecutionAttention({
    grantState: 'paused', scheduleState: null, nextAction: null,
    commands: [{ state: 'settled', executionStatus: 'failed', taskTitle: '实现页面', terminalEvidence: { reason: 'provider_stop' } }],
    completed: false,
  })
  expect(state).toMatchObject({ blocked: true, title: '研发执行未完成，需要核对' })
  expect(state?.actions.join()).toContain('查看失败证据')
})

test('Given一切正常 When推导 Then没有阻塞', () => {
  expect(deriveOwnerExecutionAttention({ grantState: 'active', scheduleState: 'running', nextAction: null, commands: [], completed: false })).toBeNull()
})
```

- [ ] **Step 5: 实现共享选择器**

```ts
import type { OwnerExecutionCommandView } from '@gravitas/shared'

export interface OwnerExecutionAttentionInput {
  grantState: string | null | undefined
  scheduleState: string | null | undefined
  nextAction: string | null | undefined
  commands: ReadonlyArray<Pick<OwnerExecutionCommandView, 'state' | 'executionStatus' | 'taskTitle'> & { terminalEvidence?: { reason: string } }>
  completed: boolean
}

export interface OwnerExecutionAttention {
  blocked: true
  title: string
  detail: string
  actions: string[]
}

/** 执行阻塞的唯一推导入口：对话区与执行区必须共用，避免一处说“暂无事项”、另一处说“已阻塞”。 */
export function deriveOwnerExecutionAttention(input: OwnerExecutionAttentionInput): OwnerExecutionAttention | null {
  if (input.completed) return null
  const failed = input.commands.find(command => command.state === 'settled' && command.executionStatus === 'failed')
  const blockedByGrant = input.grantState === 'paused' || input.grantState === 'needs_reconcile'
  const blockedBySchedule = input.scheduleState === 'needs_reconcile' || input.scheduleState === 'stale' || input.scheduleState === 'expired'
  if (!failed && !blockedByGrant && !blockedBySchedule) return null
  return {
    blocked: true,
    title: failed?.terminalEvidence?.reason === 'output_limit' ? '研发执行达到输出上限，需要核对' : failed ? '研发执行未完成，需要核对' : '执行授权暂停，需要核对',
    detail: failed ? `「${failed.taskTitle}」没有形成可用成果；已完成的步骤与费用记录都已保留。` : '当前授权不能继续派发新工作，已有记录保留。',
    actions: ['查看失败证据', '核对工作区与费用', '确认后重新安排剩余步骤'],
  }
}
```

- [ ] **Step 6: 统一提示组件并接入两个组件**

新建 `OwnerExecutionBlockerNotice.tsx`（受控展示组件，不自行取数）：

```tsx
import type { OwnerExecutionAttention } from './project-owner-execution-attention'

export function OwnerExecutionBlockerNotice({ attention, onOpenEvidence }: { attention: OwnerExecutionAttention; onOpenEvidence?: () => void }): React.ReactElement {
  return <section role="alert" aria-label="执行阻塞" className="space-y-2 rounded-xl bg-amber-500/10 p-3 text-sm">
    <p className="font-medium">{attention.title}</p>
    <p className="leading-6">{attention.detail}</p>
    <ul className="list-disc pl-5 text-xs text-muted-foreground">{attention.actions.map(action => <li key={action}>{action}</li>)}</ul>
    {onOpenEvidence && <button type="button" className="text-primary underline" onClick={onOpenEvidence}>查看失败证据与工作区</button>}
  </section>
}
```

在 `OwnerManagementConversation.tsx`：

1. 导入 `ownerCommandProgressAtom` / `getOwnerCommandProgress` 与 `deriveOwnerExecutionAttention`、`OwnerExecutionBlockerNotice`。
2. 在组件内取同一 subject 的 progress：

```ts
  const commandProgress = useAtomValue(useMemo(() => atom(get => getOwnerCommandProgress(get(ownerCommandProgressAtom), subject)), [subject]))
  const executionAttention = deriveOwnerExecutionAttention({
    grantState: grant.grant?.state, scheduleState: commandProgress.schedule?.state, nextAction: commandProgress.schedule?.nextAction,
    commands: commandProgress.commands, completed: Boolean(grant.grant?.dispatchMode === 'autonomous' && hasCompletedOwnerDelivery(messages, commandProgress.commands, taskId, plan.snapshot?.planVersion, grant.grant?.grantId)),
  })
```

3. 「暂无待你决定的事项」的渲染条件追加 `&& !executionAttention`。
4. 在 `waitingForDecision` 区块之后渲染：

```tsx
          {executionAttention && <OwnerExecutionBlockerNotice attention={executionAttention} onOpenEvidence={() => revealDiscussionTarget('owner-project-progress')} />}
```

5. `currentStatus` 的推导中，在 `delegation.view?.state === 'attention'` 之前插入 `: executionAttention ? executionAttention.title`。

在 `ProjectOwnerExecutionConversation.tsx`：把 `ownerNeedsAttention` 的推导替换为 `const executionAttention = deriveOwnerExecutionAttention({...})`，保留原三元表达式的其余分支，并把第 237 行的自定义提示替换为 `<OwnerExecutionBlockerNotice attention={executionAttention} />`。

- [ ] **Step 7: 运行测试确认通过**

Run: `cd apps/electron && bun test src/main/lib/project-owner-claim-audit.test.ts src/renderer/components/projects/project-owner-execution-attention.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
cd packages/shared && npm pkg set version=0.2.167 && cd ../..
git add apps/electron/src/main/lib/project-owner-claim-audit.ts apps/electron/src/main/lib/project-owner-claim-audit.test.ts apps/electron/src/renderer/components/projects/project-owner-execution-attention.ts apps/electron/src/renderer/components/projects/project-owner-execution-attention.test.ts apps/electron/src/renderer/components/projects/OwnerExecutionBlockerNotice.tsx apps/electron/src/renderer/components/projects/OwnerManagementConversation.tsx apps/electron/src/renderer/components/projects/ProjectOwnerExecutionConversation.tsx packages/shared/package.json
git commit -m "fix(owner): Owner说法与真实动作一致，执行阻塞单一提示"
```

---

## Task 8: 证据展示（工作记录 + 命令面板）

**Files:**
- Create: `apps/electron/src/renderer/components/projects/OwnerExecutionTerminalEvidence.tsx`
- Modify: `apps/electron/src/renderer/components/projects/ProjectOwnerConversationProgress.tsx`
- Modify: `apps/electron/src/renderer/components/projects/ProjectOwnerExecutionCommandPanel.tsx`
- Test: `apps/electron/src/renderer/components/projects/OwnerExecutionTerminalEvidence.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OwnerExecutionTerminalEvidence } from './OwnerExecutionTerminalEvidence'

test('GivenProvider异常终态 When渲染 Then展示原始终止原因、工具完成情况与费用状态', () => {
  const html = renderToStaticMarkup(<OwnerExecutionTerminalEvidence evidence={{
    schemaVersion: 1, executionId: 'e', commandId: 'c', role: 'executor', executionStatus: 'failed',
    provider: { subtype: 'error_during_execution', finishReason: 'other', requestId: 'req-1', responseId: null },
    reason: 'provider_stop', detail: 'Owner模型未完整结束', tools: { calls: 3, results: 3, lastToolName: 'Edit', lastResultStatus: 'ok', incompleteBatch: false },
    cost: { state: 'settled', actualCostMicros: 12345, requestCount: 2 },
    development: { worktreePath: '/tmp/w', baseCommit: 'a'.repeat(40), changedFiles: ['index.html'], untrackedFiles: ['new.css'] }, capturedAt: 1,
  }} />)
  expect(html).toContain('error_during_execution')
  expect(html).toContain('other')
  expect(html).toContain('已结算')
  expect(html).toContain('index.html')
  expect(html).toContain('new.css')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/electron && bun test src/renderer/components/projects/OwnerExecutionTerminalEvidence.test.tsx`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现展示组件**

```tsx
import type { OwnerTerminalEvidence } from '@gravitas/shared'

const reasonLabels: Record<OwnerTerminalEvidence['reason'], string> = {
  provider_stop: '服务商提前结束响应', output_limit: '达到模型输出上限', tool_call_incomplete: '工具调用未完成',
  runtime_error: '运行时异常', stopped_by_user: '你请求了停止', no_output: '没有返回任何输出', unknown: '原因未知（保留原记录）',
}

export function OwnerExecutionTerminalEvidence({ evidence }: { evidence: OwnerTerminalEvidence }): React.ReactElement {
  const usd = evidence.cost.actualCostMicros === null ? '未知' : `${(evidence.cost.actualCostMicros / 1_000_000).toFixed(4)} 美元`
  return <details className="rounded-lg bg-muted/40 p-3 text-xs" aria-label="执行终止证据">
    <summary className="cursor-pointer font-medium">执行终止证据（只读）</summary>
    <dl className="mt-2 grid gap-1 sm:grid-cols-2">
      <div><dt className="text-muted-foreground">归一化原因</dt><dd>{reasonLabels[evidence.reason]}</dd></div>
      <div><dt className="text-muted-foreground">服务商终态</dt><dd>{evidence.provider ? `${evidence.provider.subtype ?? '—'} / ${evidence.provider.finishReason ?? '—'}` : '未收到终态回执'}</dd></div>
      <div><dt className="text-muted-foreground">服务商请求编号</dt><dd className="break-all">{evidence.provider?.requestId ?? '本地没有保存'}</dd></div>
      <div><dt className="text-muted-foreground">工具调用</dt><dd>{evidence.tools.calls} 次调用 / {evidence.tools.results} 次结果{evidence.tools.incompleteBatch ? '（有未完成调用）' : ''}{evidence.tools.lastToolName ? ` · 最后一次：${evidence.tools.lastToolName}` : ''}</dd></div>
      <div><dt className="text-muted-foreground">费用</dt><dd>{evidence.cost.state === 'settled' ? `已结算 ${usd}` : '未知（保留占额）'} · 请求 {evidence.cost.requestCount} 次</dd></div>
      <div className="sm:col-span-2"><dt className="text-muted-foreground">说明</dt><dd>{evidence.detail}</dd></div>
    </dl>
    {evidence.development && <div className="mt-2 space-y-1">
      <p className="text-muted-foreground">工作树：<span className="break-all">{evidence.development.worktreePath ?? '未绑定'}</span> · 基线 {evidence.development.baseCommit?.slice(0, 12) ?? '未知'}</p>
      <p>已跟踪改动：{evidence.development.changedFiles.length ? evidence.development.changedFiles.join('、') : '无'}</p>
      <p>未跟踪文件：{evidence.development.untrackedFiles.length ? evidence.development.untrackedFiles.join('、') : '无'}</p>
    </div>}
    <p className="mt-2 text-muted-foreground">这些是本地保存的核对依据，不代表已确认账单，也不是执行许可。</p>
  </details>
}
```

- [ ] **Step 4: 挂载到两处**

- `ProjectOwnerConversationProgress.tsx` 的 `DeliveryResultCard` 内、`{command.technicalReview && ...}` 之前：`{command.terminalEvidence && <OwnerExecutionTerminalEvidence evidence={command.terminalEvidence} />}`
- `ProjectOwnerExecutionCommandPanel.tsx` 的 `OwnerExecutionReviewDetails` 内、`{command.technicalReview && ...}` 之前：同样一行。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/electron && bun test src/renderer/components/projects/OwnerExecutionTerminalEvidence.test.tsx src/renderer/components/projects/ProjectOwnerExecutionCommandPanel.test.tsx`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
cd packages/shared && npm pkg set version=0.2.168 && cd ../..
git add apps/electron/src/renderer/components/projects/OwnerExecutionTerminalEvidence.tsx apps/electron/src/renderer/components/projects/OwnerExecutionTerminalEvidence.test.tsx apps/electron/src/renderer/components/projects/ProjectOwnerConversationProgress.tsx apps/electron/src/renderer/components/projects/ProjectOwnerExecutionCommandPanel.tsx packages/shared/package.json
git commit -m "feat(owner): 在员工工作记录与命令面板展示终止证据"
```

---

## Task 9: 真实案例验收（自动化 + 隔离项目）

**Files:**
- Create: `apps/electron/src/main/lib/project-owner-mixed-batch-journey.test.ts`
- Modify: `apps/electron/src/renderer/components/projects/ProjectOwnerRealCaseJourney.integration.browser.test.ts`（追加断言）

- [ ] **Step 1: 写主进程端到端用例（规格完成 + 评审完成 + 研发失败 → 恢复 → 新执行）**

```ts
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-mixed-journey-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))

const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const mixed = await import('./project-owner-mixed-batch-recovery')

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

test('Given真实混合批次 When接替 Then已验收步骤不重跑、失败步骤可追溯、旧记录保留', async () => {
  // 复用 project-owner-execution-stage-b.test.ts 的 fixture 构造两条任务（文本 + 研发）与三条命令，
  // 把研发 executor 置为 settled + failed + 终端证据，文本两条置为 settled + completed 并写入已验收质量动作。
  // 断言：
  // 1) mixed.readMixedBatchAssessment(...) 返回 ok 且 retainedTaskIds 含文本任务；
  // 2) planMixedBatchSupersession(...) 后旧 grant 为 paused；recordMixedBatchSupersession(...) 后接替记录可读；
  // 3) 新批次只包含失败步骤对应任务，旧任务与命令计数不变；
  // 4) 旧命令的 terminalEvidence 仍可读。
  expect(true).toBe(true)
})
```

> 实现时把上面测试体替换为对 `fixture` 的真实调用（可复制 `project-owner-execution-stage-b.test.ts` 的 `fixture()` 与 `waitForExecutionTerminal`，只保留必要参数），**不要**保留 `expect(true).toBe(true)`。

- [ ] **Step 2: 运行确认失败再实现**

Run: `cd apps/electron && bun test src/main/lib/project-owner-mixed-batch-journey.test.ts`
Expected: 先 FAIL（断言未写完），补全后 PASS

- [ ] **Step 3: 追加渲染断言**

在 `ProjectOwnerRealCaseJourney.integration.browser.test.ts` 的「研发失败」相关用例中断言：

```ts
    // 主区域与风险区不能同时出现“暂无待你决定”和“执行阻塞”。
    expect(await page.getByText('暂无待你决定的事项').isVisible().catch(() => false)).toBe(false)
    await expect(page.getByLabel('执行阻塞')).toBeVisible()
    await expect(page.getByLabel('执行终止证据')).toBeVisible()
```

- [ ] **Step 4: 运行渲染用例**

Run: `cd apps/electron && bun test src/renderer/components/projects/ProjectOwnerRealCaseJourney.integration.browser.test.ts`
Expected: PASS（无 Chromium 时自动 skip，需在本地有 Playwright 浏览器时执行）

- [ ] **Step 5: 全量质量门**

```bash
bun run typecheck
bun run test -- project-owner
```

Expected: typecheck 无错误；Owner 相关测试文件全部通过（既有失败需按 `electron-bun-test-baseline` skill 先判定基线）。

- [ ] **Step 6: 提交**

```bash
cd packages/shared && npm pkg set version=0.2.169 && cd ../..
git add apps/electron/src/main/lib/project-owner-mixed-batch-journey.test.ts apps/electron/src/renderer/components/projects/ProjectOwnerRealCaseJourney.integration.browser.test.ts packages/shared/package.json
git commit -m "test(owner): 以真实混合批次案例验收恢复链路"
```

- [ ] **Step 7: 隔离项目人工验收（交付前必做）**

1. `cd apps/electron && bun run dist:dev`（Dev 渠道，使用 `.gravitas-dev`，不碰原 userData）。
2. 新建隔离项目，工作区指向一个全新 git 仓库副本（原项目的未跟踪文件保持不动）。
3. 在 Owner 对话中提交目标，等待规划 → 安排 → 执行。
4. 人为制造研发失败（例如在目标要求中给出模型无法满足的验证命令），确认：
   - 「需要你决定」区域显示执行阻塞而不是「暂无待你决定的事项」；
   - 员工工作记录里出现执行终止证据（服务商终态、工具调用、费用、工作树）；
   - 清理工作区后点击「重新核对工作区」可以继续；
   - 恢复后新的研发执行真实产生构建、测试、独立评审与 Owner 质量验收。
5. 记录未覆盖的真实休眠行为（如跨进程崩溃恢复、Provider 侧限流）到 `docs/plans/2026-10-07-ai-project-owner/ledger.md`，交付说明中列出。

---

## Self-Review

**1. 规格覆盖**

| 规格条目 | 对应任务 |
|---|---|
| 1. 保存 Provider 原始终止原因与请求 ID、归一化原因 | Task 1、2、3 |
| 1. 已完成的工具调用、最后一次工具结果、是否仍有未完成调用 | Task 1、2、8 |
| 1. 费用是否已结算、工作树位置与当前文件状态 | Task 1、2、3、8 |
| 1. 诊断数据不得包含密钥或不必要正文 | Task 1（`sanitizeOwnerDiagnostic`） |
| 2. 混合批次恢复流程（核对/保留/恢复点/阻断/关联） | Task 4、5 |
| 2. 旧授权仍为 active 时通过明确状态转换续接 | Task 4（`previewOwnerExecutionGrantRevoke` + `confirm...`） |
| 3. 工作区阻塞可展示、可操作、可重新核对 | Task 6 |
| 3. 不自动提交、不隐藏用户文件 | Task 6（`remedy` 文案 + 只读检查） |
| 4. 回复与真实动作一致 | Task 7（`queuedCommands` 事实 + 将来时模式） |
| 4. 界面矛盾（暂无待办 vs 执行阻塞） | Task 7（共享选择器） |
| 5. 真实案例验收（混合批次/阻断/干净与脏仓库/异常终态） | Task 9 + Task 4/6 单测 |
| 5. 隔离项目交付与未覆盖项说明 | Task 9 Step 7 |

**2. 占位符扫描**：Task 9 Step 1 的测试体以注释描述断言，实现时必须替换为真实 fixture 调用（已在步骤中显式提醒）；其余步骤均含可执行代码。

**3. 类型一致性**：`OwnerTerminalEvidence` 在 Task 1 定义，Task 2/3/8 复用同一字段名（`provider`、`reason`、`tools`、`cost`、`development`、`capturedAt`）；`MixedBatchAssessment` 在 Task 4 定义并在 Task 5/9 复用；`OwnerClaimFacts.queuedCommands` 在 Task 7 统一定义并被测试与 `readOwnerClaimFacts` 共用。
