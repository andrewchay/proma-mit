# 飞书通讯录负责人搜索 — 排障交接（Handover）

> 创建：2026-08-06
> 状态：**代码已按正确接口语义重写（find_by_department 按部门拉人），待运行时验证**
> 相关模块：`apps/electron/src/main/lib/contact-search-service.ts`、`app/renderer/.../projects/ProjectView.tsx`、`.../settings/FeishuSettings.tsx`
> 交接人：Proma Agent（用户 Carolwyp 的 Gravitas 项目）

---

## ★根因更新（2026-08-06 二次定位，决定性）

**真正的根因是「API 接口语义用错」，而非仅「可见范围未授权」。**

依据 `node_modules/@larksuiteoapi/node-sdk/types/index.d.ts`（v1.72.0）官方对
`GET /open-apis/contact/v3/users`（contact resource=user apiName=list）的类型注释：

> 该接口已为历史版本，不再维护推荐。`department_id` 是非必填，填与不填存在两种校验：
> 1、设置 `department_id` → 校验该部门是否有通讯录权限，有则返回该部门直属成员；
> **2、未带 `department_id` → 只返回「权限范围内的独立用户」（被单独加入可见范围的人），通常为空。**

**旧代码裸调 `GET /contact/v3/users`（不带 department_id）**，落入第 2 种语义，
返回 `code:0` + `has_more:false` 无 items。这与可见范围配的是「部门节点/全部员工」不匹配
（那些不是"独立用户"），所以**即使可见范围配好、发布审核通过，依然拉不到人**。

### 正确接口
- 按部门遍历，每部门用 `GET /contact/v3/user/find_by_department?department_id=X`（推荐接口，
  `contact:user.base:readonly` 权限）拉该部门直属用户。
- 部门树从根部门 `0` 枚举：`GET /contact/v3/departments/0/children`（返回 `data.items[]`，每项在 `item.department`）。

### 已完成的代码重写（本次）
`searchFeishuContacts` 从「裸拉 /users」改为：
1. 从根部门 `0` BFS 枚举可见部门树（最多 6 层）；
2. 逐部门 `find_by_department` 分页拉直属用户，去重、按姓名过滤；
3. 部门枚举为空的 fallback：再裸调一次 `/users`（独立用户语义）作兜底；
4. 空结果诊断更细致：部门树为空 → 提示可见范围；有部门但人空 → 提示权限。

---

## 一、问题现象

项目管理中「负责人」选择器，选择责任人时：

1. 早期：报 `飞书通讯录获取失败: 部门0: 接口返回非 JSON (HTTP 404, /contact/v3/departments/0/members)`
2. 修 404 后：报 `飞书通讯录为空：接口已连通但未返回任何用户`（最初版）
3. 之前：报 `飞书通讯录为空：接口已连通，但根部门下子部门为 0。users响应[...] dept响应[...]`
4. **本次根因确认后**：改用 `find_by_department` 按部门拉人（见上方 ★根因更新）

钉钉未配置凭证（`设置 → 钉钉 Todo`），不在本次范围。

---

## 二、已定位的根因（两层）

### 根因 1（代码 bug，已修复）：部门成员接口对 `department_id=0` 返回 404
- 旧实现按部门遍历：`GET /departments/${deptId}/members`，当 deptId=0（根部门）时飞书返回 404 page not found。
- 已改为 `GET /contact/v3/users?page_size=50` 直接分页拉全量用户（不依赖部门）。

### 根因 2（飞书后台配置，未解决）：通讯录数据权限范围未授权
- 飞书接口：`GET /contact/v3/users` 与 `GET /departments/0/children` 均返回
  `{"code":0,"data":{"has_more":false},"msg":"success"}` —— **data 里连 `items` 字段都没有**。
- `code=0` + 无 items + 无错误码，且用户系统里「可用范围=所有员工」、`contact:user.base:readonly`（应用身份）已开通、版本已发布审核。
- **结论**：飞书应用的「**通讯录数据权限范围 / 可见范围**」未勾选任何组织架构节点，导致所有通讯录读取接口返回空。
- 这是**飞书开放平台侧**的二次授权，代码已尽力，必须用户到飞书后台配置。

---

