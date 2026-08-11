# Workflow 独立项目隔离 — 诊断报告

> 2026-08-10 问题：workflow 模式没有独立项目，运行会话混入 Agent 模式会话列表。
> 用户期望：Workflow 拥有独立的工作目录 / 上下文。

## 根因（代码链路核实）

**Workflow 从设计上强制依附 Agent 工作区，没有独立项目实体。**

### 1. 创建时强绑 Agent workspace
`WorkflowSidebarList.tsx:132`
```ts
const workspaceId = currentWorkspaceId ?? workspaces[0]?.id
const next = createWorkflow(workspaceId)   // workflow.workspaceId = agent workspace id
```
Workflow Definition 只有一个 `workspaceId` 字段指向 Agent 工作区
（`~/.proma/agent-workspaces/{slug}/`），**没有**独立的 project/workspace 概念。

### 2. Agent 节点执行时复用 Agent session 体系
`workflow-agent-executor.ts` `executeWorkflowAgentNode`
```ts
const session = await sessionFactory.create(title, channelId, initial.workspaceId)
// → createAgentSession(title, channelId, workspaceId)  // 就是普通 Agent 会话
```
`agent-session-manager.ts` `createAgentSession`:
- `index.sessions.push(meta)` → 写入**同一份** agent-sessions 索引（`~/.proma/agent-sessions.json`）
- `getAgentSessionWorkspacePath(ws.slug, sessionId)` → cwd 落在 agent workspace 下的 `{sessionId}/`

### 3. 因此 workflow 运行会话的表现
- **混入 Agent 模式会话列表**：AgentView/侧边栏 `listAgentSessions()` 全量拉取，workflow 执行创建的 session（仅 title 前缀 "Workflow: "）没有专属标记，与普通 agent 会话混淆。
- **没有独立工作目录**：cwd 是 `~/.proma/agent-workspaces/{slug}/{sessionId}/`，与 agent 会话共用 workspace 树，没有 workflow 专属、跨 run 累积的项目目录与上下文。

## 相关存储现状
- Workflow Definition/Run 本身确实独立：`~/.proma/configDir/workflows/{id}/`（definition.json + runs/ + 审计 jsonl）。
- 但 workflow 的 **agent 节点执行上下文（cwd、CLAUDE.md、.context、skills、mcp）却绑定在 Agent 工作区**，没有独立。

## 修复方向（候选）
- **目标**：workflow 拥有自己独立的项目目录（跨 run/跨节点共享），agent 节点在项目目录下执行；执行会话在 Agent 列表可识别/过滤。
- 涉及：`AgentSessionMeta` 增 workflow 来源标记、`workflow-agent-executor` 传独立项目目录、CreateAgentSession/路径解析、Agent 侧边栏过滤与分组、是否允许在 workflow 项目目录内写 `.context`/CLAUDE.md。
- 待定：workflow 项目目录放哪一层（`~/.proma/configDir/workflows/{id}/.context` vs 独立 `projects/`）；workflow 是否可被 agent 发起的带项目运行共享同一个目录。
