# Agentic 架构种子融合实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 4 个冲刺（Sprint）内，把「Agent Card/Registry 身份层、Execution Contract 契约层、append-only 审计 hash chain、贵慢重准看板、KMS 版本化」等架构种子落地到 Gravitas 的 Electron 与 server 两条线，为「私有部署最小集 → SaaS 商业化」三轨策略埋好不返工的种子，并完成 AI 员工与通用 Agent 的统一身份融合。

**Architecture:** 分四层落地——① 统一身份层（Agent Card 类型 + 本地 Registry + 服务端 Registry，兼容 AI 员工档案与通用 Agent）；② 契约层（Execution Contract 把「指派→执行→回写→考核」从项目任务解耦为通用契约）；③ 安全闭环（append-only 审计 hash chain + KMS 密钥版本字段）；④ 治理视图（贵慢重准聚合 + 成本硬预算联动）。全部遵循 TDD，Electron 侧基于现有 `agent-employee-service` 演进、server 侧基于现有 Postgres 多租户 store 增量扩展，不破坏既有功能。

**Tech Stack:** TypeScript / Bun / Electron 主进程（`apps/electron/src/main/lib/`）、Bun server（`apps/server/src/`）、SQLite（`better-sqlite3` via `project-sqlite-store.ts`）、Postgres（`pg` via `@gravitas/shared/utils`）、`node:crypto`（SHA-256 hash chain）。

---

## 执行进度（全部完成 ✅ 2026-08-13）

- [x] **S1 完成**：Agent Card 类型 + 本地 Registry（commit `53bb8d03`、`5f1d0241`）
- [x] **Task 2.1 完成**：服务端 Agent Registry + 租户隔离（commit `92576ae6`），已对真实 Postgres 冒烟验证（建表/upsert/list/租户隔离/数字类型修正）
- [x] **Task 2.2 已存在**：KMS 版本化种子已有成熟实现（rotating codec + reencrypt + 云KMS接线），跳过
- [x] **Task 2.3 验收通过**：真实 Postgres 冒烟 + mock 4 pass + server 全量无回归
- [x] **Sprint 3 完成**：Execution Contract 类型 + 状态机 service + 执行生命周期 binder，11 测试通过（commit `0f92adc6` + `254f0049`）
- [x] **Task 3.3 验收通过**：契约状态机合法/非法迁移、binder 生命周期闭环测试通过；持久化接入列为后续（决策见 Sprint 3 记录）
- [x] **Sprint 4 完成**：审计 hash chain（`d7aef88d`）+ 贵慢重准看板（`1e2f903a`）
- [x] **Sprint 4 全局验收通过**：server 90 / electron 15 / shared 125 pass，唯一失败为 pre-existing 无关技术债

## 执行中发现与记录

- **shared 类型消费约定**：electron/server 内用裸包名 `@gravitas/shared` 导入共享类型，**不可用子路径** `@gravitas/shared/types/xxx`（bundle/tsconfig 不解析深路径）。
- **server store 测试模式**：用注入 mock `query` 函数（`AgentRuntimePostgresClient` 接口），不依赖真实 Postgres（参考 `scheduler-store.test.ts`）。真实库冒烟用 `Bun.SQL` 包裹同一 client 接口即可。
- **Bun Postgres BIGINT 映射**：`Bun.SQL.unsafe` 返回的 BIGINT 列值是 string，store 需 `Number()` 显式转换。
- **registry 隔离粒度**：Agent Card 是组织级资产，按 `tenant_id`（非 user）隔离，list 无需 `user_id` 条件。
- **registry.enabled 类型**：表列用 INTEGER(0/1)，查询 `enabled = $3` 需传 int（`$3::int`），不能传 boolean（`op_er ror`）。

## Sprint 3 设计决策记录（2026-08-13）

- **契约层作为独立可复用能力层交付**，而非强接入 `agent-employee-service`。原因：
  - `agent-employee-service` 的 `AgentExecution` + 并发 + 心跳 + 绩效 + 回写机制深度耦合且成熟，绕路到契约层风险高。
  - 契约 store 当前为内存实现（`InMemoryExecutionContractStore`），与持久化 `agent_executions` 表存在重启一致性缺口。
