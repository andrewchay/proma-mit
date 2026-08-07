# PH1-A 实施：飞书/钉钉人员拉取 + 双向 mapping

> 时间：2026-08-07
> 目标：把现有「手动单点搜索通讯录」升级为「成员同步 + 双向稳定映射」，为后续 PH1-B 成员统一 / PH1-C 事件事实源打地基。
> 代码基线：[apps/electron/src/main/lib/contact-search-service.ts](…) 现状已读。

---

## 0. 现状（代码确认）

当前是**按需手动**链路，已有零件：

| 已有 | 位置 |
|---|---|
| 从飞书拉成员（枚举可见部门树 + `find_by_department`，返回 open_id/union_id）| `contact-search-service.ts::searchFeishuContacts` (L174) |
| 从钉钉拉成员（遍历部门 + user/list + 解析 unionid，返回 userid/unionid，**不含部门名**）| `searchDingtalkContacts` (L396) |
| 并行搜索两平台 | `searchContactsAll(kw)` (L455) |
| 凭证复用（bot appId/appSecret，不存第二份明文）| `getFeishuCredential`/`getDingtalkCredential` |
| 映射表 + CRUD | `user_mappings` 表 + `saveUserMapping/getUserMapping/listUserMappings` (sqlite-store) |
| IPC 通道 | `SEARCH_CONTACTS_ALL` / `SAVE_USER_MAPPING` / `LIST_USER_MAPPINGS` … (work-module-ipc-handlers / preload) |
| 前端负责人选择器 | `ProjectView.tsx::ContactPicker`（键入→search→点选→saveUserMapping）|

### 缺口（本次要补）
1. **无成员同步服务**：每次是用户当场搜索、当场写单条 mapping；没有「批量拉回全部通讯录→落成员档案」的同步。
2. **paaUserId 不稳定**：当前用 `paa-${name}`（人名）生成，同名/改名/重名会冲突。
3. **跨平台对齐脆弱**：`user_mappings` 只有 `dingtalk_union_id`，**没有 feishu_union_id**；同一人飞书/钉钉只能靠人名匹配。
4. **无成员目录查询**：没有 `listMembers/findMember` 稳定接口（现在 `getUserMapping` 只按 paaUserId，`listUserMappings` 不面向目录使用）。
5. **无手动触发/定时增量同步**。

---

## 1. 目标架构

```
飞书通讯录 ──┐
            ├─► 新增 member-sync-service.ts
钉钉通讯录 ──┘     · 批量拉取(复用 contact-search 内部能力)
                  · 归一成统一 Member 草稿
                  · 用 unionId + name 跨平台合并
                  ─► members 表(member_id 主键, 稳定)
                  │   字段: 外部 feishu/dtingtalk id + unionid + dept + source
                  │
                  ─► user_mappings 升级(加 feishu_union_id) 兼容既有逻辑
                  │
  手动触发(IPC) / 定时增量(可选)
                  ▼
            成员目录查询 listMembers/findMember
                  ▼
        PH1-B 成员统一 / 指派整合 / 后续事件归属
```

**原则**：不推翻现有 `user_mappings` / `TodoProvider`；在其**之上**加一层 `members` 成员档案，作为「稳定成员身份真源」，`user_mappings` 逐步收敛为兼容视图，最终由 members 驱动。

---

## 2. 数据层改动

### 2.1 新增 `members` 表（新「成员真源」）
在 `project-sqlite-store.ts` 建表（沿用现有 sqlite 风格）：

```sql
CREATE TABLE IF NOT EXISTS members (
  member_id      TEXT PRIMARY KEY,          -- 稳定 ID（UUID）
  kind           TEXT NOT NULL DEFAULT 'human',  -- human | agent | bot（为 PH1-B 预留）
  display_name   TEXT NOT NULL DEFAULT '',
  plain_name     TEXT,                      -- 小写规范化名，用于匹配
  feishu_user_id    TEXT,                   -- 飞书 open_id
  feishu_union_id   TEXT,                   -- 飞书 union_id（跨平台主键）
  dingtalk_user_id  TEXT,                   -- 钉钉 userid
  dingtalk_union_id TEXT,                   -- 钉钉 unionid
  department     TEXT,
  source         TEXT NOT NULL DEFAULT 'sync',  -- sync | manual
  active         INTEGER NOT NULL DEFAULT 1,
  last_synced_at INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_union ON members(feishu_union_id, dingtalk_union_id);
CREATE INDEX IF NOT EXISTS idx_members_name ON members(plain_name);
```

