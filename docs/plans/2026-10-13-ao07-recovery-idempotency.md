# AO-07 Recovery Idempotency Test Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prove repeated startup recovery and duplicate late callbacks cannot mutate a recovered unknown Owner execution or enqueue work.

**Architecture:** Extend the existing isolated Stage B process-boundary BDD. In the child process, invoke startup recovery twice and assert the second pass is a no-op. In the parent process, release the held fake headless callback twice after recovery and assert stale/unknown state, reservation, paused grant, review evidence and command count remain unchanged. No production code should change unless a reproducible state-machine defect appears.

**Tech Stack:** Bun test runner, temporary `PROMA_TEST_CONFIG_DIR`, isolated SQLite, fake headless runner, existing Electron mock.

---

### Task 1: Add idempotency assertions

**File:** `apps/electron/src/main/lib/project-owner-execution-stage-b.test.ts`

1. In the temporary child test, invoke `recoverInterruptedOwnerRuntimeExecutions` a second time for the same execution and assert it returns no recovered executions; re-read command/grant/execution and emit both recovery results.
2. In the held fake runner, invoke the exact same `onComplete` callback twice after the parent reopens SQLite.
3. Assert the execution remains stale with no result summary, command remains `needs_reconcile` with null actual cost and unchanged reservation, grant remains paused, review evidence remains empty, and command count stays one.
4. Keep cleanup/finally behavior intact; don't edit existing user data or the older unknown Provider ledger.

### Task 2: Verify

Run the focused test, full Stage B file, technical review parser test, Biome for the changed test, workspace typecheck, docs check, and `git diff --check`.

Observed: the focused test and full suites pass; the second recovery returns no candidate, and repeated late completion callbacks leave the execution stale. No production runtime diff was needed.

### Task 3: Record evidence

Append the new boundaries and exact verification counts to the AO-07 exception audit, validation checkpoint, and ledger. State explicitly that this is a two-Bun-process SQLite/service contract test, not a complete Electron crash, native WAL, power-loss, or live Provider proof. Leave the worktree uncommitted.

**Result:** Stage B 50/50 (281 assertions); technical review parser 4/4 (8 assertions); workspace typecheck, changed-file Biome, docs check, and diff check passed. No product runtime code changed; no real Provider request or ledger mutation occurred.
