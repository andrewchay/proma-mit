# 飞书通讯录负责人搜索 — 深入排查记录（需求3）

> 创建：2026-08-06
> 前提：contact-search-service.ts 已重写为 find_by_department（未提交），用户仍反馈拉不到。
> 现状：未提交代码 + 本记录。尚未定位到最终根因，需一次真实运行诊断。

---

## SDK 官方语义（node_modules/@larksuiteoapi/node-sdk types/index.d.ts）

### 1. `GET /contact/v3/user/find_by_department`（获取部门直属用户列表）
- **只返回指定部门的「直属成员」**（不包含子部门成员）。
- 入参 `params`: `department_id`(必填)、`department_id_type`("department_id"|"open_department_id"，**默认 department_id**)、`page_size`、`page_token`。
- 权限：`contact:user.base:readonly`（应用身份）。
- 关键：根部门 ID 为 `0`；带 `department_id=0` 会「**校验是否有全员权限**」，命中则返回**根部门直属成员**.

### 2. `GET /contact/v3/departments/{id}/children`（获取子部门列表）
- `parent_department_id=0` 回调「**是否为全员权限**」。
- **通讯录范围若为全员权限**，未带 parent_department_id 时**只返回根部门ID（=0）**。
- 返回项 `item.department`: `department_id`(数字) 与 `open_department_id`(od-前缀) 均有。
- 权限：`contact:contact.base:readonly` / `contact:department.base:readonly`。

### 3. `GET /contact/v3/users`（历史废弃接口，不带 department_id）
- 未带 department_id → **只返回「权限范围内的独立用户」（被单独加入可见范围的人），通常为空**。

---

## 最可能的根因（按概率排序，需实测确认）

### R1：部门成员分布在子部门，`department_id=0` 只抓根部门直属
- 部门树枚举成功（deptIds>0）→ 逐部门 find_by_department，
  R1a: ★部门枚举**为空**（范围未覆盖"部门节点"而只覆盖"全部员工/个体"），
    deptIds=[] → fallback `find_by_department?department_id=0`，
    **而 0 只返回根部门直属成员**；ORG 绝大多数成员在子部门 → 拉不到。
- 应对：扩大部门枚举深度/层数、或走真实部门树；去重并集。

### R2：`find_by_department` 的 `department_id` 类型与枚举到的 ID 不匹配
- 枚举拿 `item.department.department_id`（数字）；find_by_department 默认 `department_id_type=department_id`。
- 若企业用 `od-` 的 open_department_id 才有权限/更可靠，则需显式切 `department_id_type=open_department_id`。
- 应对：对每个部门，同时按 `department_id` 与 `open_department_id` 两种类型各拉一次，取并集。

### R3：权限范围本身（必须在飞书后台配）
- `find_by_department` 需 `contact:user.base:readonly`；部门树需 `contact:department.base:readonly`。
- 范围不足时 find_by_department 返回**无部门权限错误码**（非空），部门树返回空。
- 提示：范围至少勾一个**部门节点**（find_by_department 按部门拉人），单勾"全部员工/个体"不满足按部门拉人语义。

---

## 下一步（需要一次真实运行诊断）
当前代码已把 `dept/users/find_by_department` 的**原始响应**写进前端错误信息与 rawProbe。
请用户在项目管理「指定责任人」搜一次，把前端弹窗/错误里的诊断文本发来，即可精确判定是
R1（部门树空 + 根部门0）、R2（ID类型不匹配）、还是 R3（权限/范围）。
据此做最小、可验证的代码修复。
