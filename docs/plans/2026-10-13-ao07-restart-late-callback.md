# AO-07 Restart-and-Late-Callback Test Plan

**Goal:** Verify that an isolated Owner execution left `running` is recovered by a fresh process as stale/unknown, and an injected late completion callback cannot overwrite that recovery or enqueue a Reviewer.

**Architecture:** Extend the existing isolated Stage B BDD test. The parent test process creates and dispatches a fake Owner command, then closes the SQLite store. A child Bun process opens the same temporary config and invokes the same recovery service used by application startup. After the child exits, the parent reopens the store and delivers the captured fake callback to the normal Agent Employee callback path. No product runtime changes are expected unless the test demonstrates a defect.

**Tech Stack:** Bun test, project SQLite store with isolated `PROMA_TEST_CONFIG_DIR`, child process via `node:child_process`, fake headless runner; no real Provider or credentials.

---

### Task 1: Add failing process-boundary BDD scenario

**Files:**
- Modify: `apps/electron/src/main/lib/project-owner-execution-stage-b.test.ts`

**Steps:**
1. Add a BDD case that prepares and queues one manual Executor command, dispatches it with a fake headless runner held behind a Promise, and captures the callback.
2. Write a temporary child `.test.ts` under the isolated config directory, register the project’s complete Electron mock, and synchronously launch a fresh Bun test-runner process with the same temporary config directory. In the child, initialize the store, run `recoverInterruptedOwnerRuntimeExecutions` for the captured execution ID, assert the recovered ledger, close the store, and emit structured state.
3. Assert the child recorded `unknown_recorded`; reopen the parent store; inject the held fake completion callback; assert execution remains stale, command remains `needs_reconcile` with null actual cost, grant remains paused, no technical review exists, and command count is unchanged.
4. Ensure the fake runtime is released and all handles/config are cleaned in `finally`/existing `afterAll`.

### Task 2: Run the single failing test

Run: `bun test apps/electron/src/main/lib/project-owner-execution-stage-b.test.ts`

Expected: the new case passes if restart recovery and stale callback guards work; if it fails, inspect the exact state transition before changing product code.

### Task 3: Implement only if the test proves a product defect

- Keep any correction limited to Owner callback generation/state fencing and preserve the `unknown` reservation.
- Do not add automatic retries, release unknown usage, or change grant/permission scope.
- Do not change user data, real app installation, external credentials, or egress configuration.

### Task 4: Verify and record

Run:
- `bun test apps/electron/src/main/lib/project-owner-execution-stage-b.test.ts`
- `bun test apps/electron/src/main/lib/project-owner-technical-review.test.ts`
- `bunx biome check apps/electron/src/main/lib/project-owner-execution-stage-b.test.ts`
- `git diff --check`

Update the AO-07 validation checkpoint, ledger, and exception coverage audit with precise evidence and limits. Keep the worktree uncommitted. A child Bun recovery test is process-boundary storage/service evidence, not a full Electron GUI restart, hard-crash, power-loss, or Provider proof.