## 三、已完成的代码改动（commits）

| commit | 内容 |
|--------|------|
| `aa80822` | 部门成员接口不再请求 dept_id=0；修复 ChannelSettings JSX |
| `aa54d23` | 改用 `GET /contact/v3/users` 分页拉取全量用户（取代按部门遍历） |
| `1f5ddb7` | 空结果时给出诊断提示 + 分页日志 |
| `6a30cc2` | 探针区分"可见范围" vs "权限"问题 |
| `7c372f5` | 打印飞书接口原始响应 JSON |
| `（最新）` | 把 users/dept 原始响应并入前端错误显示，无需找日志 |
| 待续 | 修正 `/departments/children` 字段解析（data.items 而非 data.children）——**注意此改动已提交** |

另外：
- `af3e5e3`：补全 FeishuSettings 批量权限清单（含 `contact:user.base:readonly`、`task:task` 等通用权限）
- `2e51d12`：移除无效的 `contact:user.search:readonly`（代码实际只用 `GET /users`）

---

## 四、飞书必要权限清单（应用身份，全部已加入批量配置）

在 `app/renderer/.../settings/FeishuSettings.tsx` 的 `FEISHU_SCOPES_JSON`（tenant 数组）：
```
contact:contact.base:readonly
contact:user.base:readonly
contact:department.base:readonly
task:task
im:chat:readonly
im:chat.members:read
im:message
im:message.group_at_msg:readonly
im:message.group_msg
im:message.p2p_msg:readonly
im:message:send_as_bot
im:resource
```
> 重点：`contact:user.base:readonly` 是负责人搜索核心。`contact:user.search:readonly` **不存在且无需**。

---

## 五、用户仍需在飞书开放平台做的（阻塞项，代码侧无法代劳）

**必须**把「通讯录数据权限范围 / 通讯录可见范围」授权到组织架构节点（至少根部门/自己的部门）。入口（不同后台版本）：
- 应用详情 → 「通讯录设置」/「数据权限」/「权限与数据范围」/「应用可用性」
- 或权限管理 → 某通讯录权限项右侧 → 「设置范围/数据范围」

操作：勾选组织架构树中的部门节点 → 保存 → 版本管理与发布 → 创建新版本 → 提交 → 企业管理员审核通过。

### 验证方式（可选）
- 飞书在线调试：`https://open.feishu.cn/document/server-docs/contact-v3/user/list` → API调试 → 用应用 AppID/AppSecret 请求 `GET /contact/v3/users`，看 items 是否非空。
- 或在 Gravitas 项目管理搜索一次，看界面 `dept响应[...]` 是否出现部门名。

---

## 六、后续待办（代码侧，若可见范围配好后仍空）

1. **怀疑点**：`department_id=0` 可能不是用户租户的真实根部门 ID。
   - 若配好可见范围后 `/contact/v3/users?department_id=X` 需真实 ID，则改为：先枚举部门树拿真实部门 ID（`GET /departments/0/children` 的 `data.items[].department.department_id` 已改为正确字段），再查各部门用户。
2. 排查 `GET /users` 不带 department_id 是否对该租户返回全量（当前返回空仅因无可见范围）。
3. 钉钉通讯录（`设置 → 钉钉 Todo` 凭证）未配置，属另一条线，如需让钉钉负责人搜索可用，需补钉钉凭证。

---

## 七、其他未提交/在途内容

- 工作区有 **3 个未提交 Workflow 改动**（`renderer/atoms/workflow-atoms.ts`、`renderer/components/app-shell/LeftSidebar.tsx`、`renderer/components/workflow/WorkflowView.tsx`），疑似用户在做的重构，**未被本次改动涉及**，需用户确认保留/提交。
- 打包产物：`apps/electron/out/Gravitas-0.11.17-arm64.dmg`（含飞书通讯录诊断）。

---

## 八、一句话总结

**代码已把飞书通讯录搜索改为 `GET /contact/v3/users` 全量拉取并做强诊断；剩余唯一硬阻塞是用户需到飞书开放平台给应用授权「通讯录数据权限范围」（勾选组织架构节点）并重新发布审核。配好后若仍空，下一步代码侧改为枚举真实根部门 ID。**