- **union_id 是跨平台对齐主键**：飞书 union_id、钉钉 unionid 互不相同的两账，需靠「display_name + 部门」启发式对齐（两平台 unionId 体系独立，无法直接等同）。
- 表结构为 PH1-B 预留 `kind`（human/agent/bot）。

### 2.2 `user_mappings` 加 `feishu_union_id` 列（兼容既有逻辑）
表结构 + INSERT 已存在；补一列：

```sql
ALTER TABLE user_mappings ADD COLUMN feishu_union_id TEXT; -- 幂等迁移（IF NOT EXISTS 语义用 try/catch）
```

让 `UserMapping` 类型加 `feishuUnionId?`，`SaveUserMappingInput` 同步。

---

## 3. 服务层：新增 `member-sync-service.ts`

### 3.1 同步接口
```ts
interface MemberSyncResult {
  platform: 'feishu' | 'dingtalk'
  pulled: number      // 拉取到的人数
  inserted: number    // 新增 member
  merged: number      // 与既有 member 合并
  failed: number
  error?: string
}
export async function syncMembersFromFeishu(): Promise<MemberSyncResult>
export async function syncMembersFromDingtalk(): Promise<MemberSyncResult>
export async function syncAllMembers(): Promise<{ feishu: MemberSyncResult; dingtalk: MemberSyncResult }>
```

### 3.2 内部流程（以飞书为例，钉钉同理）
1. 复用 `contact-search-service` 内部拉取能力。因现有 `searchFeishuContacts` 已做部门枚举，需**导出**一个"拉全部成员"的轻量入口（或在 sync 内复用相同 fetch 逻辑，避免语义耦合"搜索"）。
2. 每条成员记录 → 归一为 `MemberDraft`：
   ```ts
   interface MemberDraft {
     platform: 'feishu'|'dingtalk'
     externalId: string      // feishu open_id / dingtalk userid
     unionId?: string
     name: string
     department?: string
   }
   ```
3. **对齐策略**（关键），按优先级：
   - ① 同源同 unionId → 更新既有 member（改/补平台字段）
   - ② 已有 member 且该平台字段为空，但 name+department 匹配 → 填充该平台字段（跨平台合并）
   - ③ 完全无匹配 → 新建 member
   - ④ 冲突（同 unionId 不同 name）→ 保留，记录待人工（打 `source='manual'` 需确认）
4. 批量写入：`upsertMember(draft)`（共用 unionid / name 匹配）。
5. 同步时更新 `user_mappings`（写回 feishu_user_id/feishu_union_id 等），**保证既有指派/同步链路不破坏**。

### 3.3 成员目录查询
```ts
export function listMembers(opts?: { kind?: MemberKind; q?: string; activeOnly?: boolean }): Member[]
export function findMember(query: { memberId?; feishuUserId?; dingtalkUserId?; unionId?; displayName? }): Member | null
export function getUserIdByPlatform(memberId: string, platform: 'feishu'|'dingtalk'): string | undefined  // 本地→平台
export function getMemberByPlatformId(platform: 'feishu'|'dingtalk', platformUserId: string): Member | null  // 平台→本地（补反向）
```

### 3.4 与既有 `project-sync-service` 对齐
- `getUserIdByPaaUserId`（现有：入 PAA userId 出平台 ID）——新增实现可改为「入 memberId（稳定）出平台 ID」，保持签名兼容，先在 `TodoProvider` 内部改用 members。
- 复用 `getFeishuCredential`/`getDingtalkCredential`（不重存明文 secret）。

---

## 4. 调用与 UI

