# 本地存储合同

配置根目录由 app-identity.ts / getConfigDir() 决定，当前为 ~/.gravitas。PROMA_TEST_CONFIG_DIR 仅用于隔离测试。原有数据路径保持兼容，不在此次修复中迁移或删除用户数据。

| 数据 | 权威性与实现 | 备份/恢复边界 |
|---|---|---|
| 配置、会话消息、Workflow、Approval、Memory | JSON 配置 / JSONL 日志是权威记录 | 应用退出后备份整个配置根；恢复后重新打开，不能只备份索引 |
| 项目、营销 | 已有 sql.js 业务数据库是权威记录 | export 后临时文件写入、文件 fsync、原子 rename、非 Windows 父目录 fsync；失败向调用者抛出，不能仅记录日志并返回成功 |
| Campaign、KOL | 既有 SQLite 业务数据，Electron 使用 node:sqlite；Bun 测试使用 bun:sqlite | WAL 与主文件须一致。先关闭应用再备份整个根目录，不应在运行中仅拷贝单个 sqlite 文件 |
| Context Store | 可重建检索索引，不替代会话 JSONL 或审批后的 Memory | context-store/<workspace-slug>/context-store.db；独立全局索引 __global__；重开回归保证已索引内容可读 |

新配置优先采用文件；已存在的 SQLite 是兼容性约束，不代表授权另建一套权威数据。业务数据库不能当成可随意删除的缓存。Context Store 当前没有用户可操作的一键全量重建流程；发生损坏时保留原件，从权威会话记录重建，不能声称清缓存即恢复所有数据。

原子 rename 防止读到半写文件；替换后的目录 fsync 如果失败也会抛错，但此时目标已替换，不能宣称旧版本仍在；Windows 未做目录 fsync。同步不等于跨平台断电恢复保证。Windows、文件系统异常和断电恢复仍需要专门故障注入验收。不得把本轮临时目录写失败测试描述为已通过真实断电试验。

Memory 保持 candidate → Approval → 用户批准 → Memory，索引写入不会绕过审批。配置审计采用同步追加：低频写入完成后才返回，IO 错误向上传播，避免 fire-and-forget 在退出或测试清理后继续写入。
