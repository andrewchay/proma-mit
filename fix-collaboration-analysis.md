# Pi Runtime 多子任务(collaboration)未拉起 — 代码修复方案

## 一、问题诊断结论

### 1.1 根本原因

**`collaborationWorkspaceId` 为 `undefined`，导致 `collaborationAvailable = false`**

在 `pi-agent-adapter.ts` 中：

```typescript
const collaborationWorkspaceId = resolveCollaborationWorkspaceId(workspaceId)
const collaborationAvailable = !!collaborationWorkspaceId 
  && !!input.channelId 
  && !isDelegationSession
```

`resolveCollaborationWorkspaceId()` 的解析逻辑：
1. 优先用传入的 `workspaceId` → 你的会话可能没传
2. Fallback 到 `getSettings()?.agentWorkspaceId` → 全局默认工作区
3. Fallback 到 `listAgentWorkspaces()[0]` → 最近工作区

**如果三个都无效，`collaborationWorkspaceId = undefined`** → `collaborationAvailable = false` → **collaboration 工具完全不注入到 Pi 会话中**

### 1.2 为什么模型说 "No result"

这不是工具执行返回的错误，而是 **工具根本没被注册到 Pi 会话中**：
- `customTools` 数组中没有 collaboration 工具
- Pi 的 `systemPromptOverride` 中 `toolPrompt` 只列出 `customTools` 中的工具
- 模型看不到这些工具，所以当用户要求用子代理时，模型只能说自己无法使用

### 1.3 日志确认

查看应用日志中这条输出：
```
[Pi Runtime] collaboration 注入判定: { sessionId, workspaceId, collabWs, channelId, isDelegationSession, collaborationAvailable }
```

如果 `collabWs` 是 `undefined` 或 `collaborationAvailable` 是 `false`，就确认了问题。

---

## 二、修复方案

### 方案 A：确保会话绑定工作区（推荐）

**问题**：创建 Agent 会话时未传入 `workspaceId`

**修复位置**：`agent-session-manager.ts` 的 `createAgentSession()` 已被调用时传入 `workspaceId`，但需要检查调用链。

**检查点**：

1. **前端创建会话时是否传了 `workspaceId`**：
   - 检查渲染进程中创建 Agent 会话的代码
   - 确认 `agentWorkspaceId` 设置是否被正确读取并传入

2. **设置中是否有默认工作区**：
   ```typescript
   // settings-service.ts
   getSettings()?.agentWorkspaceId  // 这个值是否设置？
   ```

3. **是否有任何工作区存在**：
   ```typescript
   // agent-workspace-manager.ts
   listAgentWorkspaces()  // 这个数组是否为空？
   ```

### 方案 B：放宽 collaboration 注入条件（备选）

如果工作区机制确实不需要，可以修改注入逻辑：

**修改位置**：`pi-agent-adapter.ts`

```typescript
// 当前代码（严格）
const collaborationAvailable = !!collaborationWorkspaceId 
  && !!input.channelId 
  && !isDelegationSession

// 改为：即使 workspaceId 为空，只要有 channelId 就注入
// （子会话创建时会用空 workspaceId，但 resolveCollaborationWorkspaceId 会 fallback）
const collaborationAvailable = !!input.channelId && !isDelegationSession
```

**但注意**：`CollaborationToolContext.workspaceId` 用于子会话创建时的 `createAgentSession()`，如果为 `undefined`，子会话也会没有工作区。需要确保 `startDelegation()` 能处理 `workspaceId=undefined` 的情况。

### 方案 C：修复 resolveCollaborationWorkspaceId 的 fallback 逻辑

**修改位置**：`agent-collaboration-tools.ts`

当前逻辑：
```typescript
export function resolveCollaborationWorkspaceId(fallbackWorkspaceId?: string): string | undefined {
  const tryValid = (id?: string): string | undefined => (id && getAgentWorkspace(id) ? id : undefined)
  const direct = tryValid(fallbackWorkspaceId)
  if (direct) return direct
  const defaultId = tryValid(getSettings()?.agentWorkspaceId as string | undefined)
  if (defaultId) return defaultId
  const all = listAgentWorkspaces()
  const newest = all[0]
  if (newest && tryValid(newest.id)) return newest.id
  return undefined
}
```

