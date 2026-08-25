# Phase 1: 存储层强化 —— 借鉴 mycontext 改造 context-store

## 目标
将 Proma 的 `packages/context-store` 从当前 sql.js 内存库升级为借鉴 mycontext 设计的生产级本地存储层。

## 借鉴点（按优先级）

### P1.1 迁移校验升级（最高优先级）
- **现状**: 基础 checksum，注释/缩进变更会导致迁移失败
- **目标**: 三级判据 (current/legacy/mismatch) + 注释安全剥离
- **参考**: `migration-checksum.ts` 的词法扫描状态机
- **文件**: `src/migration-checksum.ts`（改造）, `src/migrations.ts`（加 legacyChecksums 支持）

### P1.2 显式事务包装
- **现状**: 无事务封装，各调用点靠自觉
- **目标**: `withTransaction<T>(db, fn)` 统一原子性写入
- **参考**: `tx.ts`
- **文件**: 新建 `src/tx.ts`

### P1.3 存储引擎升级评估
- **现状**: sql.js（内存/导出式持久化）
- **选项 A**: 保持 sql.js，完善 WAL 语义模拟
- **选项 B**: 迁移到 better-sqlite3（WAL/并发/性能）
- **决策待确认**: better-sqlite3 有 native 模块，Electron 打包需处理 ABI

### P1.4 Repository 模式
- **现状**: 直接在 store.ts 里写 SQL
- **目标**: 按领域拆分 Repository（EntityRepository, FactRepository, EdgeRepository）
- **参考**: `repositories/*.ts`
- **文件**: 新建 `src/repositories/`

## 实施顺序
1. P1.1 迁移校验（无依赖，安全）
2. P1.2 事务包装（依赖 P1.1 的 db 类型）
3. P1.4 Repository 拆分（依赖 P1.2 的事务）
4. P1.3 存储引擎（最后做，影响最大）

## 关键约束
- 不破坏现有 API（`openContextStore`, `upsertEntity`, `recall` 等）
- 测试必须全部通过
- typecheck 必须 exit 0