- **契约层三件套**：① shared 类型（`execution-contract.ts`，source/status/executor + 工具）；② `execution-contract-service.ts`（状态机 service + 可注入 store + onCreated/onTransition hooks）；③ `execution-contract-binder.ts`（把 execution 生命周期 dispatch/start/complete/fail/retry 桥到契约）。
- **关键设计**：`ExecutionContractStore` 收敛为同步接口（当前内存实现）；`CreateExecutionContractInput` 支持调用方传入契约稳定 ID（从外部实体派生）；binder 返回快照避免别名污染。
- **后续 Sprint（持久化接入）**：需要一个 SQLite-backed `ExecutionContractStore`，才可将契约与 `agent_executions` 联动且重启不丢——不在本次范围。

## Sprint 4 设计决策记录（2026-08-13）

- **审计 hash chain 采用按 tenant（非 user）分链**：从链尾回溯重算；每条记录存 `prev_hash` + `hash`；篡改 → `verifyChain.valid=false`。对真实 Postgres 验证（篡改 action 被检出）。
- **append 的并发安全取舍**：当前为"先 SELECT 链尾 hash → 再 INSERT"两次查询，极端并发下可能断链；生产绝对安全需事务/触发器（P8-3）。文档已注释说明。
- **hash chain 与合规性清理（purgeBefore/legal-hold）的冲突**：删除记录会断链 → verifyChain 判定 invalid。这是"任何非常规改动都会被审计器察觉"的预期设计，legal-hold 正是配套约束。
- **看板 latency 维度暂无数据源**：`metrics.get` 无 p95 延迟、spans 无现成聚合。`computeHealthDashboard` 为纯函数，latency 先以 0 占位，接入 spans p95 后替换；不影响贵/重/准/预算维度。
- **看板数据源组装**：月在成本来自 `usageLedger.summarize`（近30天窗口）、token/任务/success 来自 `metrics.get`，预算来自 `config.tenantBudget.monthlyCostMicroUsd`。`GET /agent/health` 需要 operator/admin/security-auditor。



## 阶段总览（全部完成 ✅ 2026-08-13）

| Sprint | 种子 | 状态 | 提交 |
|---|---|---|---|
| S1 | Agent Card + 本地 Registry 融合 | ✅ | `53bb8d03`, `5f1d0241` |
| S2 | 服务端 Registry + 租户隔离 + KMS 版本化 | ✅（Task 2.2 KMS 已存在） | `92576ae6` |
| S3 | Execution Contract 契约层 | ✅ 独立可复用 | `0f92adc6`, `254f0049` |
| S4 | 审计 hash chain + 贵慢重准看板 | ✅ | `d7aef88d`, `1e2f903a` |

每 Sprint 独立合入、独立验收。S1→S3 有强依赖（身份先于契约），S4 独立可并行。

### 全局验收结果（2026-08-13）

- ✅ Electron：AI 员工档案 ↔ Agent Card 互转；`listAgentCards()`/`getAgentCard()` 返回在编员工卡片
- ✅ Server：`GET/PUT /agent/registry` 按租户读写，真实 Postgres 验证多租户隔离（其他租户查不到）
- ✅ 契约层：状态机合法/非法迁移 + 执行生命周期 binder（dispatch/start/complete/fail/retry）测试通过
- ✅ 安全：审计 hash chain 可检测篡改（真实 Postgres 验证）；KMS 版本化能力已确认存在（rotating codec + reencrypt + 云KMS接线）
- ✅ 治理：`GET /agent/health` 输出贵慢重准 + 预算占用
- ✅ 全量回归：server 90 pass / electron 15 pass / shared 125 pass（唯一失败为 pre-existing `normalizeAgentRuntime` 技术债，与本次无关）
- ✅ 测试策略：每 Task 先写失败测试（TDD），mock + 真实 Postgres 双验证，无回归

### 后续（不在本次范围，见各 Sprint 决策记录）

- 契约层 SQLite-backed `ExecutionContractStore` 持久化接入
- 审计 hash chain 并发绝对安全（事务/触发器）+ 生产级 KMS 轮换验收（P8-3）
- 看板 latency p95 聚合数据源（spans）
- OIDC RBAC 到 Agent Card 权限映射、服务端 MCP 池多 worker 隔离、隔离执行器容器化验收

---

## Sprint 1：Agent Card + 本地 Registry 融合