**问题**：如果用户从未设置过默认工作区，且没有任何工作区，返回 `undefined`。

**修复**：如果没有工作区，自动创建一个默认工作区：

```typescript
export function resolveCollaborationWorkspaceId(fallbackWorkspaceId?: string): string | undefined {
  const tryValid = (id?: string): string | undefined => (id && getAgentWorkspace(id) ? id : undefined)
  
  const direct = tryValid(fallbackWorkspaceId)
  if (direct) return direct
  
  const defaultId = tryValid(getSettings()?.agentWorkspaceId as string | undefined)
  if (defaultId) return defaultId
  
  const all = listAgentWorkspaces()
  const newest = all[0]
  if (newest && tryValid(newest.id)) return newest.id
  
  // 新增：如果没有工作区，自动创建默认工作区
  if (all.length === 0) {
    try {
      const defaultWorkspace = createAgentWorkspace('默认工作区')
      // 设置为默认
      updateSettings({ agentWorkspaceId: defaultWorkspace.id })
      return defaultWorkspace.id
    } catch (err) {
      console.warn('[Collaboration] 自动创建默认工作区失败:', err)
    }
  }
  
  return undefined
}
```

---

## 三、验证步骤

### 3.1 检查当前状态

在应用启动时或创建会话时，检查以下值：

```typescript
// 1. 检查设置
const settings = getSettings()
console.log('agentWorkspaceId:', settings.agentWorkspaceId)

// 2. 检查工作区列表
const workspaces = listAgentWorkspaces()
console.log('workspaces count:', workspaces.length)
console.log('first workspace:', workspaces[0]?.id)

// 3. 检查会话元数据
const sessionMeta = getAgentSessionMeta(sessionId)
console.log('session workspaceId:', sessionMeta?.workspaceId)
```

### 3.2 确认修复后

修复后，日志应显示：
```
[Pi Runtime] collaboration 注入判定: { 
  sessionId: 'xxx', 
  workspaceId: 'xxx', 
  collabWs: 'xxx',  // 不再是 undefined
  channelId: 'xxx', 
  isDelegationSession: false, 
  collaborationAvailable: true  // 必须是 true
}
```

### 3.3 测试子代理

1. 发送消息要求使用子代理：
   > "请用子代理并行搜索 A 和 B"

2. 观察侧栏是否出现多个子会话

3. 检查日志是否有：
   ```
   [Agent 会话] 已创建会话: 协作：xxx (yyy)
   ```

---

## 四、相关代码文件

| 文件 | 职责 |
|------|------|
| `pi-agent-adapter.ts` | Pi Runtime 适配器，注入 collaboration 工具 |
| `agent-collaboration-tools.ts` | collaboration 工具实现 + workspaceId 解析 |
| `agent-collaboration-utils.ts` | 协作工具纯函数（权限、prompt 构建等） |
| `agent-session-manager.ts` | 会话 CRUD，创建会话时绑定 workspaceId |
| `agent-workspace-manager.ts` | 工作区 CRUD，list/get 工作区 |
| `settings-service.ts` | 应用设置读写，含 `agentWorkspaceId` |
| `agent-headless-runner-registry.ts` | headless runner 注册表，供 collaboration 启动子会话 |
| `agent-service.ts` | 注册 headless runner 和 collaboration EventBus |

---

## 五、建议的修复优先级

1. **P0 - 检查并设置默认工作区**：
   - 在 UI 设置中确认 `agentWorkspaceId` 是否配置
   - 如果没有，创建一个工作区并设为默认

2. **P1 - 修复 `resolveCollaborationWorkspaceId`**：
   - 添加自动创建默认工作区的 fallback 逻辑
   - 或在前端创建会话时强制要求选择/创建工作区

3. **P2 - 添加更明显的日志/提示**：
   - 当 `collaborationAvailable = false` 时，在 UI 中提示用户原因
   - 而不是静默失败让模型自己说 "无法使用"

4. **P3 - 考虑放宽注入条件**：
   - 如果工作区不是 collaboration 的强依赖，允许无工作区运行
   - 但需确保子会话创建逻辑兼容
