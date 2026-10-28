# 企业工作区成员存储首片

成员表以现有 Postgres 工作区的 `(tenant_id, user_id, workspace_slug)` 作为外键；成员身份包含租户、工作区所有者、工作区名与成员用户 ID。所有者由已有工作区的 `user_id` 确定；目前仅登记 editor/viewer，不能通过成员记录转移所有权。删除工作区时其成员记录由数据库级联删除。

独立 Postgres 测试覆盖跨连接实例持久化、同名工作区的租户和所有者隔离、非所有者不能替其他所有者写入、成员撤销和非法角色。`/agent/workspaces/{slug}/members` 提供所有者自己的成员登记读取及逐个设置/移除；写入需要现有 operator/admin 角色，Cookie 会话还需同源请求。API 明确返回 `sharedAccessEnabled: false`；用户 ID 仅作为登记，不发送邀请或验证外部账号。

此接口依赖现有已认证 scope，尚未连接邀请流程或 Runtime 权限判断，**登记成员尚不会授予共享工作区访问权**。现有按用户隔离的工作区、会话、凭证和对象存储未迁移；已有工作区需要预先存在。