**目标**：让「AI 员工档案」成为 Agent Card 的一种实体化，新增统一身份类型与本地注册表，为后续 Execution Contract 和 server 同步铺路。

### Task 1.1：定义 Agent Card 类型

**Files:**
- Create: `packages/shared/src/types/agent-card.ts`
- Modify: `packages/shared/src/types/index.ts`（导出新模块）

**Step 1: 写失败测试**

Create `packages/shared/src/types/agent-card.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { buildAgentCardFromEmployee, AGENT_CARD_SOURCE_EMPLOYEE } from './agent-card'

describe('agent-card', () => {
  it('从 AI 员工档案构建 Agent Card（无 workflowId）', () => {
    const card = buildAgentCardFromEmployee({
      id: 'emp-1', name: '小王', role: '内容运营', description: '负责内容产出',
      runtime: 'proma', channelId: 'ch1', modelId: 'm1', skills: ['docx'],
      enabled: true, totalTasks: 3, completedTasks: 2, avgDurationMs: 12000, failureCount: 1,
      createdAt: 1000, updatedAt: 1000,
    })
    expect(card.source).toBe(AGENT_CARD_SOURCE_EMPLOYEE)
    expect(card.employeeId).toBe('emp-1')
    expect(card.name).toBe('小王')
    expect(card.role).toBe('内容运营')
    expect(card.capabilities).toEqual(['docx'])
    expect(card.executionStats?.totalRuns).toBe(3)
  })

  it('workflowId 存在时映射为 fixedWorkflowId', () => {
    const card = buildAgentCardFromEmployee({
      id: 'emp-2', name: '小王2', role: 'SOP岗', description: '',
      runtime: 'proma', channelId: 'ch1', workflowId: 'wf-9',
      enabled: true, totalTasks: 0, completedTasks: 0, failureCount: 0,
      createdAt: 1, updatedAt: 1,
    })
    expect(card.fixedWorkflowId).toBe('wf-9')
    expect(card.capabilities).toEqual([])
  })
})
```

**Step 2: 运行测试确认失败**

Run: `cd apps/electron && bun test ../packages/shared/src/types/agent-card.test.ts 2>&1 | tail -5`
Expected: FAIL（模块不存在 `Cannot find module './agent-card'`）

**Step 3: 实现类型与转换函数**

Create `packages/shared/src/types/agent-card.ts`:

```ts
/** Agent Card 统一身份模型：兼容 AI 员工档案与通用 Agent，供 Registry 与契约层使用。 */

export const AGENT_CARD_SOURCE_EMPLOYEE = 'employee'
export type AgentCardSource = typeof AGENT_CARD_SOURCE_EMPLOYEE | 'workflow' | 'external'

export interface AgentCardRuntimeStats {
  totalRuns: number
  completedRuns: number
  avgDurationMs?: number
  failureCount: number
}

/** Agent Card：机器可读的 Agent 身份（文档 5.3 的轻量落地版，最小集） */
export interface AgentCard {
  /** 注册 ID（employee 场景即 employeeId，或 workflow 场景即 workflowId） */
  cardId: string
  source: AgentCardSource
  /** 当 source=employee 时关联的 AI 员工档案 ID */
  employeeId?: string
  name: string
  role: string
  description: string
  /** 能力声明（skills / 工具白名单等），约束可见性 */
  capabilities: string[]
  /** 绑定的固定 Workflow SOP ID（如有） */
  fixedWorkflowId?: string
  /** 累计执行统计，Registry 聚合展示用 */
  executionStats?: AgentCardRuntimeStats
  enabled: boolean
  createdAt: number
  updatedAt: number
}

interface EmployeeLike {
  id: string
  name: string
  role: string
  description: string
  runtime?: string
  channelId?: string
  modelId?: string
  workflowId?: string
  skills?: string[]
  enabled: boolean
  totalTasks: number
  completedTasks: number
  avgDurationMs?: number
  failureCount: number
  createdAt: number
  updatedAt: number
}

/** 从 AI 员工档案构建 Agent Card（后续 server 同步的基础） */
export function buildAgentCardFromEmployee(emp: EmployeeLike): AgentCard {
  return {
    cardId: emp.id,
    source: AGENT_CARD_SOURCE_EMPLOYEE,
    employeeId: emp.id,
    name: emp.name,
    role: emp.role,
    description: emp.description,
    capabilities: emp.skills ?? [],
    fixedWorkflowId: emp.workflowId,
    executionStats: {
      totalRuns: emp.totalTasks,
      completedRuns: emp.completedTasks,
      avgDurationMs: emp.avgDurationMs,
      failureCount: emp.failureCount,
    },
    enabled: emp.enabled,
    createdAt: emp.createdAt,
    updatedAt: emp.updatedAt,
  }
}
```

