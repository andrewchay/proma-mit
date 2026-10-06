---
name: sqljs-statement-closed
description: |
  修复 bun test 环境下 project-sqlite-store 抛 "error: Statement closed" 的问题。
  Use when: (1) bun test 中 store 层写操作报 "Statement closed" 而生产环境正常，
  (2) 循环外 prepare 一次、循环内多次 run 的写法，(3) sql.js 与 better-sqlite3
  双驱动兼容层的行为差异排查。根因：SqlJsStmt 每次 run() 后立即 free 语句。
author: Claude Code
version: 1.0.0
date: 2026-09-11
---

# sql.js "Statement closed" 陷阱（双驱动兼容层）

## Problem

`project-sqlite-store.ts` 使用双驱动兼容层：生产（Electron）走 better-sqlite3，
bun test 走 sql.js。sql.js 分支的 `SqlJsStmt.run()` 在 `finally` 中立即 `free()` 语句。
因此「循环外 prepare 一次、循环内多次 run」的代码在第二次 run 时抛 `Statement closed`，
且只在测试环境暴露（生产分支无此问题），容易误判为业务 bug。

## Context / Trigger Conditions

- `bun test` 下 store 层写操作报 `error: Statement closed`
- 同一逻辑在 Electron 生产环境运行正常
- 代码形态：`const stmt = db.prepare(sql)` 在循环外，`stmt.run(...)` 在循环内
- 已知踩坑位置：`seedTaskStatusesForProject`、`renumberTaskStatusesByIds`

## Solution

循环写入必须**循环体内逐次 prepare**：

```typescript
// ❌ 错误：第二次 run 抛 Statement closed（仅 bun test）
const insert = database.prepare(`INSERT OR IGNORE INTO ...`)
for (const item of items) insert.run(item)

// ✅ 正确：循环体内逐次 prepare
for (const item of items) {
  database.prepare(`INSERT OR IGNORE INTO ...`).run(item)
}
```

## Verification

修改后跑对应测试文件：`bun test apps/electron/src/main/lib/<相关>.test.ts`，
确认无 `Statement closed` 且断言通过。

## Notes

- 事务内的语句同样受此约束（SqlJsCompat.transaction 包裹下 run 仍会 free）
- 该约束与全仓其他循环写入代码的既有惯用法一致，新代码照抄即可
- better-sqlite3 分支的语句可复用，无需刻意优化为「外提 prepare」——两种驱动
  都按逐次 prepare 写是唯一两端安全的形式