### 4.1 主进程 IPC（扩展 work-module-ipc-handlers + preload + PROJECT_IPC_CHANNELS）
- `MEMBERS:SYNC_ALL` → `syncAllMembers()`
- `MEMBERS:LIST` → `listMembers({q})`
- `MEMBERS:GET` → `findMember(...)`
- `MEMBERS:SYNC_STATUS` → 最近一次同步结果/时间

### 4.2 手动触发入口
- 项目管理 → 团队/设置 Tab 加「同步通讯录成员」按钮（触发 SYNC_ALL，展示 pulled/inserted/merged/failed）。
- **可选定时增量**：接入 automation 已有能力或轻量 setInterval，按天增量同步（避免改动过大，放后续）。

### 4.3 ContactPicker 增强（渐进，不破坏现状）
- 优先读 `listMembers` 展示成员目录（含同步进来的人），保留 `searchContactsAll` 实时兜底。
- 选择成员时写 `members` + `user_mappings`（保持既有同步链路）。

---

## 5. 实施步骤（分小步，可独立验证）

| 步骤 | 内容 | 工作量 | 状态 |
|---|---|---|---|
| 1 | `project-sqlite-store`：新增 `members` 表 + CRUD（upsert/list/find）+ `user_mappings` 加 `feishu_union_id` | S | ✅ 已实现 |
| 2 | `member-sync-service.ts`：导出现有 search 能力为"拉全量"，归一共用逻辑 | M | ✅ 已实现 |
| 3 | 对齐策略（unionId/name+dept/冲突）实现 + 单测 | M | ✅ 已实现 |
| 4 | IPC + preload + 常量通道接入 | S | ✅ 已实现（见下） |
| 5 | 项目管理 Tab「同步通讯录」UI + 结果展示 | M | ✅ 已实现（见下） |
| 6 | ContactPicker 优先 listMembers + 兜底 search | M | ✅ 已实现（见下） |
| 7 | （后续）定时增量同步 + member 反向查询接入 TodoProvider | M | ✅ 已实现（见下） |

### 步骤 7 已实现（2026-08-07）

- `member-sync-service.ts`：
  - 新增成员反查 `findMemberByPaaUserId(paaUserId)`（解析 `paa-<name>` → members）与 `resolvePlatformForPaaUser(paaUserId, platform)`（feishu→feishuUserId/feishuUnionId；dingtalk→dingtalkUnionId/dingtalkUserId）；
  - 新增增量/定时同步基础设施：`MEMBER_SYNC_COOLDOWN_MS`（6h）、`isMemberSyncCooldownActive`、`isMemberSyncInFlight`、`getLastMemberSyncAt`、`syncMembersIfCooldownElapsed`、`syncMembersNow`（并发保护 + 铜率流窗口）。
- `project-auto-sync.ts`：`registerProjectAutoSync()` 内新增**定时增量成员同步**（启动即跑 + 每 6h interval），用带冷却/并发保护的 `syncMembersIfCooldownElapsed`，凭证缺失/网络失败静默；取消函数清理 interval。
- `project-sync-service.ts` `syncTaskToExternal`：平台 ID 解析改为「优先 user_mappings，缺则回退 members 反查」，且 `userMapping` 可为空时不再提前 return（修复漏洞：有 members 却无映射时也能同步）；`dingTalkUnionId` 引用改为 `userMapping?.` 防 null。
- `feishu-todo-provider.ts` / `dingtalk-todo-provider.ts`：`getUserIdByPaaUserId` 从「直接返回 paaUserId」改为通过 `resolvePlatformForPaaUser` 反查成员目录（找不到回退原值）。

**验证**：electron 全量 tsc 通过；member-store + member-sync-service（含 3 个新增反查/冷却用例）+ contact-search + feishu-todo-provider 共 21 用例全过。

### 步骤 6 已实现（2026-08-07）