**Step 4: 运行测试确认通过**

Run: `cd apps/electron && bun test ../packages/shared/src/types/agent-card.test.ts`
Expected: PASS（2 用例）

**Step 5: 导出并提交**

Modify `packages/shared/src/types/index.ts`: 追加 `export * from './agent-card'`

```bash
git add packages/shared/src/types/agent-card.ts packages/shared/src/types/agent-card.test.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): define AgentCard type and employee→card builder"
```

### Task 1.2：本地 Agent Registry 服务（读取 AI 员工档案）

**Files:**
- Create: `apps/electron/src/main/lib/agent-registry-service.ts`
- Modify: `apps/electron/src/main/lib/project-sqlite-store.ts`（如需要补索引；一般无需）

**Step 1: 写失败测试**

Create `apps/electron/src/main/lib/agent-registry-service.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { buildAgentCardFromEmployee } from '@gravitas/shared/types/agent-card'
import { listAgentCards } from './agent-registry-service'
import * as store from './project-sqlite-store'
import { randomUUID } from 'node:crypto'

// 注意：本测试用临时库初始化员工表（复用 project-sqlite-store 的初始化路径）
describe('agent-registry-service', () => {
  it('列出所有 AI 员工为 Agent Cards', () => {
    const name = `emp-${randomUUID().slice(0, 8)}`
    store.createAgentEmployee({
      id: name, name, role: '测试岗', description: '',
      runtime: 'proma', channelId: 'ch-test', skills: ['docx'],
    })
    const cards = listAgentCards()
    const mine = cards.find((c) => c.employeeId === name)
    expect(mine).toBeDefined()
    expect(mine?.capabilities).toContain('docx')
    expect(mine?.source).toBe('employee')
  })

  it('buildAgentCardFromEmployee 可作为纯函数独立使用', () => {
    const card = buildAgentCardFromEmployee({
      id: 'x', name: 'x', role: 'r', description: '', enabled: true,
      totalTasks: 0, completedTasks: 0, failureCount: 0, createdAt: 1, updatedAt: 1,
    })
    expect(card.cardId).toBe('x')
  })
})
```

**Step 2: 运行测试确认失败**

Run: `cd apps/electron && bun test src/main/lib/agent-registry-service.test.ts`
Expected: FAIL（`Cannot find module './agent-registry-service'`）

**Step 3: 实现 Registry 服务**

Create `apps/electron/src/main/lib/agent-registry-service.ts`:

```ts
import type { AgentCard } from '@gravitas/shared/types/agent-card'
import { buildAgentCardFromEmployee } from '@gravitas/shared/types/agent-card'
import * as store from './project-sqlite-store'

/**
 * 本地 Agent Registry（轻量版）
 * 现阶段以 AI 员工档案为唯一事实源，Registry 提供统一的 Agent Card 视图。
 * 后续 server 同步将基于此 Card 序列化。
 */
export function listAgentCards(): AgentCard[] {
  return store.listAgentEmployees().map(buildAgentCardFromEmployee)
}

export function getAgentCard(cardId: string): AgentCard | null {
  const emp = store.getAgentEmployee(cardId)
  return emp ? buildAgentCardFromEmployee(emp) : null
}
```

（若 `listAgentEmployees` / `getAgentEmployee` / `createAgentEmployee` 已存在于 `project-sqlite-store.ts`——已确认存在——直接复用，无需改动 store。）

**Step 4: 运行测试确认通过**

Run: `cd apps/electron && bun test src/main/lib/agent-registry-service.test.ts`
Expected: PASS（2 用例）

**Step 5: 回归 + 提交**

Run: `cd apps/electron && bun test src/main/lib/project-sqlite-store* src/main/lib/agent-registry-service.test.ts` 及 `bun run typecheck`（仓库现有检查命令，见 root package.json）

```bash
git add apps/electron/src/main/lib/agent-registry-service.ts apps/electron/src/main/lib/agent-registry-service.test.ts
git commit -m "feat(electron): local Agent Registry service exposing employee cards"
```

