---
name: electron-bun-test-baseline
description: |
  Gravitas/Electron monorepo 跑 bun test 回归时的既有失败甄别与根因排查。
  Use when: (1) bun test 出现 "SyntaxError: Export named 'BrowserWindow'/'WebContentsView'/'safeStorage'
  not found in module '.../node_modules/electron/index.js'"，(2) 改动后测试回归出现 fail，
  需要判断是新增失败还是既有失败，(3) 测试因依赖链上某模块顶层 import electron 而整文件炸掉。
  覆盖：electron 原生导出在 bun 测试环境不可用的根因、git stash/worktree 基线对比法、
  依赖链二分定位法（bun -e import）。
author: Claude Code
version: 1.0.0
date: 2026-09-10
---

# Electron + bun test 既有失败基线甄别

## Problem

在这个 Electron monorepo 里跑 `bun test src/main/lib/` 全量回归时，总有一批固定失败
（当前约 49 fail / 31 errors）。它们的报错形态是：

```
SyntaxError: Export named 'BrowserWindow' not found in module
'.../node_modules/electron/index.js'
```

不甄别就直接当新失败修，会浪费大量时间——这些是**环境性既有失败**，与任何新改动无关。

## Context / Trigger Conditions

- `bun test` 某个测试文件报 `Export named 'X' not found in .../node_modules/electron/index.js`
  （X 常见为 `BrowserWindow`、`WebContentsView`、`safeStorage`、`dialog`）
- 跑全量回归得到几十个 fail，需要判断哪些是本次改动引入的
- 某测试文件 0 pass + 1 error，报错在「文件级 import」而不是断言处

## Root Cause

bun test 直接在 Node/bun 运行时里加载模块。`node_modules/electron/index.js` 在无
Electron 二进制的环境下只是一个占位模块，不含 `BrowserWindow` 等导出。任何被测模块
**顶层** `import { BrowserWindow } from 'electron'`（如 `attachment-service.ts:16`），
都会让依赖它的整条链（context-compaction → session-manager → adapter 测试）在 import
阶段炸掉，表现为测试文件级 error 而非断言失败。

## Solution

### 1. 基线对比法（判断既有 vs 新增）

```bash
# 改动未提交时：stash 后跑同一套测试对比
git stash && bun test src/main/lib/ src/renderer/lib/ 2>&1 | tail -3 && git stash pop

# 改动已提交时：worktree 挂改动前 commit 跑基线
git worktree add /tmp/gravitas-baseline <baseline-commit>
cd /tmp/gravitas-baseline && bun install --silent
cd apps/electron && bun test src/main/lib/ src/renderer/lib/ 2>&1 | tail -3
git worktree remove --force /tmp/gravitas-baseline
```

fail 数量与清单一致 → 全部既有失败；数量差 = 本次新增测试（应全部通过）。

### 2. 依赖链二分定位（找炸链的具体模块）

测试报 electron 导出错误时，从测试文件开始逐个 `bun -e "import('...').then(...)"`：

```bash
bun -e "import('./src/main/lib/xxx.ts').then(()=>console.log('OK')).catch(e=>console.log('FAIL:', e.message.slice(0,90)))"
```

对半分依赖逐个试，第一个 FAIL 的模块就是顶层 import electron 的源头。
典型已知源头：`attachment-service.ts`（`BrowserWindow`）、computer-use 插件（`WebContentsView`）、
`channel-manager.ts`（`safeStorage`）。

### 3. 已知非环境性既有失败

`pi-model-registry.ts` 的 `inferPiContextWindow` / `resolvePiProviderId` 导出缺失
（测试 import 了已不存在的导出）——同样是既有失败，与改动无关，但根因不同（代码演进遗留）。

## Verification

- 基线对比：改动前后 fail 数量一致（本次案例：前后均 49 fail / 31 errors，
  726 - 716 = 10 个新增测试全过）
- 修复方向确认：若要真正修环境性失败，方案是被测模块把 electron 导入改为惰性
  （函数内 `require`）或测试里 mock electron——目前项目未做，属已知债务。

## Notes

- 不要试图通过「修 electron 导入」让全量回归变绿来交付功能——那是独立的技术债，
  应单独立项（惰性导入改造影响面大：attachment-service 被 session-manager 链引用）。
- `git stash` 不会 stash untracked 文件，需要时加 `-u`。
- 跑单文件时用 `bun test ./path/to/x.test.ts`（带 `./`），否则 bun 把参数当文件名模式匹配报
  "filters did not match any test files"。

## References

- 本次验证案例：commit 8e49d0e9..06020572（desktop span sink），基线 90777691，
  两点均为 49 fail / 31 errors。