- `renderer/components/projects/ProjectView.tsx` ContactPicker 改造：
  - 新增 `members` 状态 + `loadMembers(kw)`：打开/输入时优先从 `window.electronAPI.paa.project.listMembers({ activeOnly, q })` 拉取**本地成员目录**；
  - 下拉顶部新增「团队成员」分组（显示成员 + 已关联平台徽标），排在飞书/钉钉实时搜索之前；
  - `pickMember(m)` 一次性写入该成员**两个平台**（feishu/dingtalk）的 `saveUserMapping`（合并保留已有字段）；
  - 保留 `searchContactsAll` 实时兜底（搜索时并行拉目录 + 搜通讯录）；
  - `pick(c)` 同时写入 `feishuUnionId`（此前缺）；
  - 移除旧的未使用 `hasAny`，空态判定改为「目录+飞书+钉钉都为空」。

**验证**：electron 全量 tsc 通过；member-store + member-sync-service + contact-search-service + feishu-todo-provider 共 18 用例全过。


### 步骤 4+5 已实现（2026-08-07）

- `packages/shared/src/types/work-module.ts`：`PROJECT_IPC_CHANNELS` 增加 `SYNC_MEMBERS_ALL`/`SYNC_MEMBERS_FEISHU`/`SYNC_MEMBERS_DINGTALK`/`LIST_MEMBERS`/`GET_MEMBER`；新增共享类型 `MemberResult`/`MemberSyncResult`/`MemberSyncAllResult`。
- `main/lib/work-module-ipc-handlers.ts`：新增 5 个 ipcMain.handle（sync all/feishu/dingtalk + list/get），动态 import member-sync-service 与 store。
- `preload/index.ts`：`paa.project` 接口与运行时新增 `syncMembersAll`/`syncMembersFeishu`/`syncMembersDingtalk`/`listMembers`/`getMember`。
  - ⚠ 注意：这些方法位于 `paa.project` 组（与 `searchContactsAll` 等项目管理 API 同层），**不是** `paa` 顶层；renderer 需用 `window.electronAPI.paa.project.*` 访问（ProjectView 的 `callProjectAPI` 也是访问 `paa.project`）。
- `renderer/components/projects/AgentTeamPanel.tsx`：新增 `MemberSyncPanel` 组件（团队 Tab 顶部），含「同步通讯录」按钮 + 飞书/钉钉结果卡（拉取/新增/合并/失败）+ 当前成员数，错误可展示。

**验证**：electron + shared 全量 tsc 通过；member-store + member-sync-service + contact-search-service 共 15 用例全过；pre-existing 测试（feishu-todo-provider、ProjectView 等）不受影响。

> 注：`PROJECT_IPC_CHANNELS.SYNC_MEMBERS_ALL` 等常量需配合 `paa.project` 前缀；若后续 ContactPicker（步骤 6）复用，也从 `paa.project`, 访问。

### 步骤 2+3 已实现（2026-08-07）

- `lib/contact-search-service.ts`：导出底层原语供同步复用（`getFeishuCredential`/`getDingtalkCredential`/`getFeishuTenantToken`/`getDingtalkToken`/`listDingtalkSubDeptIds`/`listDingtalkDeptUsers`/`resolveDingtalkUnionId`/`safeJson`/`feishuError`/`FEISHU_BASE`），无行为改动；选择器仍用有上限的 `searchContactsAll`。
- `lib/member-sync-service.ts`（新增）：
  - `pullFeishuMembers()`：BFS 部门树（≤8 层）→ 每部门 `find_by_department` 分页拉全部直属用户（**无 30 上限**），捕获 `open_id`+`union_id`+部门名；空则 `/users` 兜底。
  - `pullDingtalkMembers()`：根+子部门 → `user/list` 全量 → 逐 user `unionid` 解析。
  - `upsertDraft()` 对齐：①同平台 union_id 匹配→merge；②displayName 匹配→补另一平台字段；③否则新建。并入字段只补空缺不覆盖。
  - `syncMembersFromFeishu()` / `syncMembersFromDingtalk()` / `syncAllMembers()`，返回 pulled/inserted/merged/failed。
  - 导出 `upsertMemberDraft`（对齐+落库的可测接线口）。
- `lib/member-sync-service.test.ts`（4 用例，隔离临时目录）：union_id 同人并单条、跨平台同名合并补字段、全新 insert + 重复不重复建、并入不覆盖已有。