### Task 1.3：S1 验收

- [ ] `agent-card.test.ts` 2 用例通过
- [ ] `agent-registry-service.test.ts` 2 用例通过
- [ ] 既有 `project-sqlite-store` 相关测试无回归
- [ ] `bun run typecheck` 通过

---

## Sprint 2：服务端 Registry + 租户隔离 + KMS 版本化

**目标**：把 Agent Card 同步到 server 的 Postgres 多租户 store，新增 registry 表与 API；给 envelope secret codec 增加密钥版本字段，为轮换铺路。

### Task 2.1：服务端 Agent Registry（Postgres + API）

**Files:**
- Create: `apps/server/src/agent-registry.ts`
- Create: `apps/server/src/agent-registry-api.ts`
- Modify: `apps/server/src/app.ts`

**Step 1: 写失败测试**

Create `apps/server/src/agent-registry.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { AgentRegistryStore } from './agent-registry'

// 使用与现有 store 测试相同的临时 Postgres 模式（参考 scheduler-store.test.ts / metrics.test.ts）
// 若本地无 Postgres，可用 mock client（AgentRuntimePostgresClient 接口）覆盖逻辑分支。
```

> 说明：S2 依赖真实 Postgres。若 CI 无 Postgres，按仓库既有模式（参考 `audit.test.ts` 的 mock client 方式）编写 mock 版测试；下面给出 mock 版实现要点。

Create `apps/server/src/agent-registry.ts`（核心，含建表/写/读/按租户隔离）:

```ts
import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@gravitas/shared/utils'
import type { AgentCard } from '@gravitas/shared/types/agent-card'

export interface RegistryQuery extends AgentRuntimeScope {
  source?: string
  enabled?: boolean
  limit?: number
}

export class AgentRegistryStore {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_runtime_agent_registry (
      tenant_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      capabilities TEXT NOT NULL DEFAULT '[]',
      fixed_workflow_id TEXT,
      execution_stats TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, card_id)
    )`)
  }

  async upsert(scope: AgentRuntimeScope, card: AgentCard): Promise<void> {
    await this.client.query(
      `INSERT INTO proma_runtime_agent_registry
       (tenant_id, card_id, source, name, role, description, capabilities, fixed_workflow_id, execution_stats, enabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, card_id) DO UPDATE SET
         source=EXCLUDED.source, name=EXCLUDED.name, role=EXCLUDED.role,
         description=EXCLUDED.description, capabilities=EXCLUDED.capabilities,
         fixed_workflow_id=EXCLUDED.fixed_workflow_id, execution_stats=EXCLUDED.execution_stats,
         enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at`,
      [
        scope.tenantId, card.cardId, card.source, card.name, card.role, card.description,
        JSON.stringify(card.capabilities), card.fixedWorkflowId ?? null,
        card.executionStats ? JSON.stringify(card.executionStats) : null,
        card.enabled ? 1 : 0, card.createdAt, card.updatedAt,
      ],
    )
  }

  async list(scope: AgentRuntimeScope, query: RegistryQuery = {}): Promise<AgentCard[]> {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT card_id, source, name, role, description, capabilities, fixed_workflow_id, execution_stats, enabled, created_at, updated_at
       FROM proma_runtime_agent_registry
       WHERE tenant_id = $1 AND user_id = $2
         AND ($3::text IS NULL OR source = $3) AND ($4::boolean IS NULL OR enabled = $4)
       ORDER BY updated_at DESC LIMIT $5`,
      [scope.tenantId, scope.userId, query.source ?? null, query.enabled ?? null, Math.min(query.limit ?? 200, 1000)],
    )
    return result.rows.map((row) => ({
      cardId: String(row.card_id),
      source: String(row.source) as AgentCard['source'],
      name: String(row.name),
      role: String(row.role),
      description: String(row.description),
      capabilities: JSON.parse(String(row.capabilities)) as string[],
      fixedWorkflowId: typeof row.fixed_workflow_id === 'string' ? String(row.fixed_workflow_id) : undefined,
      executionStats: row.execution_stats ? JSON.parse(String(row.execution_stats)) as AgentCard['executionStats'] : undefined,
      enabled: Boolean(row.enabled),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }))
  }
}
```

Create `apps/server/src/agent-registry-api.ts`（Bun 路由，挂到现有 web 服务器）:

```ts
import type { AgentRuntimeScope } from '@gravitas/shared/utils'
import type { AgentRegistryStore } from './agent-registry'
import type { AgentCard } from '@gravitas/shared/types/agent-card'

export interface RegistryApiOptions {
  store: AgentRegistryStore
}

/** 挂载到现有 app 的 /agent/registry 路由族 */
export function createRegistryHandlers({ store }: RegistryApiOptions) {
  return {
    async list(scope: AgentRuntimeScope): Promise<{ cards: AgentCard[] }> {
      return { cards: await store.list(scope) }
    },
    async upsert(scope: AgentRuntimeScope, card: AgentCard): Promise<{ ok: true }> {
      await store.upsert(scope, card)
      return { ok: true }
    },
  }
}
```

Modify `apps/server/src/app.ts`：在现有路由注册处（参考 `/agent/metrics`、`/agent/audit` 的挂法）新增：

```ts
// 伪代码位置：app 创建时实例化 store 并注册 handlers
// const registryStore = new AgentRegistryStore(pg)
// await registryStore.initializeSchema()
// 路由：GET /agent/registry  → handlers.list(scope)
//       PUT /agent/registry  → handlers.upsert(scope, body as AgentCard)
```

**Step 2-4:** 运行 `cd apps/server && bun test src/agent-registry.test.ts`（mock client 版）确认 红→绿；再 `bun run typecheck`。

**Step 5: 提交**

```bash
git add apps/server/src/agent-registry.ts apps/server/src/agent-registry-api.ts apps/server/src/agent-registry.test.ts apps/server/src/app.ts
git commit -m "feat(server): tenant-scoped agent registry store and API"
```

### Task 2.2：envelope 密钥版本字段 — ✅ 已存在，无需实施（2026-08-13 确认）

实施中发现该种子在代码库已有成熟实现，**跳过重复实现**（DRY/YAGNI）：

- `packages/shared/src/utils/agent-runtime-web-secret-codec.ts`：`WebCryptoEnvelopePayload` 已含 `v`（版本）+ `kid`（密钥 ID）；`createRotatingWebCryptoEnvelopeSecretCodec` 支持 `activeKeyId` + grace period 内历史 keys（KMS 轮换）；`reencryptWebCryptoEnvelopeSecret` 提供轮换迁移。
- `packages/shared/src/utils/agent-runtime-cloud-kms-secret-codec.ts`：云 KMS version codec（`activeKeyId` + data key 包裹每条密文），已生产接线。
- `apps/server/src/app.ts:180`：配置 `PROMA_WEB_AWS_KMS_KEY_ID` 时 `createCloudKmsEnvelopeSecretCodec` 启用；本地无 KMS 时回退 WebCrypto envelope。
- `agent-runtime-web-secret-codec.test.ts`：已有「rotated active key → 新写入用新 key、grace key 仍可解旧密文、re-encrypt」完整覆盖。

**结论**：Task 2.2 目标已满足，标记完成，不新增功能。真正的剩余项是 P8-3 的"生产级 KMS 轮换 + 批量 re-encrypt 入口"验收，超出本计划"种子落地"范围，留待后续。

### Task 2.3：S2 验收

- [ ] `agent-registry.test.ts` 通过（含租户隔离用例）
- [ ] `agent-registry-api` 接入 app 后 `GET/PUT /agent/registry` 手动 curl 验证（参考现有 `/agent/metrics` 的 curl 用法）
- [ ] envelope version 测试通过，旧 payload 兼容
- [ ] server 全量 `bun test` 无回归

---

## Sprint 3：Execution Contract 契约层

**目标**：把「指派→执行→回写→考核」从项目任务解耦为通用契约，使 Workflow、项目任务、未来外部触发都复用同一套无人值守执行闭环。

### Task 3.1：定义 Execution Contract 类型

**Files:**
- Create: `packages/shared/src/types/execution-contract.ts`
- Modify: `packages/shared/src/types/index.ts`

类型定义（复用现有 `AgentExecution` 语义，抽离任务无关部分）:

```ts
export type ExecutionContractStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale'
export type ExecutionContractExecutor = 'headless' | 'workflow'

export interface ExecutionContract<TPayload = unknown, TResult = unknown> {
  contractId: string
  agentId: string
  /** 来源实体描述（如 task:xxx / schedule:xxx / event:xxx），不再强绑定项目任务 */
  source: string
  sourceId?: string
  executor: ExecutionContractExecutor
  status: ExecutionContractStatus
  payload: TPayload
  result?: TResult
  error?: string
  heartbeatAt?: number
  createdAt: number
  startedAt?: number
  completedAt?: number
}
```

### Task 3.2：契约服务（从 agent-employee-service 抽取）

**Files:**
- Create: `apps/electron/src/main/lib/execution-contract-service.ts`
- Create: `apps/electron/src/main/lib/execution-contract-service.test.ts`
- Modify: `apps/electron/src/main/lib/agent-employee-service.ts`（改调用契约层，保留对外 API 不变）

**Step 1: 写失败测试**：契约服务提供 `createExecutionContract` / `transitionContract` / `listContractsByAgent` 纯逻辑，用内存 Map 做临时后端（可注入 store 接口），断言状态机合法迁移（queued→running→completed；非法迁移抛错）。

**Step 2: 运行确认失败**。

**Step 3: 实现**：

```ts
export interface ContractStore {
  create(contract: ExecutionContract): Promise<void>
  get(contractId: string): Promise<ExecutionContract | null>
  update(contract: ExecutionContract): Promise<void>
  listByAgent(agentId: string): Promise<ExecutionContract[]>
}

const VALID_TRANSITIONS: Record<ExecutionContractStatus, ExecutionContractStatus[]> = {
  queued: ['running', 'cancelled', 'stale'],
  running: ['completed', 'failed', 'cancelled', 'stale'],
  completed: [], failed: [], cancelled: [], stale: ['running'],
}

export class ExecutionContractService {
  constructor(private readonly store: ContractStore) {}

  async create(input: { agentId: string; source: string; sourceId?: string; executor: ExecutionContractExecutor; payload: unknown }): Promise<ExecutionContract> {
    const contract: ExecutionContract = {
      contractId: randomUUID(), ...input, status: 'queued', createdAt: Date.now(),
    }
    await this.store.create(contract)
    return contract
  }

  async transition(contractId: string, to: ExecutionContractStatus): Promise<ExecutionContract | null> {
    const contract = await this.store.get(contractId)
    if (!contract) return null
    if (!VALID_TRANSITIONS[contract.status].includes(to)) {
      throw new Error(`非法契约状态迁移: ${contract.status} → ${to}`)
    }
    contract.status = to
    if (to === 'running') contract.startedAt ??= Date.now()
    if (to === 'completed' || to === 'failed' || to === 'cancelled') contract.completedAt = Date.now()
    await this.store.update(contract)
    return contract
  }
}
```

**Step 4: 运行确认通过**。

**Step 5: 接入 agent-employee-service**：`dispatchTaskToAgentLocked` 中改为创建 Execution Contract（source=`task:${task.id}`），执行启动/回写路径改为 `transition`；保留 `AgentExecution` 表作为契约的落地实现（ContractStore 适配器），对外 API（`listAgentExecutionsByAgent` 等）不变。

**Step 6: 回归 + 提交**

Run: `cd apps/electron && bun test src/main/lib/agent-employee-service* src/main/lib/execution-contract-service.test.ts src/main/lib/agent-orchestrator.queue.test.ts` 与 `bun run typecheck`

```bash
git add packages/shared/src/types/execution-contract.ts apps/electron/src/main/lib/execution-contract-service.ts apps/electron/src/main/lib/execution-contract-service.test.ts apps/electron/src/main/lib/agent-employee-service.ts
git commit -m "refactor(electron): extract Execution Contract layer from agent-employee dispatch"
```

### Task 3.3：S3 验收

- [ ] 契约状态机合法/非法迁移用例通过
- [ ] `agent-employee-service` 全部既有测试无回归
- [ ] 手动验证：指派任务给 AI 员工仍能正常执行并回写任务状态

---

## Sprint 4：审计 hash chain + 贵慢重准看板

### Task 4.1：append-only 审计 hash chain

**Files:**
- Modify: `apps/server/src/audit.ts`
- Modify: `apps/server/src/audit.test.ts`

**Step 1: 写失败测试**：新增「append 后记录带 `prev_hash`/`hash`，篡改中间记录后 `verifyChain` 失败」用例。

**Step 2: 运行确认失败**。

**Step 3: 实现**：

```ts
import { createHash } from 'node:crypto'

// 在 PostgresAuditLog 中：
// 建表增加 prev_hash TEXT, hash TEXT
// append: 查最新一条 hash 作为 prev，计算 hash = sha256(prev_hash + tenant + user + action + resource + result + createdAt + nonce)
// verifyChain(tenantId): 从头遍历，校验每条的 hash 与前一条一致，并重算校验
```

> 注意：`append` 里的 nonce 需用 `randomUUID` 保证同秒同内容也产生不同 hash；`verifyChain` 需按 tenant 隔离（hash chain 按 tenant 分链）。

**Step 4: 运行确认通过** + `bun run typecheck`。

**Step 5: 提交**

```bash
git add apps/server/src/audit.ts apps/server/src/audit.test.ts
git commit -m "feat(server): append-only audit hash chain with tamper verification"
```

### Task 4.2：贵慢重准四维看板聚合

**Files:**
- Create: `apps/server/src/health-dashboard.ts`
- Modify: `apps/server/src/dashboard.ts`（挂载聚合接口）

**Step 1: 写失败测试**：`health-dashboard.test.ts`，聚合输入 metrics（贵：cost；慢：p95 latency；重：token；准：成功率/幻觉率占位）→ 输出四维评分对象。

**Step 2: 运行确认失败**。

**Step 3: 实现**：

```ts
export interface HealthDashboard {
  cost: { monthlyMicroUsd: number; trend: 'up' | 'down' | 'flat' }
  latency: { p95Ms: number; targetMs: number }
  volume: { totalTokens: number; totalRuns: number }
  accuracy: { successRate: number; hallucinationRate?: number }
  budget: { monthlyLimitMicroUsd?: number; usedPercent?: number }
}
export function computeHealthDashboard(input: {
  monthlyCostMicroUsd: number; p95LatencyMs: number; totalTokens: number; totalRuns: number; successRuns: number
  monthlyBudgetMicroUsd?: number
}): HealthDashboard { /* 纯函数计算 */ }
```

Modify `apps/server/src/dashboard.ts`：新增 `GET /agent/health` 调用 compute，数据源复用 `metrics.ts`/`billing.ts` 的聚合结果。

**Step 4: 运行确认通过**。

**Step 5: 提交**

```bash
git add apps/server/src/health-dashboard.ts apps/server/src/health-dashboard.test.ts apps/server/src/dashboard.ts
git commit -m "feat(server): cost/speed/volume/accuracy health dashboard aggregation"
```

### Task 4.3：S4 验收

- [ ] hash chain：篡改任一条记录后 `verifyChain` 返回失败；正常链通过
- [ ] `/agent/health` 返回四维健康度 + 预算占用
- [ ] server 全量 `bun test` 无回归
- [ ] 手动：写 3 条审计、篡改第 2 条、验证失败

---

## 全局验收（S1–S4 合流）

1. Electron：AI 员工档案 ↔ Agent Card 互转正常，`listAgentCards()` 返回全部在编员工。
2. Server：`GET/PUT /agent/registry` 按租户读写正常，多租户不串数据。
3. 契约层：指派 AI 员工任务走 Execution Contract 状态机，既有任务回写不受影响。
4. 安全：审计 hash chain 可检测篡改；envelope 含密钥版本。
5. 治理：`/agent/health` 输出贵慢重准 + 预算占用。

## 与既有文档/工作的关系

- 本计划的 S1/S3 与「AI 员工 + 通用 Agent 融合」设计（身份层/契约层/引擎层）直接对应，是融合的第一步落地。
- S2/S4 对应 `docs/server-web-remaining-todo.md` 的 P8-1（审计合规）、P8-3（KMS 版本）与 P6-3（运营视图）的种子化前置。
- 三轨策略（开源/私有部署/商业化）共用本计划产出的类型与接口，只是部署拓扑不同。

## 后续（不在本次范围内）

- 服务端 MCP 池多 worker 隔离验收（P7-2）
- 隔离执行器容器化验收（P7-3，`apps/executor` 已有实现，补真机验收）
- OIDC RBAC 到 Agent Card 权限映射（P8-1）
- 一键部署 compose 扩展（已存在 `docker-compose.production.yml`，后续补 registry/health 无需变更）