**验证**：electron 全量 tsc 通过；member-store + member-sync-service + feishu-todo-provider 共 16 用例全过。

### 步骤 1 已实现（2026-08-07）

**改动文件**：
- `lib/project-types.ts`：`UserMapping`/`SaveUserMappingInput` 加 `feishuUnionId?`；新增 `Member`/`MemberKind`/`MemberSource`/`CreateMemberInput`/`UpdateMemberInput`/`ListMembersFilter` 类型。
- `lib/project-sqlite-store.ts`：
  - `migrate()` 新建 `members` 表 + 索引（`idx_members_fu_id`/`idx_members_du_id`/`idx_members_name`）；`user_mappings` 表定义加 `feishu_union_id`；
  - 为旧库加 `user_mappings.feishu_union_id` 列（幂等 ALTER，用 `PRAGMA table_info` 判定）；
  - 修复潜在 bug：migrate 里旧代码 `database.prepare(...).all()` 在 sql.js 原生 Statement 上本无 `.all()`，会抛错 → 新增 `readColumnNames()`（step+getAsObject 遍历）替换 4 处；
  - `saveUserMapping` 改为**按字段合并**（仅覆盖入参提供的字段，保留另一平台已有值），并读写 `feishu_union_id`；`getUserMapping`/`listUserMappings` 读回 `feishuUnionId`；
  - 新增 `members` CRUD：`createMember`/`getMember`/`findMember`/`updateMember`/`listMembers`/`deleteMember`/`touchMemberSync`（含 `plain_name` 规范化、kind/source/active 过滤）。

**测试**：`lib/member-store.test.ts`（9 用例，PROMA_TEST_CONFIG_DIR 隔离临时目录不污染真实 ~/.gravitas/projects）:
- members 建档/查询（union_id/platform id/姓名）、跨平台字段合并保留、停用、按 kind/activeOnly/q 过滤、物理删除；
- user_mappings 的 feishuUnionId 写入/读回，以及重复 save 合并不丢另一平台。


---

## 6. 验收标准
- 点「同步通讯录」：飞书/钉钉成员批量落成 `members`，返回 pulled/inserted/merged/failed。
- 同一人飞书+钉钉（unionId 或 name+dept 匹配）合并成一条 member。
- `user_mappings` 兼容：既有指派回写不破坏。
- 负责人选择器显示成员目录，可选择同步进来的人并正确回写任务。
- 跨平台冲突成员不会静默覆盖，进入待确认。

---

## 7. 风险与注意
- **unionId 体系独立**：飞书 union_id 与钉钉 unionid 不直接等价，跨平台合并靠 name+department 启发式，可能误并/漏并 → 冲突保留待人工，不做自动静默覆盖。
- **通讯录可见范围**：飞书用应用可见范围（已踩过 find_by_department 权限坑，见 todo.md 需求3），同步结果受可见范围限制，需在 UI 提示"仅可见范围内的成员"。
- **钉钉同步无部门名**：目前 `searchDingtalkContacts` 不返回部门，跨平台 name 匹配需降级只用 name（同名多部门可能误并）→ 可后续在 `listDingtalkDeptUsers` 传回部门名。
- 一次全量拉取量可能大：对参数 limit/分页 + 幂等 upsert，避免重复。
- 与 PH1-B 衔接：`members.kind` 已预留，后续 AI 员工/ bot 接到同一 Member 模型。

---

## 8. 依赖文件索引
- `apps/electron/src/main/lib/contact-search-service.ts`（复用拉取）
- `apps/electron/src/main/lib/project-sqlite-store.ts`（表 + CRUD）
- `apps/electron/src/main/lib/work-module-ipc-handlers.ts`、`preload/index.ts`（IPC）
- `apps/electron/src/main/lib/project-sync-service.ts`（TodoProvider 对齐）
- `apps/electron/src/renderer/components/projects/ProjectView.tsx`（ContactPicker 增强）
- 凭证：`getFeishuCredential`/`getDingtalkCredential`（复用 bot 配置）
